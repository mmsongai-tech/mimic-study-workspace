import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleStructuredProvider, ModelPoolStructuredProvider, StructuredProviderError } from "../index.js";

const syntheticInput = {
  profile: "test-model", system_prompt: "Synthetic contract test", timeout_ms: 5000,
  model_input: {
    request: { message: "Synthetic question", client_request_id: "safe-response-diagnostics" },
    current_spec: { schema_version: "1.0.0", intent_family: "undetermined", research_question: "Synthetic question" },
  },
} as const;

test("malformed response gets one bounded repair and only safe shape diagnostics", async () => {
  let requests = 0;
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://example.invalid/v1", max_output_tokens: 100,
    fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "SYNTHETIC_PRIVATE_MARKER" } }] }));
    },
  });
  await assert.rejects(provider.generateProposal(syntheticInput), (error: unknown) => {
    assert.ok(error instanceof StructuredProviderError);
    assert.match(error.safeResponseDetail ?? "", /^malformed_json:finish=stop:chars=24:shape=text:syntax=unexpected_token:offset=unknown:repair=malformed_unexpected_token:offset=unknown$/u);
    assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_PRIVATE_MARKER/u);
    return true;
  });
  assert.equal(requests, 2);
});

test("multiple text blocks form one response rather than dropping its tail", async () => {
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://example.invalid/v1", max_output_tokens: 100,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: [
      { type: "text", text: '{"unexpected":' }, { type: "text", text: '"SYNTHETIC"}' },
    ] } }] })),
  });
  await assert.rejects(provider.generateProposal(syntheticInput), (error: unknown) =>
    error instanceof StructuredProviderError && error.safeResponseDetail === "schema_validation:root:repair=schema_root");
});

test("one JSON fence with surrounding prose reaches schema validation", async () => {
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://example.invalid/v1", max_output_tokens: 100,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: {
      content: 'Synthetic introduction.\n```json\n{"unexpected":"SYNTHETIC"}\n```\nSynthetic ending.',
    } }] })),
  });
  await assert.rejects(provider.generateProposal(syntheticInput), (error: unknown) =>
    error instanceof StructuredProviderError && error.safeResponseDetail === "schema_validation:root:repair=schema_root");
});

test("multiple JSON fences remain ambiguous and are not silently selected", async () => {
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://example.invalid/v1", max_output_tokens: 100,
    fetch: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
      content: '```json\n{}\n```\n```json\n{}\n```',
    } }] })),
  });
  await assert.rejects(provider.generateProposal(syntheticInput), (error: unknown) =>
    error instanceof StructuredProviderError && Boolean(error.safeResponseDetail?.startsWith("malformed_json:")));
});

test("schema failures retain only contract field categories in model attempts", async () => {
  // Synthetic adversarial output tests audit privacy, not a clinical model result.
  const marker = "SYNTHETIC_PRIVATE_VALUE_MUST_NOT_BE_AUDITED";
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://example.invalid/v1", max_output_tokens: 100,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ unexpected: marker }) } }] }), { status: 200 }),
  });
  let attempts: unknown;
  const pool = new ModelPoolStructuredProvider(provider, ["test-model"], (value) => { attempts = value; });
  await assert.rejects(pool.generateProposal({
    profile: "test-model", system_prompt: "Synthetic contract test", timeout_ms: 5000,
    model_input: {
      request: { message: "Synthetic question", client_request_id: "safe-diagnostics" },
      current_spec: { schema_version: "1.0.0", intent_family: "undetermined", research_question: "Synthetic question" },
    },
  }), (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_RESPONSE_INVALID");
  assert.match(JSON.stringify(attempts), /PROVIDER_RESPONSE_INVALID:schema_validation:root/u);
  assert.doesNotMatch(JSON.stringify(attempts), new RegExp(marker));
});
