import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryDesignSessionRepository } from "../../research-design/index.js";
import { baseProposal, startRequest } from "../../research-design/tests/model-fixtures.js";
import {
  createConfiguredResearchDesignService,
  createRepositoryProductPromptRegistry,
  resolveBackendRuntimeConfig,
} from "../index.js";
import type { ResearchDesignModelSettings } from "../research-design-runtime.js";

test("composes Research Design from typed config and a registered product prompt", async () => {
  let received: ResearchDesignModelSettings | undefined;
  const attempts: Array<{ provider: string; model: string; order: number; latency_ms: number; outcome: "failed" | "succeeded" }> = [];
  const appended: Array<{ provider: string; model: string; business_validation: string; failure_class?: string }> = [];
  const config = resolveBackendRuntimeConfig({
    environment: {
      research_design: { model: { profile: "synthetic-test", timeout_ms: 1_500 } },
    },
  });
  const service = await createConfiguredResearchDesignService({
    config,
    prompts: createRepositoryProductPromptRegistry(),
    sessions: createInMemoryDesignSessionRepository(),
    modelFactory(settings) {
      received = settings;
      return {
        async propose() {
          settings.onAttempt?.({
            provider: "test-provider",
            model: "failed-probe",
            order: 2,
            latency_ms: 5,
            outcome: "failed",
            failure_class: "PROVIDER_TIMEOUT",
          });
          settings.onAttempt?.({
            provider: "test-provider",
            model: settings.profile,
            order: 1,
            latency_ms: 10,
            outcome: "succeeded",
          });
          attempts.push({
            provider: "test-provider",
            model: settings.profile,
            order: 1,
            latency_ms: 10,
            outcome: "succeeded",
          });
          return baseProposal();
        },
      };
    },
    modelAudit: {
      append(records) {
        appended.push(...records.map((entry) => ({
          provider: (entry as { provider: string }).provider,
          model: (entry as { model: string }).model,
          business_validation: (entry as { business_validation: string }).business_validation,
          ...((entry as { failure_class?: string }).failure_class ? { failure_class: (entry as { failure_class: string }).failure_class } : {}),
        })));
      },
    },
  });

  const view = await service.start(startRequest);

  assert.equal(view.revision, 1);
  assert.equal(received?.profile, "synthetic-test");
  assert.equal(received?.timeout_ms, 1_500);
  assert.equal(received?.retry_max_attempts, 3);
  assert.equal(received?.prompt.id, "research-design");
  assert.match(received?.prompt.body ?? "", /# Activation boundary/u);
  assert.equal(attempts.length, 1);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.provider, "test-provider");
  assert.equal(appended[0]?.model, "synthetic-test");
  assert.equal(appended[0]?.business_validation, "pass");
  assert.equal(appended[0]?.failure_class, undefined);
});
