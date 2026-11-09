import { createHash } from "node:crypto";
import type { ClinicalDatabaseCatalog } from "../clinical-database/index.js";
import { listStudyConditions, type StudyCondition, type StudySpec } from "../research-design/index.js";
import { isCandidateExecutable, semanticCodeHintCoverage, type StudyVariableMappingReview, type VariableMappingRecord } from "../variable-mapping/index.js";

export type ExecutionValueRule =
  | { kind: "direct"; column: string }
  | { kind: "item_ids"; id_column: string; ids: number[]; value_column: string }
  /** `value_column × factor` for rows whose item id and unit are listed; any other row is ignored (dose normalisation, e.g. morphine equivalents). */
  | { kind: "weighted_amount"; id_column: string; value_column: string; unit_column: string; conversions: Array<{ item_id: number; unit: string; factor: number }> }
  | { kind: "codes"; code_column: string; version_column: string; codes: Array<{ code: string; version: 9 | 10 }> }
  /** A record counts when `column` has one of `values` and every `also` filter holds (e.g. item 228332 and value "Positive"). */
  | { kind: "matching_values"; column: string; values: string[]; also?: Array<{ column: string; values: string[] }> }
  | { kind: "code_score"; code_column: string; version_column: string; groups: Array<{ group_id: string; weight: number; code_prefixes: Array<{ prefix: string; version: 9 | 10 }>; supersedes?: string[] }> };

export interface ExecutionManifestSource { id: string; schema: "mimiciv_hosp" | "mimiciv_icu" | "mimiciv_derived"; table: string; required_columns: string[]; }
export interface ExecutionManifestJoin { left_source_id: string; right_source_id: string; left_column: string; right_column: string; cardinality: "many_to_one" | "one_to_many" | "one_to_one"; }
/** `characteristic`: a described characteristic of a description (condition id `characteristic.N`), read with its role's window but never the plan's exposure, outcome or adjustment variable. */
export interface ExecutionManifestVariable { role: "population" | "index_time" | "exposure" | "predictor" | "outcome" | "covariate"; characteristic?: boolean; condition_id?: string; semantic_condition?: StudyCondition; requested_label: string; mapping_id: string; mapping_version: string; source_id: string; value_type: VariableMappingRecord["value_type"]; value_rule: ExecutionValueRule; data_evidence?: NonNullable<VariableMappingRecord["evidence"]["data_profile"]>; contrast?: NonNullable<StudySpec["outcome"]>["contrast"]; effect_modifier?: boolean; time_column?: string; temporal_rule: string; aggregation?: NonNullable<VariableMappingRecord["definition"]["aggregation"]>; derivation?: NonNullable<VariableMappingRecord["definition"]["derivation"]>; valid_range?: { min?: number; max?: number }; missingness_rule: string; }
export interface ExecutionManifestBlocker { code: "MAPPING_UNRESOLVED" | "DICTIONARY_VALUES_UNRESOLVED" | "CATALOG_FIELD_MISSING" | "JOIN_PATH_MISSING" | "ANALYSIS_UNIT_MISSING" | "CONDITION_BINDING_MISSING" | "DATA_EVIDENCE_MISSING" | "NO_MATCHED_RECORDS" | "UNIT_CONFLICT" | "CATEGORY_VALUE_UNVERIFIED" | "DERIVATION_WINDOW_MISSING" | "DERIVATION_TIME_MISSING"; role?: ExecutionManifestVariable["role"]; requested_label?: string; condition_id?: string; message: string; }
/** Optional extraction rules; absent means every eligible unit and no follow-up time (manifest 2.0.0 behaviour). */
export interface ExecutionManifestExtraction {
  /** Keep only each patient's earliest eligible unit by index time, so rows are independent patients. */
  unit_selection?: "first_per_subject";
  /** Produce `time` (days) and `event` (0/1) for the outcome, censored at the horizon or, for encounter-bounded sources, at the end of the encounter. */
  outcome_timing?: { kind: "time_to_event"; horizon_days: number; follow_up: "death_registry" | "encounter" };
  /**
   * Landmark: follow-up starts this many hours after time zero. Units that end (discharge, death, ICU exit) before it
   * are excluded, and outcomes are counted only after it, so the exposure window closes before outcomes count.
   */
  landmark_hours?: number;
}
/** Comorbidity-score groups removed because they contain the codes of the exposure itself (adjusting for them would adjust the exposure for itself). */
export interface ScoreExclusion { variable: string; removed_groups: string[]; because_of: string }
export interface ExecutionManifest { score_exclusions?: ScoreExclusion[]; schema_version: "2.0.0"; manifest_id: string; study_integrity_id: string; data_model: "MIMIC-IV"; study_family: "association" | "prediction" | "treatment_effect"; status: "ready" | "blocked"; analysis_unit?: { source_id: string; column: "stay_id" | "hadm_id" | "subject_id" }; sources: ExecutionManifestSource[]; joins: ExecutionManifestJoin[]; variables: ExecutionManifestVariable[]; population_predicate?: StudyCondition; time_windows: StudySpec["time_windows"]; extraction?: ExecutionManifestExtraction; blockers: ExecutionManifestBlocker[]; }

