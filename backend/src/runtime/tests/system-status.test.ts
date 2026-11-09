import assert from "node:assert/strict";
import test from "node:test";
import { createUnavailableStructuredProvider, StatusTrackingStructuredProvider, SystemStatusService, StructuredProviderError } from "../index.js";

test("reports degraded capabilities without making the workspace unavailable", () => {
  const status = new SystemStatusService([
    { id: "workspace", label: "Workspace", state: "ready", summary: "Loaded" },
    { id: "research_design_model", label: "Model", state: "degraded", summary: "Not configured" },
  ], () => new Date("2026-09-01T00:00:00.000Z"));
  assert.equal(status.report().status, "degraded");
  assert.equal(status.report().capabilities[0]?.state, "ready");
});

test("records the safe Router failure stage without exposing credentials", async () => {
  const status = new SystemStatusService([]);
  const provider = new StatusTrackingStructuredProvider(createUnavailableStructuredProvider(), status);
  await assert.rejects(provider.generateProposal({ system_prompt: "prompt", model_input: {} as never, profile: "free", timeout_ms: 1 }), StructuredProviderError);
  const model = status.report().capabilities[0];
  assert.equal(model?.failure_stage, "configuration");
  assert.match(model?.reason ?? "", /Router Key/u);
  assert.doesNotMatch(JSON.stringify(model), /Bearer|api_key/u);
});

test("does not label a post-preflight model failure as a network outage", async () => {
  const status = new SystemStatusService([]);
  const provider = new StatusTrackingStructuredProvider({
    async generateProposal() { throw new StructuredProviderError("model unavailable", true, "PROVIDER_UNAVAILABLE", "router"); },
  }, status);
  await assert.rejects(provider.generateProposal({ system_prompt: "prompt", model_input: {} as never, profile: "ora/test", timeout_ms: 1 }), StructuredProviderError);
  const model = status.report().capabilities[0];
  assert.equal(model?.failure_stage, "provider");
  assert.equal(model?.summary, "Router 模型暂不可用");
});

test("forwards model attempt handlers through status tracking", async () => {
  let observedModel = "";
  let providerHandler: ((attempt: { provider: string; model: string; order: number; latency_ms: number; outcome: "failed" | "succeeded" }) => void) | undefined;
  const status = new SystemStatusService([]);
  const provider = new StatusTrackingStructuredProvider({
    setAttemptHandler(handler) { providerHandler = handler; },
    async generateProposal() {
      providerHandler?.({ provider: "router", model: "model-a", order: 1, latency_ms: 10, outcome: "succeeded" });
      return { ok: true };
    },
  }, status);
  provider.setAttemptHandler((attempt) => { observedModel = attempt.model; });

  await provider.generateProposal({ system_prompt: "prompt", model_input: {} as never, profile: "model-a", timeout_ms: 1_000 });
  assert.equal(observedModel, "model-a");
});

test("labels a local-provider failure as local, not Router", async () => {
  const status = new SystemStatusService([]);
  const provider = new StatusTrackingStructuredProvider({
    async generateProposal() { throw new StructuredProviderError("local model returned invalid output", false, "PROVIDER_RESPONSE_INVALID", "local"); },
  }, status);
  await assert.rejects(provider.generateProposal({ system_prompt: "prompt", model_input: {} as never, profile: "llama3.1:8b-instruct-q4_K_M", timeout_ms: 1 }), StructuredProviderError);
  const model = status.report().capabilities[0];
  assert.equal(model?.summary, "本地模型 响应无效");
  assert.doesNotMatch(model?.summary ?? "", /Router/u);
});

test("labels a local-provider success as local, not Router", async () => {
  let providerHandler: ((attempt: { provider: string; model: string; order: number; latency_ms: number; outcome: "failed" | "succeeded" }) => void) | undefined;
  const status = new SystemStatusService([]);
  const provider = new StatusTrackingStructuredProvider({
    setAttemptHandler(handler) { providerHandler = handler; },
    async generateProposal() {
      providerHandler?.({ provider: "local", model: "llama3.1:8b-instruct-q4_K_M", order: 1, latency_ms: 10, outcome: "succeeded" });
      return { ok: true };
    },
  }, status);

  await provider.generateProposal({ system_prompt: "prompt", model_input: {} as never, profile: "llama3.1:8b-instruct-q4_K_M", timeout_ms: 1_000 });
  const model = status.report().capabilities[0];
  assert.equal(model?.summary, "本地模型 请求成功");
  assert.doesNotMatch(model?.summary ?? "", /Router/u);
});
