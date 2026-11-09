import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ConfirmedStudySpec } from "../../research-design/index.js";
import type { VariableMappingRecord } from "../../variable-mapping/index.js";
import { LocalResearchRunService, type DynamicLocalRunBundle } from "../index.js";

const study = { schema_version: "1.0.0", session_id: "session", revision: 1, confirmed_at: "2026-09-08T00:00:00.000Z", integrity_id: "sha256:study", spec: { schema_version: "1.0.0", intent_family: "association" } } as ConfirmedStudySpec;
const executableStudy = { ...study, spec: {
  schema_version: "1.0.0", intent_family: "association", title: "Executable synthetic study", research_question: "Is a synthetic exposure associated with a synthetic outcome?",
  population: { description: "Synthetic admissions", criteria: { condition_id: "population.synthetic", source_text: "Synthetic admissions", kind: "concept", concept: "synthetic admission", assertion: "present" } },
  index_time: { event: "Admission", selection_rule: "First eligible admission" },
  exposure_or_predictors: [{ name: "Target", role: "exposure", operational_definition: "Recorded before outcome", definition: { condition_id: "exposure.target", source_text: "Target", kind: "concept", concept: "target", assertion: "present" } }],
  outcome: { name: "Synthetic outcome", role: "outcome", operational_definition: "Recorded by encounter end", definition: { condition_id: "outcome.synthetic", source_text: "Synthetic outcome", kind: "event_exists", concept: "synthetic outcome", occurrence: "present" } },
  outcome_structure: "binary", time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }],
  estimand: { target_population: "Synthetic admissions", exposure_contrast: "Target present versus absent", outcome_measure: "Synthetic outcome", summary_measure: "Risk difference" }, analysis_family: "association", assumptions: [],
} } as ConfirmedStudySpec;
const bundle = { artifact: { run_id: "run:12345678901234567890", reproducibility_id: "sha256:reproducible", integrity_id: "sha256:artifact" }, report_markdown: "# Local report" } as DynamicLocalRunBundle;

test("runs local evidence without falling back and replays the same immutable artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-run-service-")); const archive = join(directory, "mimic.zip"); await writeFile(archive, "local archive fixture");
  let runs = 0; const saved = new Map<string, DynamicLocalRunBundle>();
  const service = new LocalResearchRunService({
    archive_path: archive, archive_version: "test", catalog: { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "test", relations: [], relation_count: 0, column_count: 0, inspected_at: "2026-09-08T00:00:00.000Z" },
    mappings: { assess: async () => ({ schema_version: "1.0.0", status: "ready", variables: [], summary: { resolved: 0, needs_confirmation: 0, unmapped: 0 }, verification_available: true }) },
    workflow: { run: async (input) => { runs += 1; assert.match(input.provenance.archive_sha256, /^sha256:[a-f0-9]{64}$/u); return { ...bundle, artifact: { ...bundle.artifact, integrity_id: `sha256:artifact-${runs}` } }; } },
    runs: { save: async (value) => { if (saved.has(value.artifact.run_id)) return false; saved.set(value.artifact.run_id, value); return true; }, findByRunId: async (id) => saved.get(id) },
  });
  const first = await service.execute(study);
  const replayed = await service.execute(study);
  assert.equal(first.artifact.run_id, bundle.artifact.run_id);
  assert.equal(replayed.artifact.integrity_id, first.artifact.integrity_id);
  assert.equal(runs, 2); assert.equal(saved.size, 1);
});

test("does not offer a registered method when database evidence still requires clinical confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-plan-service-")); const archive = join(directory, "mimic.zip"); await writeFile(archive, "fixture");
  let allowLiveSearch: boolean | undefined;
  const mapping = { mapping_id: "mapping:age", concept_id: "age", mapping_version: "1", status: "database_verified" as const, labels: { en: "Age", zh: "年龄" }, value_type: "continuous" as const, definition: { temporal_rule: "at index", missingness_rule: "exclude" }, sources: [{ schema: "mimiciv_hosp" as const, table: "patients", columns: ["anchor_age"] }], evidence: { source: "local", data_profile: { source_id: "mimiciv_hosp.patients", matched_record_count: 10, missing_value_count: 0, units: [], top_values: [] } } };
  const service = new LocalResearchRunService({
    archive_path: archive, archive_version: "test", catalog: { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "test", relations: [], relation_count: 0, column_count: 0, inspected_at: "2026-09-08T00:00:00.000Z" },
    mappings: { assess: async (_study, live) => { allowLiveSearch = live; return ({ schema_version: "1.0.0", status: "needs_confirmation", variables: [{ role: "covariate", requested_term: "Age", status: "needs_confirmation", candidates: [{ mapping, score: 1, requires_clinician_confirmation: true }] }], summary: { resolved: 0, needs_confirmation: 1, unmapped: 0 }, verification_available: true }) as never; } },
    planning: { plan: (input) => input as never }, workflow: { run: async () => bundle }, runs: { save: async () => true, findByRunId: async () => undefined },
  });
  const plan = await service.createAnalysisPlan(study);
  assert.equal((plan as unknown as { registered_capability_id?: string }).registered_capability_id, undefined);
  assert.equal((plan as unknown as { mapping: { matches: Array<{ status: string }> } }).mapping.matches[0]?.status, "requires_dictionary_resolution");
  assert.equal(allowLiveSearch, false);
});

