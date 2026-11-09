import assert from "node:assert/strict";
import test from "node:test";
import {
  createRetryingResearchDesignModel,
  StructuredProviderError,
} from "../index.js";
import { baseProposal, startRequest } from "../../research-design/tests/model-fixtures.js";

const settings = {
  profile: "synthetic-provider",
  timeout_ms: 2_000,
  retry_max_attempts: 3,
  retry_backoff_ms: 10,
  prompt: {
    id: "research-design",
    version: "0.1.0",
    status: "testing" as const,
    body: "Synthetic system prompt",
  },
};

test("retries transient provider failures with bounded backoff", async () => {
  let calls = 0;
  const waits: number[] = [];
  const model = createRetryingResearchDesignModel({
    async generateProposal(input) {
      calls += 1;
      assert.equal(input.system_prompt, settings.prompt.body);
      assert.equal(input.profile, settings.profile);
      assert.equal(input.timeout_ms, settings.timeout_ms);
      if (calls < 3) throw new StructuredProviderError("temporary", true);
      return baseProposal();
    },
  }, settings, {
    max_attempts: settings.retry_max_attempts,
    backoff_ms: settings.retry_backoff_ms,
    async sleep(milliseconds) { waits.push(milliseconds); },
  });

  const proposal = await model.propose({
    request: startRequest,
    current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
  });

  assert.deepEqual(proposal, baseProposal());
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
});

test("does not retry non-transient provider failures", async () => {
  let calls = 0;
  const model = createRetryingResearchDesignModel({
    async generateProposal() {
      calls += 1;
      throw new StructuredProviderError("invalid credentials", false);
    },
  }, settings, { max_attempts: 3, backoff_ms: 10, async sleep() {} });

  await assert.rejects(() => model.propose({
    request: startRequest,
    current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
  }));
  assert.equal(calls, 1);
});

test("does not carry provider attempts into a later research request", async () => {
  let handler: ((attempt: { provider: string; model: string; order: number; latency_ms: number; outcome: "failed" }) => void) | undefined;
  const model = createRetryingResearchDesignModel({
    setAttemptHandler(value) { handler = value as typeof handler; },
    async generateProposal() {
      handler?.({ provider: "router", model: "model-a", order: 1, latency_ms: 10, outcome: "failed" });
      throw new StructuredProviderError("invalid", false, "PROVIDER_RESPONSE_INVALID");
    },
  }, settings, { max_attempts: 1, backoff_ms: 10, async sleep() {} });
  const request = () => model.propose({ request: startRequest, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } });

  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(request, (error: unknown) =>
      Boolean(error && typeof error === "object" && "attempts" in error && (error as { attempts: unknown[] }).attempts.length === 1));
  }
});
