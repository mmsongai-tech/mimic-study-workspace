import assert from "node:assert/strict";
import test from "node:test";
import { createConfirmedStudySpecIntegrityId, type ConfirmedStudySpec, type StudySpec } from "../research-design/index.js";
import { syntheticObjectiveStudy } from "../research-design/tests/analysis-objectives-fixture.js";
import { CompoundOutcomeLocalRunService, FrozenStudyOutcomeObjectiveRunner, hasCompoundOutcomeObjectives } from "./index.js";
import type { AnalysisPlan } from "../analysis-planning/index.js";

const confirm = (spec: StudySpec): ConfirmedStudySpec => ({ schema_version: "1.0.0", session_id: "synthetic-session", revision: 2,
  confirmed_at: "2026-09-16T00:00:00.000Z", integrity_id: createConfirmedStudySpecIntegrityId("synthetic-session", 2, spec), spec });
const noMapping = { assess: async () => { throw new Error("The local executor owns each objective's mapping."); } };
const now = () => new Date("2026-09-16T00:00:00.000Z");
// Synthetic orchestration output. This is NOT real-data statistical evidence.
const syntheticRun = (study: ConfirmedStudySpec, index: number) => ({ artifact: {
  schema_version: "2.0.0", run_id: `run:${index}`, created_at: now().toISOString(), status: "completed", evidence_level: "pre_execution_block",
  study: study.spec, manifest: { schema_version: "2.0.0", manifest_id: `manifest:${index}`, study_integrity_id: study.integrity_id,
    data_model: "MIMIC-IV", study_family: "association", status: "ready", sources: [], joins: [], variables: [], time_windows: [], blockers: [] },
  data_provenance: { data_source_id: "synthetic-contract-fixture", data_source_version: "1", archive_sha256: `sha256:${"a".repeat(64)}` },
  diagnostic_decision: "reportable", blockers: [], warnings: [], reproducibility_id: `sha256:${String(index).repeat(64)}`, integrity_id: `sha256:${String(index + 2).repeat(64)}`,
}, report_markdown: "Synthetic orchestration fixture, not a statistical report." } as never);

test("runs explicit independent objectives without changing their declared measurement scales", async () => {
  const received: ConfirmedStudySpec[] = [];
  const runner = new FrozenStudyOutcomeObjectiveRunner({ mappings: noMapping, now,
    local_runs: { execute: async (study) => { received.push(study); return syntheticRun(study, received.length); } } });
  const result = await runner.run(confirm(syntheticObjectiveStudy()));
  assert.deepEqual(received.map(({ spec }) => spec.outcome_structure), ["continuous", "binary"]);
  assert.notEqual(received[0]!.integrity_id, received[1]!.integrity_id);
  assert.equal(received[0]!.spec.outcome!.derivation!.direction, "baseline_minus_follow_up");
  assert.deepEqual(result.report.artifact.objective_counts, { total: 2, completed: 2, blocked: 0 });
});

test("a genuine composite event is executed once; legacy Boolean trees are never split", async () => {
  const spec = syntheticObjectiveStudy(); const program = spec.analysis_objectives!; const event = program.objectives[1]!;
  const leaf = event.outcome.definition!;
  event.outcome.definition = { condition_id: "composite", source_text: "B or C", kind: "any", operands: [leaf, { ...leaf, condition_id: "event_c" }] };
  program.requested = [program.requested[1]!]; program.objectives = [event];
  let calls = 0;
  const runner = new FrozenStudyOutcomeObjectiveRunner({ mappings: noMapping, now,
    local_runs: { execute: async (study) => { calls += 1; assert.equal(study.spec.outcome!.definition!.kind, "any"); return syntheticRun(study, calls); } } });
  await runner.run(confirm(spec)); assert.equal(calls, 1);
  delete spec.analysis_objectives;
  assert.equal(hasCompoundOutcomeObjectives(spec), false);
  await assert.rejects(runner.run(confirm(spec)), /explicit objective contract/u);
});

test("one failed objective does not prevent the other from entering the unified report", async () => {
  let calls = 0;
  const runner = new FrozenStudyOutcomeObjectiveRunner({ mappings: noMapping, now,
    local_runs: { execute: async (study) => { calls += 1; if (calls === 1) throw new Error("Synthetic execution failure"); return syntheticRun(study, calls); } } });
  const result = await runner.run(confirm(syntheticObjectiveStudy()));
  assert.equal(calls, 2); assert.deepEqual(result.report.artifact.objective_counts, { total: 2, completed: 1, blocked: 1 });
});

test("a declared unsupported target is reported but not executed", async () => {
  const spec = syntheticObjectiveStudy(); spec.analysis_objectives!.objectives[0]!.status = "blocked";
  spec.analysis_objectives!.objectives[0]!.blocking_reason = "Synthetic source unavailable";
  let calls = 0;
  const runner = new FrozenStudyOutcomeObjectiveRunner({ mappings: noMapping, now,
    local_runs: { execute: async (study) => { calls += 1; assert.equal(study.spec.outcome_structure, "binary"); return syntheticRun(study, calls); } } });
  const result = await runner.run(confirm(spec)); assert.equal(calls, 1);
  assert.deepEqual(result.report.artifact.objective_counts, { total: 2, completed: 1, blocked: 1 });
});

test("planner can proceed with an eligible second goal and stored reports remain readable", async () => {
  const oldReport = { legacy: "saved report is not regenerated" } as never;
  const service = new CompoundOutcomeLocalRunService({ mappings: noMapping, now,
    reports: { save: async () => true, findByReportId: async () => oldReport },
    local_runs: { getRun: async () => undefined, execute: async (study) => syntheticRun(study, 1),
      createAnalysisPlan: async (study) => ({ status: study.spec.outcome_structure === "binary" ? "ready_for_confirmation" : "blocked", execution_mode: "registered", warnings: [], blocking_requirements: [], method: {} } as unknown as AnalysisPlan) } });
  const plan = await service.createAnalysisPlan(confirm(syntheticObjectiveStudy()));
  assert.equal(plan.status, "ready_for_confirmation"); assert.equal(plan.objective_plans!.length, 2);
  assert.equal(await service.getRun("report:legacy"), oldReport);
});
