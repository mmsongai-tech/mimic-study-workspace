import assert from "node:assert/strict";
import test from "node:test";
import type { StudySpec } from "../../research-design/index.js";
import { StudyVariableMappingService, type VariableMappingRecord } from "../index.js";

test("maps every compound population leaf and preserves its condition identifier", async () => {
  const searched: string[] = [];
  const discovery = { search: async ({ term }: { term: string }) => { searched.push(term); return { schema_version: "1.0.0" as const, requested_term: term, status: "unmapped" as const, candidates: [], reason: "test" }; } };
  const service = new StudyVariableMappingService({ discovery: discovery as never, mappings: {} as never, lifecycle: {} as never });
  const spec: StudySpec = {
    schema_version: "1.0.0", intent_family: "association",
    population: { description: "Ventilated adults", criteria: { condition_id: "population.all", source_text: "Ventilated adults", kind: "all", operands: [
      { condition_id: "population.adult", source_text: "adults", kind: "numeric_comparison", concept: "age", operator: "gte", value: 18, unit: "year" },
      { condition_id: "population.ventilation", source_text: "ventilated", kind: "event_exists", concept: "invasive mechanical ventilation", occurrence: "present" },
    ] } },
  };
  const review = await service.assess(spec);
  assert.deepEqual(searched, ["age. adults", "invasive mechanical ventilation. ventilated", "age", "invasive mechanical ventilation"]);
  assert.deepEqual(review.variables.map(({ condition_id }) => condition_id), ["population.adult", "population.ventilation"]);
  assert.equal(review.summary.unmapped, 2);
});

test("keeps sibling condition text out of each compound outcome mapping search", async () => {
  const searched: string[] = [];
  const discovery = { search: async ({ term }: { term: string }) => { searched.push(term); return { schema_version: "1.0.0" as const, requested_term: term, status: "unmapped" as const, candidates: [], reason: "test" }; } };
  const service = new StudyVariableMappingService({ discovery: discovery as never, mappings: {} as never, lifecycle: {} as never });
  await service.assess({
    schema_version: "1.0.0", intent_family: "association", outcome_structure: "continuous",
    outcome: { name: "two outcomes", role: "outcome", operational_definition: "Alpha and beta are analyzed independently", definition: { condition_id: "outcome.any", source_text: "alpha or beta", kind: "any", operands: [
      { condition_id: "outcome.alpha", source_text: "recorded alpha measurements", kind: "concept", concept: "alpha measure", assertion: "present" },
      { condition_id: "outcome.beta", source_text: "recorded beta event", kind: "concept", concept: "beta event", assertion: "present" },
    ] } },
  });
  assert.match(searched[0] ?? "", /alpha measure/u);
  assert.doesNotMatch(searched[0] ?? "", /beta/u);
  assert.match(searched[1] ?? "", /beta event/u);
  assert.doesNotMatch(searched[1] ?? "", /alpha and beta/u);
});