const DAYS_PER_UNIT: Record<string, number> = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30.436875, year: 365.2425 };
/** Follow-up horizon in days from the study's outcome window; one year when unbounded (MIMIC-IV death capture). */
const horizonDays = (study: StudySpec): number => {
  const window = study.time_windows?.find(({ purpose }) => purpose === "outcome");
  return window && "end_offset" in window ? window.end_offset * (DAYS_PER_UNIT[window.unit] ?? 1) : 365;
};
const TIME_COLUMN = /(?:^|_)(?:in|out|admit|start|chart|store|end|death|discharge)?time$|^dod$|(?:^|_)date$/iu;

const sourceId = (source: VariableMappingRecord["sources"][number]): string => `${source.schema}.${source.table}`;
const identifierPriority = ["stay_id", "hadm_id", "subject_id"] as const;
const technicalColumns = new Set(["subject_id", "hadm_id", "stay_id", "itemid", "icd_code", "icd_version", "seq_num", "charttime", "storetime", "starttime", "endtime"]);

const normalizeCategoryCondition = (condition: StudyCondition | undefined, mapping: VariableMappingRecord): StudyCondition | undefined => {
  if (condition?.kind !== "category_comparison") return condition;
  if (mapping.sources.some((source) => source.codes?.length)) {
    return { condition_id: condition.condition_id, source_text: condition.source_text, kind: "concept", concept: condition.concept, assertion: condition.operator === "in" ? "present" : "absent" };
  }
  if (!mapping.definition.category_values?.length) return condition;
  const normalized = condition.values.map((requested) => mapping.definition.category_values!.find(({ source_value, labels }) => [source_value, ...labels].some((value) => value.toLocaleLowerCase() === requested.toLocaleLowerCase()))?.source_value ?? requested);
  return { ...condition, values: [...new Set(normalized)] };
};

const semanticCodeHintsVerified = (mapping: VariableMappingRecord): boolean => {
  return semanticCodeHintCoverage(mapping).has_verified_matches;
};

const hasCondition = (condition: StudyCondition | undefined, conditionId: string | undefined): boolean => Boolean(condition && conditionId && listStudyConditions(condition).some(({ condition_id }) => condition_id === conditionId));

/** A population criterion on a value ("sex is F", "age ≥ 65") reads the field itself; any other population criterion is membership. */
const buildValueRule = (role: ExecutionManifestVariable["role"], mapping: VariableMappingRecord, source: VariableMappingRecord["sources"][number], condition?: StudyCondition): ExecutionValueRule | undefined => {
  if (source.score_groups?.length) return { kind: "code_score", code_column: "icd_code", version_column: "icd_version", groups: source.score_groups.map(({ group_id, weight, code_prefixes, supersedes }) => ({ group_id, weight, code_prefixes, ...(supersedes?.length ? { supersedes } : {}) })) };
  if (source.value_filters?.length) {
    const [first, ...rest] = source.value_filters;
    return { kind: "matching_values", column: first!.column, values: [...first!.values], ...(rest.length ? { also: rest.map(({ column, values }) => ({ column, values: [...values] })) } : {}) };
  }
  if (source.amount_conversions?.length) return { kind: "weighted_amount", id_column: "itemid", value_column: "amount", unit_column: "amountuom", conversions: source.amount_conversions.map(({ item_id, unit, factor }) => ({ item_id, unit, factor })) };
  if (source.item_ids?.length) return { kind: "item_ids", id_column: "itemid", ids: [...source.item_ids], value_column: source.columns.includes("valuenum") ? "valuenum" : source.columns.find((column) => !technicalColumns.has(column)) ?? "value" };
  if (source.codes?.length) return { kind: "codes", code_column: "icd_code", version_column: "icd_version", codes: [...source.codes] };
  const comparesValue = condition?.kind === "category_comparison" || condition?.kind === "numeric_comparison";
  const column = role === "population" && !comparesValue ? identifierPriority.find((candidate) => source.columns.includes(candidate))
    : role === "index_time" ? source.columns.find((candidate) => /(?:^|_)(?:in|admit|start|chart)?time$/iu.test(candidate))
    : source.columns.find((candidate) => !technicalColumns.has(candidate));
  return column ? { kind: "direct", column } : undefined;
};

