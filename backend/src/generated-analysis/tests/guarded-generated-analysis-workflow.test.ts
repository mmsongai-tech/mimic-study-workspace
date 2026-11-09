import assert from "node:assert/strict";
import test from "node:test";
import { GuardedGeneratedAnalysisWorkflow, GeneratedAnalysisError, type GeneratedAnalysisPlan, type GeneratedAnalysisResult } from "../index.js";
import type { AnalysisPlan } from "../../analysis-planning/index.js";

const generated: GeneratedAnalysisPlan = {
  schema_version: "1.0.0", study_family: "association", language: "python", method: "Summary",
  method_rationale: "Describe the cohort.", required_conditions: ["Fixed denominator"], packages: ["json"],
  source_code: "import json", required_result_keys: ["n"],
};

const approvedPlan = { status: "ready_for_confirmation", execution_mode: "guarded_generated", method: { study_family: "association", outcome_structure: "continuous" } } as AnalysisPlan;

test("connects only an approved plan and verified field manifest to the guarded executor", async () => {
  let executed = false;
  const expected: GeneratedAnalysisResult = {
    status: "completed", study_family: "association", language: "python", method: "Summary",
    aggregate_result: { n: 2 }, source_sha256: "sha256:source", duration_ms: 1,
    sandbox: "macos_sandbox", warnings: [],
  };
  const workflow = new GuardedGeneratedAnalysisWorkflow({
    planner: { async propose() { return generated; } },
    executor: { async execute() { executed = true; return expected; } },
  });
  const result = await workflow.execute({
    analysis_plan: approvedPlan,
    field_manifest: [{ name: "age", type: "number", role: "covariate" }],
    controlled_input: { age: [40, 60] },
    language: "python",
    allowed_packages: ["json"],
    allowed_result_keys: ["n"],
  });
  assert.equal(executed, true);
  assert.equal(result, expected);
});

test("rejects unapproved or family-changing generated plans before execution", async () => {
  const workflow = new GuardedGeneratedAnalysisWorkflow({
    planner: { async propose() { return { ...generated, study_family: "prediction" }; } },
    executor: { async execute() { throw new Error("must not execute"); } },
  });
  await assert.rejects(
    () => workflow.execute({ analysis_plan: approvedPlan, field_manifest: [{ name: "age", type: "number", role: "covariate" }], controlled_input: {}, language: "python", allowed_packages: ["json"], allowed_result_keys: ["n"] }),
    (error: unknown) => error instanceof GeneratedAnalysisError && error.code === "GENERATED_PLAN_INVALID",
  );
});

test("rejects generated plans and outputs that expand the approved aggregate contract", async () => {
  const expandedPlan = { ...generated, required_result_keys: ["n", "patient_rows"] };
  const planWorkflow = new GuardedGeneratedAnalysisWorkflow({
    planner: { async propose() { return expandedPlan; } },
    executor: { async execute() { throw new Error("must not execute"); } },
  });
  await assert.rejects(
    () => planWorkflow.execute({ analysis_plan: approvedPlan, field_manifest: [{ name: "age", type: "number", role: "covariate" }], controlled_input: {}, language: "python", allowed_packages: ["json"], allowed_result_keys: ["n"] }),
    (error: unknown) => error instanceof GeneratedAnalysisError && error.code === "GENERATED_PLAN_INVALID",
  );

  const outputWorkflow = new GuardedGeneratedAnalysisWorkflow({
    planner: { async propose() { return generated; } },
    executor: { async execute() { return { status: "completed", aggregate_result: { n: 2, patient_rows: [1, 2] } } as unknown as GeneratedAnalysisResult; } },
  });
  await assert.rejects(
    () => outputWorkflow.execute({ analysis_plan: approvedPlan, field_manifest: [{ name: "age", type: "number", role: "covariate" }], controlled_input: {}, language: "python", allowed_packages: ["json"], allowed_result_keys: ["n"] }),
    (error: unknown) => error instanceof GeneratedAnalysisError && error.code === "GENERATED_OUTPUT_INVALID",
  );
});
