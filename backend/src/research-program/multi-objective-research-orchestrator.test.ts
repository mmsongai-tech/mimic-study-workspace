import assert from "node:assert/strict";
import test from "node:test";
import type { DynamicLocalRunBundle } from "../clinical-data/index.js";
import type { StudySpec } from "../research-design/index.js";
import type { ObjectiveCoverageReview, ResearchObjectiveList } from "../research-objectives/index.js";
import { MultiObjectiveResearchOrchestrator } from "./index.js";

const list: ResearchObjectiveList = { schema_version: "1.0.0", original_question: "比较两个结局", objectives: [
  { objective_id: "first", purpose: "association", relationship: "primary", question: "因素与结局甲的关联", population: "住院人群", exposure_or_predictors: ["因素"], outcome: "结局甲", effect_modifiers: [], source_claims: ["结局甲"] },
  { objective_id: "second", purpose: "association", relationship: "secondary", question: "因素与结局乙的关联", population: "住院人群", exposure_or_predictors: ["因素"], outcome: "结局乙", effect_modifiers: [], source_claims: ["结局乙"] },
], ambiguities: [] };
const coverage: ObjectiveCoverageReview = { schema_version: "1.0.0", decision: "pass", covered_claims: ["结局甲", "结局乙"], missing_claims: [], altered_claims: [], unsupported_additions: [], explanation: "完整" };
const spec = (question: string, outcome: string): StudySpec => ({ schema_version: "1.0.0", intent_family: "association", research_question: question, population: { description: "住院人群" }, index_time: { event: "入院", selection_rule: "每次住院" }, exposure_or_predictors: [{ name: "因素", role: "exposure", operational_definition: "入院时记录" }], outcome: { name: outcome, role: "outcome", operational_definition: "住院期记录" }, outcome_structure: "binary", time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], estimand: { target_population: "住院人群", exposure_contrast: "因素不同水平", outcome_measure: outcome, summary_measure: "优势比" }, analysis_family: "association", assumptions: ["未指定细节需复核"] });
const completed = (study: StudySpec, suffix: string) => ({ artifact: { schema_version: "2.0.0", run_id: `run:${suffix.repeat(20)}`, created_at: "2026-09-10T00:00:00.000Z", status: "completed", evidence_level: "local_mimic_archive_execution", study, manifest: {}, data_provenance: { data_source_id: "local", data_source_version: "1", archive_sha256: "sha256:data" }, diagnostic_decision: "reportable", blockers: [], warnings: [], reproducibility_id: `sha256:${suffix.repeat(64)}`, integrity_id: `sha256:${suffix.repeat(64)}` }, report_markdown: "child" }) as unknown as DynamicLocalRunBundle;

test("runs every reviewed objective and creates one completed report", async () => {
  const executed: string[] = [];
  const orchestrator = new MultiObjectiveResearchOrchestrator({ objectives: { analyze: async () => ({ objective_list: list, coverage, audit: [] }) }, compiler: { compile: async ({ objective }) => ({ objective_id: objective.objective_id, study_spec: spec(objective.question, objective.outcome), audit: [] }) }, local_runs: { execute: async ({ spec: study }) => { executed.push(study.research_question!); return completed(study, String(executed.length)); } }, now: () => new Date("2026-09-10T00:00:00.000Z") });
  const result = await orchestrator.run(list.original_question);
  assert.deepEqual(executed, list.objectives.map(({ question }) => question));
  assert.equal(result.report.artifact.status, "completed");
  assert.equal(result.report.artifact.objective_counts.completed, 2);
});

