import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmedStudySpec, StudySpec } from "../research-design/index.js";
import { createConfirmedStudySpecIntegrityId } from "../research-design/index.js";
import { CompoundOutcomeLocalRunService } from "./compound-outcome-local-run-service.js";

const spec: StudySpec = {
  schema_version: "1.0.0", intent_family: "association", research_question: "One exposure and two outcomes",
  analysis_objectives: {
    schema_version: "1.0.0", original_question: "One exposure and two outcomes",
    requested: [{ objective_id: "continuous", source_text: "continuous measure", outcome_structure: "continuous" }, { objective_id: "binary", source_text: "binary event", outcome_structure: "binary" }],
    objectives: (["continuous", "binary"] as const).map((scale) => ({
      objective_id: scale, status: "ready", outcome_structure: scale,
      outcome: { name: scale, role: "outcome", operational_definition: "Synthetic independently measured outcome",
        definition: { condition_id: scale, source_text: scale, kind: "concept", concept: scale, assertion: "present" } },
      time_windows: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }],
      estimand: { target_population: "Synthetic cohort", exposure_contrast: "Exposed versus unexposed", outcome_measure: scale, summary_measure: scale === "continuous" ? "mean_difference" : "risk_difference" },
      analysis_family: "association",
    })),
  },
};
const confirmed: ConfirmedStudySpec = { schema_version: "1.0.0", session_id: "session", revision: 1, confirmed_at: "2026-09-15T00:00:00.000Z", integrity_id: createConfirmedStudySpecIntegrityId("session", 1, spec), spec };

test("persists and restores one unified report for explicit independent outcomes", async () => {
  const reports = new Map<string, never>();
  let executions = 0;
  const service = new CompoundOutcomeLocalRunService({
    mappings: { assess: async (study) => ({ schema_version: "1.0.0", status: "ready", summary: { resolved: 1, needs_confirmation: 0, unmapped: 0 }, verification_available: true, variables: [{ schema_version: "1.0.0", requested_term: study.outcome!.name, role: "outcome", condition_id: study.outcome!.definition!.condition_id, status: "resolved", candidates: [{ candidate_id: "candidate", requested_term: study.outcome!.name, normalized_term: study.outcome!.name, role: "outcome", mapping: { schema_version: "1.0.0", mapping_id: "mapping", concept_id: "concept", mapping_version: "1", labels: { en: "outcome" }, synonyms: [], category: "outcome", value_type: study.outcome!.definition!.condition_id === "continuous" ? "continuous" : "binary", definition: { summary: "mapped", temporal_rule: "after", value_rule: "recorded", missingness_rule: "explicit" }, sources: [{ kind: "direct_field", schema: "mimiciv_hosp", table: "admissions", columns: ["hadm_id"] }], status: "validated", provenance: "team_validation", evidence: {}, created_at: "2026-09-15T00:00:00.000Z", updated_at: "2026-09-15T00:00:00.000Z" }, match_basis: ["validated_mapping"], confidence: "high", requires_clinician_confirmation: false, explanation: "validated" }] }] }) },
    local_runs: {
      createAnalysisPlan: async () => ({}) as never,
      getRun: async () => undefined,
      execute: async (study) => { executions += 1; return { artifact: { schema_version: "2.0.0", run_id: `run:${executions}`, created_at: "2026-09-15T00:00:00.000Z", status: "completed", evidence_level: "local_mimic_archive_execution", study: study.spec, manifest: { manifest_id: `manifest:${executions}` }, data_provenance: {}, diagnostic_decision: "reportable", blockers: [], warnings: [], analysis: { method: "fixed_method", estimates: {}, diagnostics: {}, sensitivity: {}, publication_outputs: { tables: [], listings: [], figures: [] } }, reproducibility_id: `sha256:${String(executions).repeat(64)}`, integrity_id: `sha256:${String(executions + 2).repeat(64)}` }, report_markdown: "child" } as never; },
    },
    reports: { save: async (bundle) => { reports.set(bundle.artifact.report_id, bundle as never); return true; }, findByReportId: async (id) => reports.get(id) },
    now: () => new Date("2026-09-15T00:00:00.000Z"),
  });
  const result = await service.execute(confirmed);
  assert.equal(executions, 2);
  assert.ok("objective_counts" in result.artifact);
  assert.deepEqual(result.artifact.objective_counts, { total: 2, completed: 2, blocked: 0 });
  assert.deepEqual(await service.getRun(result.artifact.report_id), result);
});
