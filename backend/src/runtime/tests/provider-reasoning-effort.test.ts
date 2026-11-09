import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleStructuredProvider } from "../index.js";
import { completeAssociationProposal } from "../../research-design/tests/model-fixtures.js";

// Synthetic proposals exercise transport settings, not clinical or real-data validity.
test("explicit reasoning effort is preserved through a bounded repair without weakening the contract", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new OpenAiCompatibleStructuredProvider({ base_url: "https://example.invalid/v1", max_output_tokens: 8000, reasoning_effort: "low",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const proposal = bodies.length === 1 ? {} : completeAssociationProposal();
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] }));
    } });
  await provider.generateProposal({ profile: "synthetic-model", system_prompt: "Stable instructions", timeout_ms: 1000,
    model_input: { request: { message: "Synthetic question", client_request_id: "synthetic" }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } } });
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.reasoning_effort, "low");
    assert.deepEqual(body.response_format, { type: "json_object" });
    const messages = body.messages as Array<{ content: string }>;
    assert.ok(JSON.parse(messages[1]!.content).output_contract);
  }
});

test("default provider requests do not impose a reasoning setting on other models", async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAiCompatibleStructuredProvider({ base_url: "https://example.invalid/v1", max_output_tokens: 8000,
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(completeAssociationProposal()) } }] }));
    } });
  await provider.generateProposal({ profile: "synthetic-model", system_prompt: "Stable instructions", timeout_ms: 1000,
    model_input: { request: { message: "Synthetic question", client_request_id: "synthetic" }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } } });
  assert.equal(body.reasoning_effort, undefined);
});
