import assert from "node:assert/strict";
import test from "node:test";
import { PreflightStructuredProvider, RouterAvailabilityProbe, RouterModelAvailabilityProbe } from "../router-availability-probe.js";
import { StructuredProviderError } from "../retrying-research-design-model.js";
import type { StructuredResearchDesignProvider } from "../retrying-research-design-model.js";

const input = { system_prompt: "system", model_input: {} as never, profile: "ora/test", timeout_ms: 1000 } as Parameters<StructuredResearchDesignProvider["generateProposal"]>[0];

test("runs the formal provider only after the Router preflight passes", async () => {
  let formalCalls = 0;
  const provider = new PreflightStructuredProvider(
    { generateProposal: async () => { formalCalls += 1; return { ok: true }; } },
    new RouterAvailabilityProbe({ base_url: "https://router.test/v1", api_key: "secret", fetch: async () => new Response(null, { status: 200 }) }),
  );
  assert.deepEqual(await provider.generateProposal(input), { ok: true });
  assert.equal(formalCalls, 1);
});

test("does not send the formal research request when the Router preflight fails", async () => {
  let formalCalls = 0;
  const provider = new PreflightStructuredProvider(
    { generateProposal: async () => { formalCalls += 1; return { ok: true }; } },
    new RouterAvailabilityProbe({ base_url: "https://router.test/v1", api_key: "secret", fetch: async () => new Response(null, { status: 503 }) }),
  );
  await assert.rejects(provider.generateProposal(input), (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_PREFLIGHT_FAILED");
  assert.equal(formalCalls, 0);
});

test("checks a specific Router model with a tiny content-free completion", async () => {
  let captured: { authorization?: string | undefined; body?: string } = {};
  const probe = new RouterModelAvailabilityProbe({
    base_url: "https://router.test/v1/",
    api_key: "secret",
    fetch: async (_input, init) => {
      captured = {
        authorization: (init?.headers as Record<string, string>).authorization,
        body: String(init?.body),
      };
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    },
  });

  await probe.check("available-model");
  const body = JSON.parse(captured.body ?? "{}") as { model?: string; max_tokens?: number; messages?: Array<{ content?: string }> };
  assert.equal(captured.authorization, "Bearer secret");
  assert.equal(body.model, "available-model");
  assert.equal(body.max_tokens, 8);
  assert.equal(body.messages?.[0]?.content, "Reply with OK.");
  assert.doesNotMatch(captured.body ?? "", /secret|patient|research/u);
});

test("classifies a rejected model probe without exposing the credential", async () => {
  const probe = new RouterModelAvailabilityProbe({
    base_url: "https://router.test/v1",
    api_key: "secret",
    fetch: async () => new Response("missing model", { status: 404 }),
  });

  await assert.rejects(
    probe.check("missing-model"),
    (error: unknown) => error instanceof StructuredProviderError &&
      error.code === "PROVIDER_REQUEST_REJECTED" && !error.message.includes("secret"),
  );
});
