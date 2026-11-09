import assert from "node:assert/strict";
import test from "node:test";
import { createMeteredModelFetch, type ModelRequestMetric } from "../index.js";

test("captures reported usage without persisting credentials, prompts or output", async () => {
  const records: ModelRequestMetric[] = [];
  const metered = createMeteredModelFetch({ provider: "router", record: (metric) => records.push(metric),
    fetch: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "synthetic-private-response" } }],
      usage: { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 10 } } })),
  });
  const response = await metered("https://example.invalid/v1/chat/completions", { headers: { authorization: "Bearer synthetic-secret" },
    body: JSON.stringify({ model: "synthetic-model", messages: [{ role: "user", content: "synthetic-private-prompt" }] }) });
  assert.equal((await response.json()).choices[0].message.content, "synthetic-private-response");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.input_tokens, 100);
  assert.equal(records[0]!.output_tokens, 25);
  assert.equal(records[0]!.cached_input_tokens, 80);
  assert.equal(records[0]!.reasoning_tokens, 10);
  assert.equal(records[0]!.cost, null);
  assert.doesNotMatch(JSON.stringify(records), /synthetic-private|synthetic-secret|authorization/);
});

test("absent or invalid usage stays unknown, and repair calls are counted separately", async () => {
  const records: ModelRequestMetric[] = [];
  const metered = createMeteredModelFetch({ provider: "router", record: (metric) => records.push(metric),
    fetch: async () => new Response(JSON.stringify({ usage: { prompt_tokens: -1, completion_tokens: "20" } })),
  });
  await metered("https://example.invalid", { body: JSON.stringify({ model: "synthetic", messages: [{}, {}, {}, {}] }) });
  assert.equal(records[0]!.phase, "repair");
  assert.equal(records[0]!.input_tokens, null);
  assert.equal(records[0]!.output_tokens, null);
  assert.equal(records[0]!.cached_input_tokens, null);
});

test("records timeout once without swallowing the original error", async () => {
  const records: ModelRequestMetric[] = [];
  const error = new DOMException("synthetic-private-error", "AbortError");
  const metered = createMeteredModelFetch({ provider: "router", record: (metric) => records.push(metric), fetch: async () => { throw error; } });
  await assert.rejects(metered("https://example.invalid"), (actual) => actual === error);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.failure, "timeout");
  assert.equal(records[0]!.input_tokens, null);
  assert.doesNotMatch(JSON.stringify(records), /synthetic-private-error/);
});
