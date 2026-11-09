import assert from "node:assert/strict";
import test from "node:test";
import { SequentialStructuredProvider } from "./router-server.js";
import { StructuredProviderError, type StructuredResearchDesignProvider } from "../runtime/index.js";

const input = {
  system_prompt: "design",
  model_input: { question: "synthetic contract input" },
  profile: "model",
  timeout_ms: 1000,
} as never;

test("keeps the local provider first and does not call Router after local success", async () => {
  const called: string[] = [];
  const local: StructuredResearchDesignProvider = {
    async generateProposal() {
      called.push("local");
      return { provider: "local" };
    },
  };
  const router: StructuredResearchDesignProvider = {
    async generateProposal() {
      called.push("router");
      return { provider: "router" };
    },
  };

  const result = await new SequentialStructuredProvider([local, router]).generateProposal(input);

  assert.deepEqual(result, { provider: "local" });
  assert.deepEqual(called, ["local"]);
});

test("enters the Router provider only after a local provider failure", async () => {
  const called: string[] = [];
  const local: StructuredResearchDesignProvider = {
    async generateProposal() {
      called.push("local");
      throw new StructuredProviderError("local unavailable", true, "PROVIDER_UNAVAILABLE", "local");
    },
  };
  const router: StructuredResearchDesignProvider = {
    async generateProposal() {
      called.push("router");
      return { provider: "router" };
    },
  };

  const result = await new SequentialStructuredProvider([local, router]).generateProposal(input);

  assert.deepEqual(result, { provider: "router" });
  assert.deepEqual(called, ["local", "router"]);
});
