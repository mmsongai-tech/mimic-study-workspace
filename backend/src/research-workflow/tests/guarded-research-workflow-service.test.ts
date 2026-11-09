import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisPlan } from "../../analysis-planning/index.js";
import { GuardedGeneratedAnalysisWorkflow, type GeneratedAnalysisResult } from "../../generated-analysis/index.js";
import type { ConfirmedStudySpec } from "../../research-design/design-session.js";
import type { DataSourceDescriptor } from "../../research-feasibility/domain/preflight.js";
import {
  GuardedResearchWorkflowError,
  GuardedResearchWorkflowService,
  InMemoryGuardedRunEvidenceRepository,
} from "../index.js";

const study = {
  schema_version: "1.0.0",
  integrity_id: "sha256:study",
  spec: { title: "General MIMIC-IV study" },
} as ConfirmedStudySpec;
const dataSource: DataSourceDescriptor = {
  id: "synthetic-general", version: "1.0.0", data_mode: "synthetic", available_concepts: ["age"],
};
const plan = {
  schema_version: "1.0.0",
  status: "ready_for_confirmation",
  execution_mode: "guarded_generated",
  study_spec: study.spec,
  method: {
    study_family: "association",
    primary_method: "Prespecified regression",
    rationale: "Estimate the prespecified association.",
    required_conditions: ["Independent observations"],
    required_diagnostics: ["Residual diagnostics"],
    sensitivity_analyses: ["Alternative specification"],
  },
} as AnalysisPlan;
const generatedResult: GeneratedAnalysisResult = {
  status: "completed", language: "python", study_family: "association", method: "Prespecified regression",
  aggregate_result: { n: 2, estimate: 1.5 }, source_sha256: "sha256:source", duration_ms: 5,
  sandbox: "macos_sandbox", warnings: [],
};

const build = (planProvider = () => plan) => {
  let executions = 0;
  const generated = new GuardedGeneratedAnalysisWorkflow({
    planner: { async propose() { return {
      schema_version: "1.0.0", study_family: "association", language: "python", method: "Prespecified regression",
      method_rationale: "Prespecified", required_conditions: [], packages: ["json"], source_code: "import json",
      required_result_keys: ["n", "estimate"],
    }; } },
    executor: { async execute() { executions += 1; return generatedResult; } },
  });
  const runs = new InMemoryGuardedRunEvidenceRepository();
  const service = new GuardedResearchWorkflowService({
    analysisPlans: { create: planProvider }, generatedAnalysis: generated, runs,
    now: () => "2026-09-02T00:00:00.000Z", runId: () => "guarded-run-1",
  });
  return { service, runs, executions: () => executions };
};

const reviewInput = {
  study, data_source: dataSource,
  field_manifest: [{ name: "age", type: "number" as const, role: "exposure" }],
  language: "python" as const, allowed_packages: ["json"], allowed_result_keys: ["n", "estimate"],
};

test("requires exact confirmation, persists aggregate evidence, and blocks interpretation pending diagnostics", async () => {
  const { service, runs, executions } = build();
  const review = service.prepare(reviewInput);
  const bundle = await service.execute({ study, data_source: dataSource, confirmed_review: review, controlled_input: { age: [40, 60] } });

  assert.equal(executions(), 1);
  assert.equal(bundle.artifact.confirmation_integrity_id, review.confirmation_integrity_id);
  assert.equal(bundle.artifact.statistical_review.interpretation_status, "blocked_pending_diagnostic_review");
  assert.deepEqual(bundle.artifact.result.aggregate_result, { n: 2, estimate: 1.5 });
  assert.match(bundle.report_markdown, /Primary interpretation: blocked/);
  assert.equal((await runs.findByRunId("guarded-run-1"))?.artifact.integrity_id, bundle.artifact.integrity_id);
});

test("fails closed before execution when the confirmed analysis plan has changed", async () => {
  let currentPlan = plan;
  const { service, executions } = build(() => currentPlan);
  const review = service.prepare(reviewInput);
  currentPlan = { ...plan, method: { ...plan.method, primary_method: "Changed method" } };

  await assert.rejects(
    () => service.execute({ study, data_source: dataSource, confirmed_review: review, controlled_input: {} }),
    (error: unknown) => error instanceof GuardedResearchWorkflowError && error.code === "CONFIRMATION_MISMATCH",
  );
  assert.equal(executions(), 0);
});