test("maps a generic derived numeric outcome through its base measurement and preserves review", async () => {
  const searches: Array<{ term: string; expected?: string }> = [];
  const expansionChoices: Array<boolean | undefined> = [];
  const saved: string[] = [];
  let storedMapping: VariableMappingRecord | undefined;
  const raw = { schema_version: "1.0.0" as const, mapping_id: "raw-measurement", concept_id: "raw", mapping_version: "1", labels: { en: "Generic measurement" }, synonyms: [], category: "vital_sign" as const, value_type: "continuous" as const, definition: { summary: "Measurement", temporal_rule: "Recorded", value_rule: "Recorded", missingness_rule: "Missing" }, sources: [{ kind: "dictionary_item" as const, schema: "mimiciv_icu" as const, table: "chartevents", columns: ["hadm_id", "itemid", "charttime", "valuenum"], dictionary_table: "d_items" as const, item_ids: [42] }], status: "database_verified" as const, provenance: "realtime_discovery" as const, evidence: { dictionary_entries: [{ evidence_key: "d_items:item:42", dictionary: "d_items" as const, identifier: "42", label: "Generic measurement" }] }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z" };
  const rawCandidate = { candidate_id: "candidate:raw", requested_term: "generic measurement", normalized_term: "generic measurement", role: "outcome" as const, mapping: raw, match_basis: ["database_dictionary" as const], confidence: "medium" as const, requires_clinician_confirmation: true, explanation: "Review" };
  const discovery = { search: async ({ term, expected_value_type, allow_term_expansion }: { term: string; expected_value_type?: string; allow_term_expansion?: boolean }) => { searches.push({ term, ...(expected_value_type ? { expected: expected_value_type } : {}) }); expansionChoices.push(allow_term_expansion); return { schema_version: "1.0.0" as const, requested_term: term, status: "needs_confirmation" as const, candidates: [rawCandidate, { ...rawCandidate }] }; } };
  const service = new StudyVariableMappingService({ discovery: discovery as never, mappings: {
    save: async (mapping: VariableMappingRecord) => { saved.push(mapping.mapping_id); storedMapping = mapping; return true; },
    findById: async () => storedMapping,
  } as never, lifecycle: {} as never });
  const review = await service.assess({ schema_version: "1.0.0", intent_family: "treatment_effect", outcome_structure: "continuous", outcome: {
    name: "Arbitrary display label", role: "outcome", operational_definition: "Difference between the first values in two explicit periods",
    definition: { condition_id: "change", source_text: "measurement reduction", kind: "concept", concept: "Arbitrary derived concept", assertion: "present" },
    derivation: { schema_version: "1.0.0", operator: "difference", source_concept: "generic measurement", aggregation: "first", direction: "baseline_minus_follow_up",
      baseline: { purpose: "baseline", anchor: "index_time", start_offset: -24, end_offset: 0, unit: "hour" },
      follow_up: { purpose: "follow_up", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" } },
  } }, true);
  assert.deepEqual(searches[0], { term: "generic measurement", expected: "continuous" });
  assert.equal(review.variables[0]?.status, "needs_confirmation");
  assert.equal(review.variables[0]?.candidates.length, 1);
  assert.equal(review.variables[0]?.candidates[0]?.mapping.definition.derivation?.direction, "baseline_minus_follow_up");
  assert.equal(saved.length, 1);
  assert.ok(expansionChoices.includes(false));
});

test("resolves a code-hinted variable only when one verified candidate has strictly broader prefix coverage", async () => {
  const candidate = (id: string, category: "diagnosis" | "intervention", prefixes: string[]) => ({
    candidate_id: `candidate:${id}`, requested_term: "coded target", normalized_term: "coded target", role: "exposure" as const,
    mapping: { schema_version: "1.0.0" as const, mapping_id: id, concept_id: id, mapping_version: "1.0.0", labels: { en: id }, synonyms: [], category, value_type: "binary" as const, definition: { summary: id, temporal_rule: "During encounter", value_rule: "Any code", missingness_rule: "No code" }, sources: [{ kind: category === "diagnosis" ? "diagnosis_code" as const : "procedure_code" as const, schema: "mimiciv_hosp" as const, table: category === "diagnosis" ? "diagnoses_icd" : "procedures_icd", columns: ["subject_id", "hadm_id", "icd_code", "icd_version"], dictionary_table: category === "diagnosis" ? "d_icd_diagnoses" as const : "d_icd_procedures" as const, codes: prefixes.map((prefix) => ({ code: `${prefix}0`, version: 10 as const })) }], status: "database_verified" as const, provenance: "realtime_discovery" as const, evidence: { semantic_code_hints: { requested_prefixes: ["A10", "B20"], matched_prefixes: prefixes, match_mode: "dictionary_prefix" as const } }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z" },
    match_basis: ["database_dictionary" as const], confidence: "medium" as const, requires_clinician_confirmation: false, explanation: "verified code evidence",
  });
  const discovery = { search: async () => ({ schema_version: "1.0.0" as const, requested_term: "coded target", status: "needs_confirmation" as const, candidates: [candidate("diagnosis", "diagnosis", ["A10", "B20"]), candidate("procedure", "intervention", ["A10"])] }) };
  const service = new StudyVariableMappingService({ discovery: discovery as never, mappings: {} as never, lifecycle: {} as never });
  const review = await service.assess({ schema_version: "1.0.0", intent_family: "association", exposure_or_predictors: [{ name: "coded target", role: "exposure", operational_definition: "verified code families", definition: { condition_id: "exposure.codes", source_text: "A10 or B20", kind: "category_comparison", concept: "coded target", operator: "in", values: ["A10", "B20"] }, contrast: { kind: "binary_presence" } }] });
  assert.equal(review.status, "ready");
  assert.equal(review.variables[0]?.status, "resolved");
});

test("reuses frozen mappings before live semantic expansion and invalidates stale catalog assessments", async () => {
  const calls: boolean[] = [];
  const discovery = { search: async ({ term, allow_live_search }: { term: string; allow_live_search: boolean }) => {
    calls.push(Boolean(allow_live_search));
    return { schema_version: "1.0.0" as const, requested_term: term, status: allow_live_search ? "resolved" as const : "unmapped" as const, candidates: [], ...(allow_live_search ? {} : { reason: "not frozen" }) };
  } };
  const service = new StudyVariableMappingService({ discovery: discovery as never, mappings: {} as never, lifecycle: {} as never });
  const spec: StudySpec = { schema_version: "1.0.0", intent_family: "association", population: { description: "Target cohort" } };
  await service.assess(spec, false);
  await service.assess(spec, true);
  await service.assess(spec, false);
  assert.deepEqual(calls, [false, false, true, false]);
});

test("isolates aggregate evidence failures by source table", async () => {
  const mapping = (name: string, table: "labevents" | "chartevents") => ({
    schema_version: "1.0.0" as const, mapping_id: `mapping:${name}`, concept_id: name, mapping_version: "1", labels: { en: name }, synonyms: [name], category: table === "labevents" ? "laboratory" as const : "vital_sign" as const, value_type: "continuous" as const,
    definition: { summary: name, temporal_rule: "Before index", value_rule: "Recorded", missingness_rule: "Explicit" },
    sources: [{ kind: "dictionary_item" as const, schema: table === "labevents" ? "mimiciv_hosp" as const : "mimiciv_icu" as const, table, columns: ["itemid", "valuenum"], dictionary_table: table === "labevents" ? "d_labitems" as const : "d_items" as const, item_ids: [1] }],
    status: "model_reviewed" as const, provenance: "automated_model_review" as const, evidence: {}, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  });
  const safe = mapping("safe", "labevents"); const oversized = mapping("oversized", "chartevents");
  const discovery = { search: async ({ term }: { term: string }) => { const selected = term === "safe" ? safe : oversized; return { schema_version: "1.0.0" as const, requested_term: term, status: "resolved" as const, candidates: [{ candidate_id: `candidate:${selected.mapping_id}`, requested_term: term, normalized_term: term, role: "covariate" as const, mapping: selected, match_basis: ["model_suggestion" as const], confidence: "medium" as const, requires_clinician_confirmation: false, explanation: "Reviewed" }] }; } };
  const service = new StudyVariableMappingService({
    discovery: discovery as never,
    mappings: { save: async () => true } as never,
    lifecycle: {} as never,
    evidenceProfiler: { profile: async () => { throw new Error("unused"); }, profileMany: async (group) => {
      if (group[0]?.sources[0]?.table === "chartevents") throw new Error("source exceeds scan budget");
      return new Map([[safe.mapping_id, { source_id: "mimiciv_hosp.labevents", matched_record_count: 100, missing_value_count: 0, distinct_value_count: 10, units: [], top_values: [], profiled_at: "2026-09-14T00:00:00.000Z" }]]);
    } },
  });
  const review = await service.assess({ schema_version: "1.0.0", intent_family: "association", covariates: [{ name: "safe", role: "covariate", operational_definition: "Before index" }, { name: "oversized", role: "covariate", operational_definition: "Before index" }] });
  assert.equal(review.variables.find(({ requested_term }) => requested_term === "safe")?.status, "resolved");
  assert.equal(review.variables.find(({ requested_term }) => requested_term === "safe")?.candidates[0]?.mapping.evidence.data_profile?.matched_record_count, 100);
  assert.equal(review.variables.find(({ requested_term }) => requested_term === "oversized")?.status, "unmapped");
  assert.match(review.variables.find(({ requested_term }) => requested_term === "oversized")?.reason ?? "", /scan budget/u);
});

test("searches an English concept on its own when the source phrase is Chinese", async () => {
  const { StudyVariableMappingService, SqliteVariableMappingRepository, VariableMappingLifecycleService } = await import("../index.js");
  const repository = new SqliteVariableMappingRepository(":memory:");
  const searched: string[] = [];
  const service = new StudyVariableMappingService({
    mappings: repository, lifecycle: new VariableMappingLifecycleService(repository),
    discovery: { search: async (input: { term: string }) => { searched.push(input.term); return { schema_version: "1.0.0", requested_term: input.term, status: "unmapped", candidates: [] }; } } as never,
  });
  await service.assess({ schema_version: "1.0.0", intent_family: "treatment_effect", exposure_or_predictors: [{ name: "Metoprolol", role: "exposure", operational_definition: "Any metoprolol.", definition: { condition_id: "input.1", source_text: "美托洛尔", kind: "concept", concept: "Metoprolol", assertion: "present" } }] });
  assert.ok(searched.includes("Metoprolol"));
  assert.ok(!searched.some((term) => term.includes("美托洛尔")), JSON.stringify(searched));
  repository.close();
});

test("accepts the labels that name the drug when the automated review returns an invalid selection", async () => {
  const { StudyVariableMappingService, SqliteVariableMappingRepository, VariableMappingLifecycleService } = await import("../index.js");
  const repository = new SqliteVariableMappingRepository(":memory:");
  const labels = ["metoprolol", "Metoprolol Tartrate", "Metoprolol Succinate XL", "Metoprol", "Metoprolo"];
  const mapping: VariableMappingRecord = { schema_version: "1.0.0", mapping_id: "mimic-iv.discovered-medication.test.v1", concept_id: "metoprolol", mapping_version: "1.0.0", labels: { en: "Medication labels matching “Metoprolol”" }, synonyms: ["Metoprolol"], category: "medication", value_type: "binary",
    definition: { summary: "Metoprolol", temporal_rule: "window", aggregation: "any", value_rule: "labels", missingness_rule: "none recorded" },
    sources: [{ kind: "medication_label", schema: "mimiciv_hosp", table: "prescriptions", columns: ["subject_id", "hadm_id", "starttime", "drug"], dictionary_table: "prescriptions_drug", value_filters: [{ column: "drug", values: labels }] }],
    status: "database_verified", provenance: "realtime_discovery", evidence: { dictionary_entries: labels.map((label) => ({ evidence_key: `prescriptions_drug:${label}`, dictionary: "prescriptions_drug" as const, identifier: label, label })) }, created_at: "2026-09-24T00:00:00.000Z", updated_at: "2026-09-24T00:00:00.000Z" };
  const candidate = { candidate_id: `candidate:${mapping.mapping_id}`, requested_term: "Metoprolol", normalized_term: "metoprolol", role: "exposure" as const, mapping, match_basis: ["database_dictionary" as const], confidence: "low" as const, requires_clinician_confirmation: true, explanation: "candidate" };
  const service = new StudyVariableMappingService({
    mappings: repository, lifecycle: new VariableMappingLifecycleService(repository),
    discovery: { search: async () => ({ schema_version: "1.0.0", requested_term: "Metoprolol", status: "needs_confirmation", candidates: [structuredClone(candidate)] }) } as never,
    candidateReviewer: { review: async () => ({ schema_version: "1.0.0", requested_term: "Metoprolol", decision: "approved", selected_candidate_id: candidate.candidate_id, selected_evidence_keys: ["invented-key"], ranked_candidate_ids: [candidate.candidate_id], reason_codes: [], explanation: "x", evidence_sha256: "sha256:wrong" }) } as never,
  });
  const review = await service.assess({ schema_version: "1.0.0", intent_family: "treatment_effect", exposure_or_predictors: [{ name: "Metoprolol", role: "exposure", operational_definition: "Any.", definition: { condition_id: "input.1", source_text: "美托洛尔", kind: "concept", concept: "Metoprolol", assertion: "present" } }] });
  const exposure = review.variables.find(({ role }) => role === "exposure")!;
  assert.equal(exposure.status, "resolved");
  assert.deepEqual(exposure.candidates[0]?.mapping.sources[0]?.value_filters?.[0]?.values, labels);
  repository.close();
});

test("maps a description's characteristics by what they are, keeping their own condition ids", async () => {
  const searched: Array<{ term: string; role: string }> = [];
  const discovery = { search: async ({ term, role }: { term: string; role: string }) => { searched.push({ term, role }); return { schema_version: "1.0.0" as const, requested_term: term, status: "unmapped" as const, candidates: [], reason: "test" }; } };
  const service = new StudyVariableMappingService({ discovery: discovery as never, mappings: {} as never, lifecycle: {} as never });
  const review = await service.assess({
    schema_version: "1.0.0", intent_family: "association",
    characteristics: [
      { name: "Creatinine", role: "covariate", operational_definition: "Creatinine within the first 24 hours after the index time.", definition: { condition_id: "characteristic.1", source_text: "肌酐", kind: "concept", concept: "Creatinine", assertion: "present" } },
      { name: "In-hospital mortality", role: "outcome", operational_definition: "In-hospital mortality to the end of the index encounter.", definition: { condition_id: "characteristic.2", source_text: "住院死亡率", kind: "concept", concept: "In-hospital mortality", assertion: "present" } },
    ],
  });
  // An outcome-type concept (death) is searched as an outcome, a measurement as a baseline variable, so each category rule applies.
  assert.deepEqual([...new Set(searched.map(({ term, role }) => `${role}:${term}`))].filter((key) => !key.includes(".")), ["covariate:Creatinine", "outcome:In-hospital mortality"]);
  assert.deepEqual(review.variables.map(({ role, condition_id, requested_term }) => [role, condition_id, requested_term]), [["covariate", "characteristic.1", "Creatinine"], ["outcome", "characteristic.2", "In-hospital mortality"]]);
});
