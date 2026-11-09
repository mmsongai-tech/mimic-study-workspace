import assert from "node:assert/strict";
import test from "node:test";
import { FallbackStructuredProvider, StructuredProviderError, type StructuredResearchDesignProvider } from "../index.js";

const input = (allow = false, question = "q") => ({
  system_prompt: "p",
  model_input: { request: { message: question, client_request_id: crypto.randomUUID(), allow_openai_fallback: allow } },
  profile: "router-model",
  timeout_ms: 1000,
} as never);

test("requires authorization after the primary pool fails and consumes it once", async () => {
  const calls: string[] = [];
  const attempts: Array<{ provider: string; model: string; outcome: string }> = [];
  const primary: StructuredResearchDesignProvider = {
    generateProposal: async () => {
      calls.push("router");
      throw new StructuredProviderError("offline", true);
    },
  };
  const fallback: StructuredResearchDesignProvider = {
    generateProposal: async ({ profile }) => {
      calls.push(profile);
      return { ok: true };
    },
  };
  const provider = new FallbackStructuredProvider(
    primary,
    { provider: fallback, model: "gpt-4o-mini" },
    undefined,
    (attempt) => attempts.push(attempt),
  );

  await assert.rejects(
    provider.generateProposal(input()),
    (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_FALLBACK_AUTHORIZATION_REQUIRED",
  );
  assert.deepEqual(await provider.generateProposal(input(true)), { ok: true });
  await assert.rejects(
    provider.generateProposal(input(true)),
    (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_FALLBACK_AUTHORIZATION_REQUIRED",
  );

  assert.deepEqual(calls, ["router", "gpt-4o-mini", "router"]);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.provider, "openai");
  assert.equal(attempts[0]?.model, "gpt-4o-mini");
});

test("does not accept authorization for a different research input", async () => {
  let fallbackCalls = 0;
  const primary: StructuredResearchDesignProvider = { generateProposal: async () => { throw new StructuredProviderError("offline", true); } };
  const fallback: StructuredResearchDesignProvider = { generateProposal: async () => { fallbackCalls += 1; return {}; } };
  const provider = new FallbackStructuredProvider(primary, { provider: fallback, model: "gpt-4o-mini" });

  await assert.rejects(provider.generateProposal(input(false, "first")));
  await assert.rejects(provider.generateProposal(input(true, "second")));
  assert.equal(fallbackCalls, 0);
});

test("does not send a rejected shared credential to another provider", async () => {
  let called = false;
  const primary: StructuredResearchDesignProvider = { generateProposal: async () => { throw new StructuredProviderError("auth", false, "PROVIDER_AUTHENTICATION_FAILED"); } };
  const fallback: StructuredResearchDesignProvider = { generateProposal: async () => { called = true; return {}; } };

  await assert.rejects(
    new FallbackStructuredProvider(primary, { provider: fallback, model: "gpt-4o-mini" }).generateProposal(input()),
    /auth/u,
  );
  assert.equal(called, false);
});
