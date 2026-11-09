import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleStructuredChatClient, StructuredChatError } from "../index.js";

const schema = { id: "demo", version: "1.0.0", json: { type: "object", additionalProperties: false, required: ["goal"], properties: { goal: { enum: ["describe", "predict"] } } } };
const prompt = { id: "demo-prompt", version: "1.0.0", body: "classify" };
const reply = (content: string): Response => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

test("returns a valid structured value with a content-free audit record", async () => {
  let body: Record<string, unknown> | undefined;
  const client = new OpenAiCompatibleStructuredChatClient({ provider: "local", base_url: "http://127.0.0.1:11434/v1", model: "m", timeout_ms: 1000,
    fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return reply("```json\n{\"goal\":\"predict\"}\n```"); } });
  const { value, audit } = await client.call<{ goal: string }>({ stage: "demo", prompt, schema, input: { q: "secret question" }, max_output_tokens: 50 });
  assert.equal(value.goal, "predict");
  assert.equal(body?.temperature, 0);
  assert.equal((body?.response_format as { type: string }).type, "json_schema");
  assert.equal(audit.schema_validation, "pass");
  assert.equal(audit.repair_attempts, 0);
  assert.equal(JSON.stringify(audit).includes("secret question"), false);
});

test("repairs once by showing the model its business-rule violations", async () => {
  const replies = ["{\"goal\":\"describe\"}", "{\"goal\":\"predict\"}"];
  const seen: unknown[] = [];
  const client = new OpenAiCompatibleStructuredChatClient({ provider: "local", base_url: "http://x/v1", model: "m", timeout_ms: 1000,
    fetch: async (_url, init) => { seen.push(JSON.parse(String(init?.body)).messages); return reply(replies.shift()!); } });
  const { value, audit } = await client.call<{ goal: string }>({ stage: "demo", prompt, schema, input: {}, max_output_tokens: 50,
    validate_business: (candidate) => candidate.goal === "predict" ? [] : ["goal must be predict for this input"] });
  assert.equal(value.goal, "predict");
  assert.equal(audit.repair_attempts, 1);
  assert.match(JSON.stringify(seen[1]), /goal must be predict/u);
});

test("fails closed with an audit record after the repair budget is spent", async () => {
  const client = new OpenAiCompatibleStructuredChatClient({ provider: "local", base_url: "http://x/v1", model: "m", timeout_ms: 1000,
    fetch: async () => reply("{\"goal\":\"other\"}") });
  await assert.rejects(client.call({ stage: "demo", prompt, schema, input: {}, max_output_tokens: 50 }), (error: unknown) =>
    error instanceof StructuredChatError && error.code === "MODEL_RESPONSE_INVALID" && error.audit.failure_class === "SCHEMA_VALIDATION_FAILED" && error.audit.repair_attempts === 1);
});

test("falls back to json_object mode when the provider rejects json_schema", async () => {
  const modes: string[] = [];
  const client = new OpenAiCompatibleStructuredChatClient({ provider: "local", base_url: "http://x/v1", model: "m", timeout_ms: 1000,
    fetch: async (_url, init) => { const mode = JSON.parse(String(init?.body)).response_format.type; modes.push(mode); return mode === "json_schema" ? new Response("no", { status: 400 }) : reply("{\"goal\":\"describe\"}"); } });
  const { audit } = await client.call({ stage: "demo", prompt, schema, input: {}, max_output_tokens: 50 });
  assert.deepEqual(modes, ["json_schema", "json_object"]);
  assert.equal(audit.structured_output_mode, "json_object");
});