test("keeps analysis planning blocked when a confirmed historical spec lacks structured execution semantics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-protocol-plan-")); const archive = join(directory, "mimic.zip"); await writeFile(archive, "fixture");
  const service = new LocalResearchRunService({
    archive_path: archive, archive_version: "test", catalog: { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "test", relations: [], relation_count: 0, column_count: 0, inspected_at: "2026-09-08T00:00:00.000Z" },
    mappings: { assess: async () => ({ schema_version: "1.0.0", status: "ready", variables: [], summary: { resolved: 0, needs_confirmation: 0, unmapped: 0 }, verification_available: true }) },
    planning: { plan: (input) => input as never }, workflow: { run: async () => bundle }, runs: { save: async () => true, findByRunId: async () => undefined },
  });
  const plan = await service.createAnalysisPlan(study);
  const input = plan as unknown as { registered_capability_id?: string; clinical_concepts: { blocking_requirements: string[] } };
  assert.equal(input.registered_capability_id, undefined);
  assert.ok(input.clinical_concepts.blocking_requirements.some((message) => message.includes("POPULATION_REQUIRED")));
});

test("offers the registered local method for an explicitly non-clinical model-reviewed mapping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-model-reviewed-plan-")); const archive = join(directory, "mimic.zip"); await writeFile(archive, "fixture");
  const mapping: VariableMappingRecord = { schema_version: "1.0.0", mapping_id: "mapping:model-reviewed", concept_id: "target", mapping_version: "1.0.0", status: "model_reviewed", provenance: "automated_model_review", labels: { en: "Target" }, synonyms: [], category: "diagnosis", value_type: "binary", definition: { summary: "Target", temporal_rule: "during encounter", value_rule: "any selected code", missingness_rule: "no selected code" }, sources: [{ kind: "diagnosis_code", schema: "mimiciv_hosp", table: "diagnoses_icd", columns: ["hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses", codes: [{ code: "A1", version: 10 }] }], evidence: { automated_review: { schema_version: "1.0.0", requested_term: "Target", decision: "approved", selected_candidate_id: "candidate:source", selected_evidence_keys: ["d_icd_diagnoses:10:A1"], ranked_candidate_ids: ["candidate:source"], reason_codes: ["DIRECT_LABEL_MATCH"], explanation: "Supported", review_id: "review:test", reviewer_kind: "openai_compatible_model", provider: "openai_compatible", model: "test", prompt: { id: "mapping-evidence-review", version: "1.0.0" }, reviewed_at: "2026-09-10T00:00:00.000Z", authorization_basis: "runtime_configured_automated_review", clinical_confirmation: false, evidence_sha256: "sha256:evidence", source_mapping_id: "mapping:source" } }, created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z" };
  const service = new LocalResearchRunService({
    archive_path: archive, archive_version: "test", catalog: { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "test", relations: [], relation_count: 0, column_count: 0, inspected_at: "2026-09-08T00:00:00.000Z" },
    mappings: { assess: async () => ({ schema_version: "1.0.0", status: "ready", variables: [{ schema_version: "1.0.0", role: "exposure", requested_term: "Target", status: "resolved", candidates: [{ candidate_id: "candidate:model-reviewed", requested_term: "Target", normalized_term: "target", role: "exposure", mapping, match_basis: ["model_suggestion", "database_dictionary"], confidence: "medium", requires_clinician_confirmation: false, explanation: "Automated review; not clinician confirmation." }] }], summary: { resolved: 1, needs_confirmation: 0, unmapped: 0 }, verification_available: true }) },
    planning: { plan: (input) => input as never }, workflow: { run: async () => bundle }, runs: { save: async () => true, findByRunId: async () => undefined },
  });

  const plan = await service.createAnalysisPlan(executableStudy);

  assert.match((plan as unknown as { registered_capability_id: string }).registered_capability_id, /^local\.manifest\.r\./u);
  assert.equal((plan as unknown as { mapping: { matches: Array<{ status: string }> } }).mapping.matches[0]?.status, "mapped");
  assert.equal(mapping.evidence.automated_review?.clinical_confirmation, false);
});