test("keeps later objectives running when one objective compilation is blocked", async () => {
  let executions = 0;
  const orchestrator = new MultiObjectiveResearchOrchestrator({ objectives: { analyze: async () => ({ objective_list: list, coverage, audit: [] }) }, compiler: { compile: async ({ objective }) => { if (objective.objective_id === "first") throw Object.assign(new Error("invalid"), { audit: { schema_version: "1.0.0", stage: "objective_study_spec_compile", provider: "router", model: "model", prompt: { id: "p", version: "1", sha256: "sha256:p" }, output_schema: { id: "s", version: "1", sha256: "sha256:s" }, objective_sha256: "sha256:o", response_received: true, json_parse: "pass", schema_validation: "pass", business_validation: "fail", repair_attempts: 1, failure_class: "BUSINESS_VALIDATION_FAILED", latency_ms: 1 } }); return { objective_id: objective.objective_id, study_spec: spec(objective.question, objective.outcome), audit: [] }; } }, local_runs: { execute: async ({ spec: study }) => { executions += 1; return completed(study, "z"); } }, now: () => new Date("2026-09-10T00:00:00.000Z") });
  const result = await orchestrator.run(list.original_question);
  assert.equal(executions, 1);
  assert.equal(result.report.artifact.status, "partial");
  assert.equal(result.objective_traces[0]?.blocker?.code, "BUSINESS_VALIDATION_FAILED");
  assert.equal(result.objective_traces[1]?.status, "completed");
});

test("does not compile or execute a list that fails independent coverage", async () => {
  let calls = 0;
  const needsReview = { ...coverage, decision: "needs_review" as const, covered_claims: ["结局甲"], missing_claims: ["结局乙"] };
  const orchestrator = new MultiObjectiveResearchOrchestrator({ objectives: { analyze: async () => ({ objective_list: list, coverage: needsReview, audit: [] }) }, compiler: { compile: async () => { calls += 1; throw new Error("not expected"); } }, local_runs: { execute: async () => { calls += 1; throw new Error("not expected"); } }, now: () => new Date("2026-09-10T00:00:00.000Z") });
  const result = await orchestrator.run(list.original_question);
  assert.equal(calls, 0);
  assert.equal(result.report.artifact.status, "blocked");
  assert.equal(result.report.artifact.objective_counts.blocked, 2);
});

test("passes declared generic data capabilities to every objective compiler", async () => {
  const contexts: Array<Record<string, unknown> | undefined> = [];
  const shared = { supported_analysis_units: ["hospital admission"], supported_outcome_structures: ["binary"] };
  const orchestrator = new MultiObjectiveResearchOrchestrator({ objectives: { analyze: async () => ({ objective_list: list, coverage, audit: [] }) }, compiler: { compile: async ({ objective, shared_context }) => { contexts.push(shared_context); return { objective_id: objective.objective_id, study_spec: spec(objective.question, objective.outcome), audit: [] }; } }, local_runs: { execute: async ({ spec: study }) => completed(study, "c") }, shared_context: shared, now: () => new Date("2026-09-10T00:00:00.000Z") });
  await orchestrator.run(list.original_question);
  assert.deepEqual(contexts, list.objectives.map(({ relationship }) => ({ ...shared, objective_relationship: relationship })));
});

test("runs independent objectives concurrently and blocks dependent objectives when an upstream objective fails", async () => {
  const dependentList: ResearchObjectiveList = { ...list, objectives: [list.objectives[0]!, list.objectives[1]!, { ...list.objectives[1]!, objective_id: "mediation", relationship: "mediation", mediator: "血压", depends_on_objective_ids: ["first", "second"], question: "血压的中介作用", source_claims: ["中介作用"] }] };
  let active = 0; let maximumActive = 0;
  const orchestrator = new MultiObjectiveResearchOrchestrator({ objectives: { analyze: async () => ({ objective_list: dependentList, coverage, audit: [] }) }, compiler: { compile: async ({ objective }) => ({ objective_id: objective.objective_id, study_spec: spec(objective.question, objective.outcome), audit: [] }) }, local_runs: { execute: async ({ spec: study }) => { active += 1; maximumActive = Math.max(maximumActive, active); await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1; if (study.research_question === list.objectives[0]?.question) throw new Error("blocked"); return completed(study, "d"); } }, now: () => new Date("2026-09-10T00:00:00.000Z") });
  const result = await orchestrator.run(dependentList.original_question);
  assert.equal(maximumActive, 2);
  assert.equal(result.objective_traces.find(({ objective_id }) => objective_id === "mediation")?.blocker?.code, "OBJECTIVE_DEPENDENCY_BLOCKED");
});