/** Compiles reviewed mappings into a deterministic, catalog-verified relational execution graph. */
export const compileExecutionManifest = (input: { study: StudySpec; mapping: StudyVariableMappingReview; catalog: ClinicalDatabaseCatalog; allowDatabaseVerified?: boolean }): ExecutionManifest => {
  const blockers: ExecutionManifestBlocker[] = []; const sources = new Map<string, ExecutionManifestSource>(); const variables: ExecutionManifestVariable[] = [];
  for (const assessed of input.mapping.variables) {
    const reviewed = assessed.candidates.filter((candidate) => isCandidateExecutable(candidate, input.allowDatabaseVerified));
    // Time zero is an executable timestamp, never a diagnosis/procedure
    // presence flag. Prefer a reviewed temporal candidate even when lexical
    // matching ranked a disease concept first.
    const candidate = assessed.role === "index_time"
      ? reviewed.find(({ mapping }) => mapping.sources.some((source) => Boolean(buildValueRule("index_time", mapping, source))))
      : reviewed[0];
    if (!candidate) { blockers.push({ code: "MAPPING_UNRESOLVED", role: assessed.role, requested_label: assessed.requested_term, message: `No reviewed mapping is available for ${assessed.requested_term}.` }); continue; }
    const mapping = candidate.mapping; const source = mapping.sources[0];
    if (!source) { blockers.push({ code: "MAPPING_UNRESOLVED", role: assessed.role, requested_label: assessed.requested_term, message: `The reviewed mapping has no source for ${assessed.requested_term}.` }); continue; }
    const catalogRelation = input.catalog.relations.find(({ schema, name }) => schema === source.schema && name === source.table);
    const missing = source.columns.filter((column) => !catalogRelation?.columns.some(({ name }) => name === column));
    if (!catalogRelation || missing.length) { blockers.push({ code: "CATALOG_FIELD_MISSING", role: assessed.role, requested_label: assessed.requested_term, message: `Catalog evidence is missing for ${sourceId(source)}${missing.length ? `: ${missing.join(", ")}` : ""}.` }); continue; }
    const characteristic = Boolean(assessed.condition_id?.startsWith("characteristic.")) && Boolean(input.study.characteristics?.some(({ definition }) => hasCondition(definition, assessed.condition_id)));
    const studyVariable = characteristic ? input.study.characteristics?.find(({ definition }) => hasCondition(definition, assessed.condition_id)) : assessed.role === "outcome" ? input.study.outcome : assessed.role === "exposure" || assessed.role === "predictor" ? input.study.exposure_or_predictors?.find(({ name, definition }) => name === assessed.requested_term || hasCondition(definition, assessed.condition_id)) : assessed.role === "covariate" ? input.study.covariates?.find(({ name, definition }) => name === assessed.requested_term || hasCondition(definition, assessed.condition_id)) : undefined;
    // A yes/no characteristic is present when a record exists in its window, like any event outcome (in-hospital death: a survivor has
    // no death time in the window, which is "no", not missing); its numeric or categorical form is the definition's own.
    const rule = buildValueRule(assessed.role, mapping, source, assessed.semantic_condition); const contrast = studyVariable?.contrast ?? (characteristic && mapping.value_type === "binary" ? { kind: "binary_presence" as const } : undefined); // A yes/no variable of recorded events (vasopressors, ventilation) is present when any record exists.
    const aggregation = studyVariable?.aggregation ?? mapping.definition.aggregation ?? (contrast?.kind === "binary_presence" || (mapping.value_type === "binary" && rule !== undefined && rule.kind !== "direct") ? "any" : contrast?.kind === "as_recorded" ? "first" : undefined);
    if (!rule) { blockers.push({ code: source.dictionary_table ? "DICTIONARY_VALUES_UNRESOLVED" : "MAPPING_UNRESOLVED", role: assessed.role, requested_label: assessed.requested_term, message: `The reviewed mapping does not identify executable values for ${assessed.requested_term}.` }); continue; }
    if (source.dictionary_table && !source.item_ids?.length && !source.codes?.length && !source.value_filters?.some(({ values }) => values.length)) { blockers.push({ code: "DICTIONARY_VALUES_UNRESOLVED", role: assessed.role, requested_label: assessed.requested_term, message: `Dictionary identifiers or codes are not frozen for ${assessed.requested_term}.` }); continue; }
    if (rule.kind === "item_ids" && assessed.role !== "index_time" && assessed.role !== "population" && !aggregation && !mapping.definition.derivation) { blockers.push({ code: "MAPPING_UNRESOLVED", role: assessed.role, requested_label: assessed.requested_term, message: `No aggregation rule is frozen for ${assessed.requested_term}.` }); continue; }
    if (mapping.status === "database_verified" && rule.kind === "direct" && mapping.value_type === "categorical" && assessed.role !== "index_time" && assessed.role !== "population" && contrast?.kind !== "as_recorded") { blockers.push({ code: "MAPPING_UNRESOLVED", role: assessed.role, requested_label: assessed.requested_term, message: `No evidence-backed category values are frozen for ${assessed.requested_term}.` }); continue; }
    const profile = mapping.evidence.data_profile;
    const requestedSemanticCondition = assessed.semantic_condition;
    const semanticCondition = normalizeCategoryCondition(requestedSemanticCondition, mapping);
    const categoryConditionForEvidence = mapping.sources.some((candidateSource) => candidateSource.codes?.length) ? requestedSemanticCondition : semanticCondition;
    // Aggregate evidence backs unreviewed mappings and verifies units/categories of comparisons; a validated or
    // clinician-confirmed mapping used as a presence condition (concept, event) does not need it.
    const presenceCondition = !assessed.semantic_condition || assessed.semantic_condition.kind === "concept" || assessed.semantic_condition.kind === "event_exists";
    const trustedPresence = (mapping.status === "validated" || mapping.status === "clinician_confirmed") && presenceCondition;
    if (assessed.condition_id && !profile && !trustedPresence) { blockers.push({ code: "DATA_EVIDENCE_MISSING", role: assessed.role, condition_id: assessed.condition_id, requested_label: assessed.requested_term, message: `No aggregate local-data evidence is frozen for condition ${assessed.condition_id}.` }); continue; }
    if (profile && profile.matched_record_count === 0) { blockers.push({ code: "NO_MATCHED_RECORDS", role: assessed.role, ...(assessed.condition_id ? { condition_id: assessed.condition_id } : {}), requested_label: assessed.requested_term, message: `The frozen mapping has no matching local records for ${assessed.requested_term}.` }); continue; }
    if (requestedSemanticCondition?.kind === "numeric_comparison" && requestedSemanticCondition.unit && rule.kind === "item_ids" && profile?.units.length && !profile.units.some(({ value }) => value.toLocaleLowerCase() === requestedSemanticCondition.unit!.toLocaleLowerCase())) { blockers.push({ code: "UNIT_CONFLICT", role: assessed.role, ...(assessed.condition_id ? { condition_id: assessed.condition_id } : {}), requested_label: assessed.requested_term, message: `Observed units do not contain the requested unit for condition ${assessed.condition_id}.` }); continue; }
    if (categoryConditionForEvidence?.kind === "category_comparison" && profile && !semanticCodeHintsVerified(mapping) && !categoryConditionForEvidence.values.every((value) => profile.top_values.some((observed) => observed.value.toLocaleLowerCase() === value.toLocaleLowerCase()))) { blockers.push({ code: "CATEGORY_VALUE_UNVERIFIED", role: assessed.role, ...(assessed.condition_id ? { condition_id: assessed.condition_id } : {}), requested_label: assessed.requested_term, message: `One or more requested categories are not present in the privacy-safe aggregate profile for condition ${assessed.condition_id}.` }); continue; }
    const id = sourceId(source); const required = [...new Set([...source.columns, ...identifierPriority.filter((column) => catalogRelation.columns.some(({ name }) => name === column))])];
    sources.set(id, { id, schema: source.schema, table: source.table, required_columns: required });
    const timeColumn = source.columns.find((column) => TIME_COLUMN.test(column));
    const derivation = mapping.definition.derivation;
    if (derivation && !timeColumn) { blockers.push({ code: "DERIVATION_TIME_MISSING", role: assessed.role, requested_label: assessed.requested_term, message: `The derived variable ${assessed.requested_term} requires a verified measurement timestamp.` }); continue; }
    if (derivation && (![derivation.baseline.purpose, derivation.follow_up.purpose].every((purpose) => input.study.time_windows?.some((window) => window.purpose === purpose)))) { blockers.push({ code: "DERIVATION_WINDOW_MISSING", role: assessed.role, requested_label: assessed.requested_term, message: `The derived variable ${assessed.requested_term} requires frozen baseline and follow-up windows.` }); continue; }
    const effectModifier = assessed.role === "covariate" && Boolean(input.study.effect_modifiers?.some(({ variable_name }) => variable_name === assessed.requested_term));
    variables.push({ role: assessed.role, ...(characteristic ? { characteristic: true } : {}), ...(assessed.condition_id ? { condition_id: assessed.condition_id } : {}), ...(semanticCondition ? { semantic_condition: semanticCondition } : {}), requested_label: assessed.requested_term, mapping_id: mapping.mapping_id, mapping_version: mapping.mapping_version, source_id: id, value_type: mapping.value_type, value_rule: rule, ...(profile ? { data_evidence: profile } : {}), ...(contrast ? { contrast } : {}), ...(effectModifier ? { effect_modifier: true } : {}), ...(timeColumn ? { time_column: timeColumn } : {}), temporal_rule: mapping.definition.temporal_rule, ...(aggregation ? { aggregation } : {}), ...(derivation ? { derivation } : {}), ...(mapping.definition.valid_range ? { valid_range: mapping.definition.valid_range } : {}), missingness_rule: mapping.definition.missingness_rule });
  }
  if (input.study.population?.criteria) for (const leaf of listStudyConditions(input.study.population.criteria).filter(({ kind }) => !["all", "any", "not"].includes(kind))) {
    if (!variables.some(({ condition_id }) => condition_id === leaf.condition_id)) blockers.push({ code: "CONDITION_BINDING_MISSING", role: "population", condition_id: leaf.condition_id, requested_label: leaf.source_text, message: `No verified execution binding exists for condition ${leaf.condition_id}.` });
  }
  // A comorbidity score used for adjustment must not contain the exposure (or modifier) it adjusts: drop its overlapping groups.
  const scoreExclusions: ScoreExclusion[] = [];
  const codedInputs = variables.filter((variable) => (variable.role === "exposure" || variable.role === "predictor" || variable.effect_modifier) && variable.value_rule.kind === "codes");
  for (const [position, variable] of variables.entries()) {
    const rule = variable.value_rule;
    if (variable.role !== "covariate" || rule.kind !== "code_score" || variable.effect_modifier) continue;
    for (const input of codedInputs) {
      const codes = input.value_rule.kind === "codes" ? input.value_rule.codes : [];
      const overlapping = rule.groups.filter(({ code_prefixes }) => code_prefixes.some(({ prefix, version }) => codes.some((code) => code.version === version && code.code.startsWith(prefix))));
      if (!overlapping.length) continue;
      const removed = new Set(overlapping.map(({ group_id }) => group_id));
      const current = variables[position]!.value_rule as Extract<ExecutionValueRule, { kind: "code_score" }>;
      variables[position] = { ...variables[position]!, value_rule: { ...current, groups: current.groups.filter(({ group_id }) => !removed.has(group_id)).map((group) => group.supersedes ? { ...group, supersedes: group.supersedes.filter((id) => !removed.has(id)) } : group) } };
      scoreExclusions.push({ variable: variable.requested_label, removed_groups: [...removed], because_of: input.requested_label });
    }
  }
  const sortedSources = [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
  // The analysis unit is the encounter time zero is recorded on: the finest identifier of the table the index time is read
  // from (an ICU admission per ICU stay, a hospital admission per admission), and that table is the root. Chosen by how many
  // tables carry an identifier, an ICU-admission study became one row per hospital admission with the time zero of whichever
  // stay was read first, and a hospital-admission study one row per ICU stay (MIMIC questions 3.3 and 4.4, 2026-10-26).
  const indexSource = sortedSources.find(({ id }) => id === variables.find(({ role }) => role === "index_time")?.source_id);
  const indexColumn = indexSource && identifierPriority.find((key) => indexSource.required_columns.includes(key));
  // Without a time zero, the identifier most tables share.
  const minimumCoverage = Math.max(2, Math.ceil(sortedSources.length / 2));
  const preferredAnalysisColumn = indexColumn ?? identifierPriority.find((key) => sortedSources.filter((source) => source.required_columns.includes(key)).length >= minimumCoverage)
    ?? identifierPriority.find((key) => sortedSources.some((source) => source.required_columns.includes(key)));
  const preferredRootIds = variables.filter(({ role }) => role === "index_time" || role === "population").map(({ source_id }) => source_id);
  const root = indexColumn ? indexSource : preferredAnalysisColumn ? sortedSources.find((source) => preferredRootIds.includes(source.id) && source.required_columns.includes(preferredAnalysisColumn))
    ?? sortedSources.find((source) => source.required_columns.includes(preferredAnalysisColumn)) : undefined;
  const sourceList = root ? [root, ...sortedSources.filter(({ id }) => id !== root.id)] : sortedSources; const joins: ExecutionManifestJoin[] = [];
  // Tables join on the analysis unit's identifier or a coarser one when they share it. An admission-level analysis whose first
  // table also has an ICU stay column (the derived events, whose admission-level events leave it empty) otherwise joined the
  // ICU tables on the stay, and their variables reached no admission (vasopressors and ventilation in readmission analyses).
  const unitKeys = preferredAnalysisColumn ? identifierPriority.slice(identifierPriority.indexOf(preferredAnalysisColumn)) : [...identifierPriority];
  for (let index = 1; index < sourceList.length; index += 1) {
    const right = sourceList[index]!;
    const sharing = (keys: readonly string[]) => sourceList.slice(0, index).find((candidate) => keys.some((key) => candidate.required_columns.includes(key) && right.required_columns.includes(key)));
    const keys = sharing(unitKeys) ? unitKeys : identifierPriority;
    const left = sharing(keys);
    const key = left && keys.find((candidate) => left.required_columns.includes(candidate) && right.required_columns.includes(candidate));
    if (!left || !key) blockers.push({ code: "JOIN_PATH_MISSING", message: `No catalog-backed identifier join connects ${right.id} to the execution graph.` });
    else joins.push({ left_source_id: left.id, right_source_id: right.id, left_column: key, right_column: key, cardinality: "many_to_one" });
  }
  const analysisSource = root;
  const analysisColumn = preferredAnalysisColumn;
  if (!analysisSource || !analysisColumn) blockers.push({ code: "ANALYSIS_UNIT_MISSING", message: "No reviewed source supplies a supported analysis identifier." });
  const outcomeVariable = variables.find(({ role, characteristic }) => role === "outcome" && !characteristic);
  const extraction: ExecutionManifestExtraction = {
    ...(/\bfirst\b|首次/iu.test(input.study.index_time?.selection_rule ?? "") && analysisColumn !== "subject_id" ? { unit_selection: "first_per_subject" as const } : {}),
    ...(input.study.outcome_structure === "time_to_event" && outcomeVariable ? { outcome_timing: { kind: "time_to_event" as const, horizon_days: horizonDays(input.study), follow_up: outcomeVariable.source_id === "mimiciv_hosp.patients" ? "death_registry" as const : "encounter" as const } } : {}),
  };
  const body = { ...(scoreExclusions.length ? { score_exclusions: scoreExclusions } : {}), schema_version: "2.0.0" as const, study_integrity_id: `sha256:${createHash("sha256").update(JSON.stringify(input.study)).digest("hex")}`, data_model: "MIMIC-IV" as const, study_family: input.study.intent_family === "undetermined" ? "association" as const : input.study.intent_family, status: blockers.length ? "blocked" as const : "ready" as const, ...(analysisSource && analysisColumn ? { analysis_unit: { source_id: analysisSource.id, column: analysisColumn } } : {}), sources: sourceList, joins, variables, ...(input.study.population?.criteria ? { population_predicate: input.study.population.criteria } : {}), time_windows: input.study.time_windows, ...(Object.keys(extraction).length ? { extraction } : {}), blockers };
  return { ...body, manifest_id: `manifest:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}` };
};
