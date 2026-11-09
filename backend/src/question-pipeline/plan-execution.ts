import { evaluateFormula, parseFormula } from "../variable-definitions/index.js";
import { acceptKey } from "../question-clarification/index.js";
import { join } from "node:path";
import type { ClinicalDatabaseCatalog } from "../clinical-database/index.js";
import type { LocalExecutionGraphResult } from "../clinical-data/index.js";
import { compileExecutionManifest, type ExecutionManifest } from "../execution-manifest/index.js";
import type { StudyCondition } from "../research-design/index.js";
import type { StudyVariableMappingReview } from "../variable-mapping/index.js";
import type { StudyFrame, CompiledStudyPlan } from "../study-framing/index.js";
import type { StudyProtocol } from "../study-protocol/index.js";
import { checkPlanResult, profileAnalysisColumns, type ColumnProfile, type ResultCheckRules, type ResultQuality } from "../result-checks/index.js";
import { assessMethodReadiness, methodOptions, type AnalysisDatasetProfile, type AnalysisMethodOption, type AnalysisOutcomeType, type MethodReadiness, type StudyMethodConfig, type StudyMethodResult } from "../study-analysis/index.js";

export type PipelineStage = "framing" | "mapping" | "manifest" | "cohort" | "method" | "analysis";
export interface PipelineBlocker { stage: PipelineStage; code: string; message: { en: string; zh: string } }

export interface MappingSummaryVariable {
  role: string;
  /** A described characteristic of a description (mapped with its role's rules, but neither the exposure nor the outcome). */
  characteristic?: boolean;
  requested_term: string;
  status: "resolved" | "needs_confirmation" | "unmapped";
  selected?: { mapping_id: string; label: string; status: string; table: string; identifiers: number; values: string[] };
  candidates: Array<{ mapping_id: string; label: string; table: string; status: string }>;
  reason?: string;
}

/** First eligible units and how many lacked the exposure or outcome, from the extractor's exclusion counts (see patient-flow). */
const selectionOf = (quality: { analysis_units: number; exclusion_reasons?: Record<string, number> | undefined }): { selection?: { first_eligible_units: number; missing_exposure_or_outcome: number } } => {
  const reasons = quality.exclusion_reasons ?? {};
  const missing = reasons.incomplete_required_variables ?? 0;
  if (!missing) return {};
  const first = quality.analysis_units - ["no_time_zero", "ended_before_landmark", "outcome_before_landmark", "outcome_before_prediction_time", "not_in_population", "not_first_eligible_unit_of_patient"].reduce((sum, key) => sum + (reasons[key] ?? 0), 0);
  return first > 0 ? { selection: { first_eligible_units: first, missing_exposure_or_outcome: missing } } : {};
};

/**
 * Why an adjustment variable of the study spec is not in the model: switched off (severity variables are off unless switched
 * on), the exposure itself, in the model as a predictor, a part of a ratio or formula exposure, analysed as the mediator, or not
 * found in MIMIC-IV (an optional variable dropped when mapping).
 */
export interface CovariateNotModelled { name: string; reason: "switched_off" | "exposure" | "predictor" | "exposure_part" | "mediator" | "not_mapped" | "other" }

export interface PlanOutcome {
  plan_id: string;
  frame_id: string;
  exposure_level?: string;
  status: "completed" | "blocked" | "failed";
  stage_reached: PipelineStage;
  study_spec: CompiledStudyPlan["study_spec"];
  mapping?: MappingSummaryVariable[];
  manifest?: { manifest_id: string; status: ExecutionManifest["status"] };
  cohort?: { rows: number; analysis_units: number; excluded_rows: number; exclusion_reasons?: Record<string, number>; cohort_integrity_id: string };
  method_options?: Array<AnalysisMethodOption & { readiness: MethodReadiness }>;
  chosen_method?: string;
  result?: StudyMethodResult;
  /** Aggregate profile of each analysis column (no patient-level values). */
  data_profile?: ColumnProfile[];
  /** Automatic checks of the result: what was measured, against which rule, and whether it passed. */
  quality?: ResultQuality;
  /** Target-trial protocol the plan was confirmed with. */
  protocol?: StudyProtocol;
  /** Comorbidity-score groups removed because they contain the exposure's own codes. */
  score_exclusions?: NonNullable<ExecutionManifest["score_exclusions"]>;
  /** Data-dependent design steps applied at run time, stated in the report (e.g. how a continuous grouping variable was grouped). */
  design_notes?: Array<{ en: string; zh: string }>;
  /** Adjustment variables of the study spec the model did not receive, and why (the report lists the others as adjusted for). */
  covariates_not_modelled?: CovariateNotModelled[];
  /** Set when the confirmed method could not run on the data and another was used. */
  method_note?: { en: string; zh: string };
  blockers: PipelineBlocker[];
}

export interface PlanExecutionDependencies {
  catalog: ClinicalDatabaseCatalog;
  archive_path: string;
  mapping: { assess(spec: CompiledStudyPlan["study_spec"], allowLiveSearch?: boolean): Promise<StudyVariableMappingReview> };
  runner: { run(archivePath: string, manifest: ExecutionManifest): Promise<LocalExecutionGraphResult>; runMany?(archivePath: string, manifests: ExecutionManifest[]): Promise<LocalExecutionGraphResult[]> };
  executor: { run(rows: Array<Record<string, unknown>>, config: StudyMethodConfig, outputDir: string): Promise<StudyMethodResult> };
  output_dir: string;
  /** Result-check rules; without them results are reported unchecked. */
  result_checks?: ResultCheckRules;
  /** Reports each stage of a plan as it starts or finishes, so long runs stay visible. */
  on_stage?: (event: { plan_id: string; stage: PipelineStage; state: "started" | "finished"; detail?: string }) => void;
  /** Chooses among the three options; defaults to the first available (the recommended one when possible). */
  choose_method?: (plan: CompiledStudyPlan, options: Array<AnalysisMethodOption & { readiness: MethodReadiness }>) => string | undefined;
}

/** The frozen codes, item ids or drug labels a mapping executes, so reports show exactly what was counted. */
const frozenValues = (mapping: StudyVariableMappingReview["variables"][number]["candidates"][number]["mapping"]): string[] => mapping.sources.flatMap((source) => [
  ...(source.codes ?? []).map(({ code, version }) => `ICD-${version} ${code}`),
  ...(source.item_ids ?? []).map((id) => `itemid ${id}`),
  ...(source.value_filters ?? []).flatMap(({ values }) => values),
  ...(!source.codes?.length && !source.item_ids?.length && !source.value_filters?.length ? source.columns.filter((column) => !["subject_id", "hadm_id", "stay_id"].includes(column)).map((column) => `${source.table}.${column}`) : []),
]).slice(0, 60);

const summarizeMapping = (review: StudyVariableMappingReview): MappingSummaryVariable[] => review.variables.map((variable) => {
  const selected = variable.status === "resolved" ? variable.candidates[0]?.mapping : undefined;
  const source = (mapping: NonNullable<typeof selected>) => mapping.sources[0];
  const identifiers = (mapping: NonNullable<typeof selected>): number => mapping.sources.reduce((count, item) => count + (item.codes?.length ?? 0) + (item.item_ids?.length ?? 0) + (item.value_filters?.reduce((sum, filter) => sum + filter.values.length, 0) ?? 0), 0);
  return {
    role: variable.role, ...(variable.condition_id?.startsWith("characteristic.") ? { characteristic: true } : {}), requested_term: variable.requested_term, status: variable.status,
    ...(selected ? { selected: { mapping_id: selected.mapping_id, label: selected.labels.en, status: selected.status, table: `${source(selected)?.schema}.${source(selected)?.table}`, identifiers: identifiers(selected), values: frozenValues(selected) } } : {}),
    candidates: variable.candidates.slice(0, 3).map(({ mapping }) => ({ mapping_id: mapping.mapping_id, label: mapping.labels.en, table: `${mapping.sources[0]?.schema}.${mapping.sources[0]?.table}`, status: mapping.status })),
    ...(variable.reason ? { reason: variable.reason } : {}),
  };
});

export const outcomeTypeOf = (plan: CompiledStudyPlan): AnalysisOutcomeType => {
  const structure = plan.study_spec.outcome_structure;
  return structure === "time_to_event" ? "time_to_event" : structure === "continuous" ? "continuous" : structure === "count" ? "count" : "binary";
};

/** Aggregate profile of the projected rows; used only for method readiness. `described`: a description, which has no outcome and so no events. */
export const profileDataset = (rows: Array<Record<string, unknown>>, config: Pick<StudyMethodConfig, "covariates" | "modifier" | "mediator" | "predictors">, outcomeType: AnalysisOutcomeType, described = false): AnalysisDatasetProfile => {
  const truthy = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "true";
  const exposures = rows.map((row) => row.exposure).filter((value) => value !== undefined && value !== null && value !== "");
  const distinct = new Set(exposures.map(String));
  const binaryExposure = exposures.length > 0 && [...distinct].every((value) => ["true", "false", "0", "1"].includes(value));
  const numericExposure = !binaryExposure && exposures.length > 0 && exposures.every((value) => Number.isFinite(Number(value)));
  const outcomeEvents = described ? undefined : outcomeType === "binary" ? (() => { const positive = rows.filter((row) => truthy(row.outcome)).length; return Math.min(positive, rows.length - positive); })()
    : outcomeType === "time_to_event" ? rows.filter((row) => truthy(row.event)).length : undefined;
  const modifierLevels = config.modifier ? [...rows.reduce((counts, row) => counts.set(String(row[config.modifier!]), (counts.get(String(row[config.modifier!])) ?? 0) + 1), new Map<string, number>()).values()] : undefined;
  return {
    rows: rows.length, outcome_type: outcomeType,
    ...(outcomeEvents !== undefined ? { events: outcomeEvents } : {}),
    ...(exposures.length ? { exposure_kind: binaryExposure ? "binary" as const : numericExposure && distinct.size > 5 ? "continuous" as const : "categorical" as const } : {}),
    ...(binaryExposure ? { exposure_group_sizes: [exposures.filter(truthy).length, exposures.filter((value) => !truthy(value)).length] } : {}),
    covariates: config.covariates.length,
    ...(modifierLevels ? { modifier_levels: modifierLevels } : {}),
    has_mediator: Boolean(config.mediator),
    predictors: config.predictors?.length ?? 0,
    has_time_to_event: rows.some((row) => row.time !== undefined && row.event !== undefined),
  };
};

/**
 * The study spec's adjustment variables the model will not receive as adjustment, known from the plan before any data:
 * switched off, the exposure itself or a predictor, a part of a ratio or formula exposure, and the mediator that is analysed
 * (the first one, as methodConfigFor takes it). The protocol and an outcome without a cohort use it; a cohort replaces it with
 * covariatesNotModelled.
 */
export const plannedNotModelled = (plan: CompiledStudyPlan): CovariateNotModelled[] => {
  const lower = (name: string): string => name.toLowerCase();
  const off = new Set((plan.roles.excluded_covariates ?? plan.roles.severity_off ?? []).map(lower));
  const named = (role: "exposure" | "predictor") => new Set((plan.study_spec.exposure_or_predictors ?? []).filter((variable) => variable.role === role).map(({ name }) => lower(name)));
  const exposures = named("exposure"); const predictors = named("predictor");
  const parts = new Set([...(plan.roles.ratio ? [plan.roles.ratio.denominator] : []), ...(plan.roles.formula?.variables.slice(1).map(({ label }) => label) ?? [])].map(lower));
  const mediators = new Set(plan.roles.mediators.map(lower));
  const analysedMediator = (plan.study_spec.covariates ?? []).find(({ name }) => mediators.has(lower(name)))?.name;
  return (plan.study_spec.covariates ?? []).flatMap(({ name }): CovariateNotModelled[] => {
    const key = lower(name);
    const reason = analysedMediator && key === lower(analysedMediator) ? "mediator" : parts.has(key) ? "exposure_part" : off.has(key) ? "switched_off" : exposures.has(key) ? "exposure" : predictors.has(key) ? "predictor" : undefined;
    return reason ? [{ name, reason }] : [];
  });
};

/**
 * What the model will receive, from a frozen manifest before any data: the columns the extractor will emit (role, label,
 * mapping and summary of each variable), so two names of one mapping (exposure "Gender", covariate "Sex") are seen as one
 * variable, as methodConfigFor sees them. Without a manifest, plannedNotModelled is the best that is known.
 */
export const manifestNotModelled = (plan: CompiledStudyPlan, manifest: ExecutionManifest | undefined, methodId: string | undefined): CovariateNotModelled[] => {
  if (!manifest || !methodId) return plannedNotModelled(plan);
  const counters: Record<string, number> = {};
  const columnOf = (variable: ExecutionManifest["variables"][number]): string => {
    const role = variable.characteristic ? "characteristic" : variable.role === "exposure" || variable.role === "outcome" ? variable.role : variable.effect_modifier ? "effect_modifier" : variable.role;
    if (role === "exposure" || role === "outcome") return role;
    const index = counters[role] ?? 0; counters[role] = index + 1; return `${role}_${index}`;
  };
  const columns = manifest.variables.filter(({ role }) => role !== "population" && role !== "index_time").map((variable) => ({ column: columnOf(variable), role: variable.role, ...(variable.characteristic ? { characteristic: true } : {}), requested_label: variable.requested_label, mapping_id: variable.mapping_id, value_type: variable.value_type, ...(variable.aggregation ? { aggregation: variable.aggregation } : {}) }));
  const cohort = { rows: [], columns, quality: { source_rows: {}, analysis_units: 0, complete_rows: 0, excluded_rows: 0, exclusion_reasons: {} }, cohort_integrity_id: "manifest" };
  return covariatesNotModelled(plan, cohort, methodConfigFor(plan, cohort, methodId));
};

/** An outcome with its not-modelled list replaced (none listed when the model receives every adjustment variable). */
export const withNotModelled = <T extends { covariates_not_modelled?: CovariateNotModelled[] }>(outcome: T, list: CovariateNotModelled[]): T => {
  const { covariates_not_modelled: _replaced, ...rest } = outcome;
  return (list.length ? { ...rest, covariates_not_modelled: list } : rest) as T;
};

/** The study spec's adjustment variables the model did not receive (a variable sharing the mapping of one it received is in it). */
const covariatesNotModelled = (plan: CompiledStudyPlan, cohort: Pick<LocalExecutionGraphResult, "columns">, config: StudyMethodConfig): CovariateNotModelled[] => {
  const columns = cohort.columns ?? [];
  const modelled = new Set(config.covariates ?? []);
  const modelledVariables = new Set(columns.filter(({ column }) => modelled.has(column)).map(variableKey));
  const off = new Set((plan.roles.excluded_covariates ?? plan.roles.severity_off ?? []).map((name) => name.toLowerCase()));
  const parts = new Set([...(plan.roles.ratio ? [ratioDenominatorColumn(plan, cohort)] : []), ...(formulaPartColumns(plan, cohort)?.values() ?? [])].filter(Boolean));
  const exposures = new Set(columns.filter(({ role }) => role === "exposure").map(({ mapping_id }) => mapping_id)); const predictors = new Set(columns.filter(({ role }) => role === "predictor").map(({ mapping_id }) => mapping_id));
  return (plan.study_spec.covariates ?? []).flatMap(({ name }): CovariateNotModelled[] => {
    const column = columns.find(({ role, requested_label }) => role === "covariate" && requested_label.toLowerCase() === name.toLowerCase());
    if (!column) return [{ name, reason: "not_mapped" }];
    if (modelled.has(column.column) || modelledVariables.has(variableKey(column))) return [];
    const reason = column.column === config.mediator ? "mediator" : parts.has(column.column) ? "exposure_part" : off.has(name.toLowerCase()) ? "switched_off" : exposures.has(column.mapping_id) ? "exposure" : predictors.has(column.mapping_id) ? "predictor" : "other";
    return [{ name, reason }];
  });
};

/** The column holding a ratio plan's denominator (a covariate named after the denominator concept). */
const ratioDenominatorColumn = (plan: CompiledStudyPlan, cohort: Pick<LocalExecutionGraphResult, "columns">): string | undefined =>
  (cohort.columns ?? []).find(({ role, requested_label }) => role === "covariate" && requested_label.toLowerCase() === plan.roles.ratio!.denominator.toLowerCase())?.column;

/** The columns of a formula plan's helper parts (every part but the first, which is the exposure), by variable name. */
const formulaPartColumns = (plan: CompiledStudyPlan, cohort: Pick<LocalExecutionGraphResult, "columns">): Map<string, string> | undefined => {
  const formula = plan.roles.formula; if (!formula) return undefined;
  const found = new Map<string, string>();
  for (const variable of formula.variables.slice(1)) {
    const column = (cohort.columns ?? []).find(({ role, requested_label }) => role === "covariate" && requested_label.toLowerCase() === variable.label.toLowerCase())?.column;
    if (!column) return undefined;
    found.set(variable.name, column);
  }
  return found;
};

/**
 * For a ratio plan, replaces the exposure (the numerator) with numerator ÷ denominator per patient; a missing or zero
 * denominator leaves the exposure missing. For a formula plan the exposure (the first part) becomes the formula over all
 * parts, evaluated by the arithmetic parser of the variable definitions; a patient missing a part has no exposure.
 * Returns new rows: cohorts can be shared between plans.
 */
export const applyRatioExposure = (plan: CompiledStudyPlan, cohort: LocalExecutionGraphResult): LocalExecutionGraphResult => {
  const parts = formulaPartColumns(plan, cohort);
  if (plan.roles.formula && parts) {
    const { tree } = parseFormula(plan.roles.formula.expression); const first = plan.roles.formula.variables[0]!.name;
    const rows = cohort.rows.map((row) => {
      const values: Record<string, number | undefined> = { [first]: row.exposure === undefined || row.exposure === null ? undefined : Number(row.exposure) };
      for (const [name, column] of parts) values[name] = row[column] === undefined || row[column] === null ? undefined : Number(row[column]);
      const value = evaluateFormula(tree, values); const { exposure: _exposure, ...rest } = row;
      return Number.isFinite(value) ? { ...rest, exposure: value } : rest;
    });
    return { ...cohort, rows };
  }
  const denominator = plan.roles.ratio ? ratioDenominatorColumn(plan, cohort) : undefined;
  if (!plan.roles.ratio || !denominator) return cohort;
  const rows = cohort.rows.map((row) => {
    const numerator = Number(row.exposure); const divisor = Number(row[denominator]);
    const { exposure: _exposure, ...rest } = row;
    return row.exposure !== undefined && row.exposure !== null && Number.isFinite(numerator) && Number.isFinite(divisor) && divisor !== 0 ? { ...rest, exposure: numerator / divisor } : rest;
  });
  return { ...cohort, rows };
};

// Plain ASCII labels: group labels travel through CSV into R and back.
const AGE_BANDS = [{ upper: 45, label: "18-44" }, { upper: 65, label: "45-64" }, { upper: 80, label: "65-79" }, { upper: Number.POSITIVE_INFINITY, label: "80+" }];
/**
 * A group comparison whose grouping variable is continuous ("by age group") compares groups: age uses the bands
 * 18–44, 45–64, 65–79 and ≥80; any other variable uses quartiles. Returns new rows and the note for the report.
 */
/** Groups a continuous column: age into bands, anything else into quartiles; undefined when it is not continuous. */
const groupContinuous = (cohort: LocalExecutionGraphResult, column: string, label: string, described = false): { cohort: LocalExecutionGraphResult; note: { en: string; zh: string } } | undefined => {
  // A missing value (null, undefined or empty) is not a 0: a description keeps units without the grouping value, and they stay ungrouped.
  const recorded = (value: unknown): boolean => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const values = cohort.rows.filter((row) => recorded(row[column])).map((row) => Number(row[column]));
  // Mostly numeric among the units where it is recorded (a description keeps units without it), with more than five values.
  const present = cohort.rows.filter((row) => row[column] !== null && row[column] !== undefined && row[column] !== "").length;
  if (!values.length || values.length < present * 0.5 || new Set(values).size <= 5) return undefined;
  const isAge = /\bage\b|年龄/iu.test(label);
  const sorted = [...values].sort((a, b) => a - b);
  const quartiles = [0.25, 0.5, 0.75].map((p) => sorted[Math.floor(p * (sorted.length - 1))]!);
  const round = (value: number): string => Number(value.toPrecision(3)).toString();
  const bands = isAge ? AGE_BANDS : [
    { upper: quartiles[0]!, label: `Q1 (<=${round(quartiles[0]!)})` }, { upper: quartiles[1]!, label: `Q2 (<=${round(quartiles[1]!)})` },
    { upper: quartiles[2]!, label: `Q3 (<=${round(quartiles[2]!)})` }, { upper: Number.POSITIVE_INFINITY, label: `Q4 (>${round(quartiles[2]!)})` }];
  const group = (value: number): string => (isAge ? bands.find(({ upper }) => value < upper) : bands.find(({ upper }) => value <= upper))!.label;
  const rows = cohort.rows.map((row) => recorded(row[column]) ? { ...row, [column]: group(Number(row[column])) } : row);
  const names = bands.map(({ label: band }) => band).join(", ");
  const verb = described ? { en: "described", zh: "描述" } : { en: "compared", zh: "比较" };
  return { cohort: { ...cohort, rows }, note: isAge
    ? { en: `${label} is ${verb.en} in the groups ${names} years.`, zh: `${label}按 ${names} 岁分组${verb.zh}。` }
    : { en: `${label} is continuous, so it is ${verb.en} in quartiles: ${names}.`, zh: `${label}为连续变量，按四分位数分组${verb.zh}：${names}。` } };
};

/**
 * A continuous grouping variable ("by age group") or effect modifier ("differ by age") is compared in groups: age
 * uses the bands 18-44, 45-64, 65-79 and 80+; any other variable uses quartiles. Returns new rows and the report note.
 */
export const applyGrouping = (frame: StudyFrame, cohort: LocalExecutionGraphResult, modifierColumn?: string): { cohort: LocalExecutionGraphResult; note?: { en: string; zh: string } } => {
  const columns = cohort.columns ?? [];
  // A description grouped by a continuous variable ("按年龄段描述") describes the same bands or quartiles.
  const target = frame.study_type === "group_comparison" || frame.study_type === "descriptive" ? columns.find(({ role }) => role === "exposure")
    : frame.study_type === "effect_modification" && modifierColumn ? columns.find(({ column }) => column === modifierColumn) : undefined;
  if (!target) return { cohort };
  return groupContinuous(cohort, target.column, target.requested_label, frame.study_type === "descriptive") ?? { cohort };
};

/** The variable a column holds: its mapping read with its summary (columns of one mapping with one summary hold the same values). */
const variableKey = ({ mapping_id, aggregation }: { mapping_id: string; aggregation?: string | undefined }): string => `${mapping_id}|${aggregation ?? ""}`;

/** Builds the R config from the runner's column metadata and the plan's declared roles. */
export const methodConfigFor = (plan: CompiledStudyPlan, cohort: LocalExecutionGraphResult, methodId: string): StudyMethodConfig => {
  const columns = cohort.columns ?? [];
  const byLabel = (labels: string[]) => columns.filter(({ requested_label, role }) => role === "covariate" && labels.some((label) => label.toLowerCase() === requested_label.toLowerCase())).map(({ column }) => column);
  const modifier = byLabel(plan.roles.modifiers)[0];
  const mediator = byLabel(plan.roles.mediators)[0];
  // Two study variables resolved to the same MIMIC mapping (e.g. "Sex" and "gender") are one adjustment variable.
  // The exposure or predictors themselves are never adjustment variables (e.g. Age as the exposure and a default covariate).
  const denominator = plan.roles.ratio ? ratioDenominatorColumn(plan, cohort) : undefined;
  const formulaColumns = new Set(formulaPartColumns(plan, cohort)?.values() ?? []);
  // Switched-off adjustment variables (the user's choice, or severity variables off by default) are not modelled.
  const off = new Set((plan.roles.excluded_covariates ?? plan.roles.severity_off ?? []).map((name) => name.toLowerCase()));
  // A description's characteristics are described, never adjusted for; a Table 1 variable they repeat is listed once, as the characteristic.
  // The exposure, predictors and the variables that make up or carry them reserve their whole mapping (an exposure "age" read
  // as its first value and the default covariate Age are one variable). Among adjustment variables, one variable is one
  // mapping read with one summary: a change outcome's baseline mean is not the severity maximum, and is kept when that
  // severity variable is switched off.
  const reservedMappings = new Set(columns.filter(({ column, role, characteristic }) => characteristic || column === modifier || column === mediator || column === denominator || formulaColumns.has(column) || role === "exposure" || role === "predictor").map(({ mapping_id }) => mapping_id));
  const switchedOff = new Set(columns.filter(({ role, requested_label }) => role === "covariate" && off.has(requested_label.toLowerCase())).map(variableKey));
  const seen = new Set<string>();
  const covariates = columns.filter((candidate) => {
    const { role, column, characteristic, mapping_id } = candidate; const key = variableKey(candidate);
    if (role !== "covariate" || characteristic || column === mediator || column === modifier || reservedMappings.has(mapping_id) || switchedOff.has(key) || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(({ column }) => column);
  const exposureMapping = columns.find(({ role }) => role === "exposure")?.mapping_id;
  const described = new Set<string>();
  const characteristics = columns.filter(({ characteristic, mapping_id }) => {
    if (!characteristic || mapping_id === exposureMapping || described.has(mapping_id)) return false;
    described.add(mapping_id); return true;
  }).map(({ column }) => column);
  const predictors = columns.filter(({ role }) => role === "predictor").map(({ column }) => column);
  const exposureVariable = plan.study_spec.exposure_or_predictors?.find(({ role }) => role === "exposure");
  const groupLabel = exposureVariable?.definition?.kind === "any" ? plan.study_spec.estimand?.exposure_contrast : undefined;
  return {
    method_id: methodId, outcome_type: outcomeTypeOf(plan),
    // A modifier is also adjusted for in the main-effect models.
    covariates: modifier ? [...covariates, modifier] : covariates,
    ...(modifier ? { modifier } : {}), ...(mediator ? { mediator } : {}),
    ...(predictors.length ? { predictors } : {}),
    ...(characteristics.length ? { characteristics } : {}),
    // An exposure written as a group of drugs is labelled as the comparison, not by its last drug.
    labels: Object.fromEntries(columns.map(({ column, requested_label }) => [column, column === "exposure" && plan.roles.ratio ? plan.roles.ratio.label : column === "exposure" && plan.roles.formula ? plan.roles.formula.label : column === "exposure" && groupLabel ? groupLabel : requested_label])),
    time_unit: "days",
  };
};

/** A fitting error that means "too few patients" is said in plain words, with the original message kept. */
const TOO_FEW = /xlim|finite|singular|not enough|fewer|no observations/iu;
const friendlyFailure = (error: string | undefined): string => !error ? "The statistical method failed." : TOO_FEW.test(error) ? `The model could not be fitted, usually because one group has too few patients (technical message: ${error}).` : error;
const friendlyFailureZh = (error: string | undefined): string => !error ? "" : TOO_FEW.test(error) ? `模型无法拟合，通常是因为某一组患者太少（技术信息：${error}）。` : error;

/** Removes the listed leaves from a condition tree (and any group left empty); returns undefined when nothing remains. */
export const pruneConditions = (condition: StudyCondition, drop: Set<string>): StudyCondition | undefined => {
  if (condition.kind === "all" || condition.kind === "any") {
    const operands = condition.operands.map((operand) => pruneConditions(operand, drop)).filter((operand): operand is StudyCondition => Boolean(operand));
    return operands.length ? { ...condition, operands } : undefined;
  }
  if (condition.kind === "not") { const operand = pruneConditions(condition.operand, drop); return operand ? { ...condition, operand } : undefined; }
  return drop.has(condition.condition_id) ? undefined : condition;
};

/** The requested outcome term when the outcome and the population resolved to the same mapping, otherwise undefined. */
export const outcomeIsPopulation = (mapping: Array<{ role: string; requested_term: string; selected?: { mapping_id: string } | undefined }>): string | undefined => {
  const population = mapping.find(({ role }) => role === "population")?.selected?.mapping_id;
  const outcome = mapping.find(({ role }) => role === "outcome");
  return population && outcome?.selected?.mapping_id === population ? outcome.requested_term : undefined;
};

/** A plan whose variables are mapped and whose execution manifest is frozen; running it reads data only. */
export interface PreparedPlan {
  kind: "prepared"; mapping: MappingSummaryVariable[]; manifest: ExecutionManifest;
  /** The plan's StudySpec without optional variables that could not be mapped (they are named in `dropped`). */
  study_spec?: CompiledStudyPlan["study_spec"]; dropped?: string[];
}

const planHelpers = (plan: CompiledStudyPlan, dependencies: Pick<PlanExecutionDependencies, "on_stage">) => {
  // Before a cohort exists the plan says which variables will not be adjusted for; a cohort replaces it with what the model receives.
  const planned = plannedNotModelled(plan);
  const base = { plan_id: plan.plan_id, frame_id: plan.frame_id, ...(plan.exposure_level ? { exposure_level: plan.exposure_level } : {}), study_spec: plan.study_spec, ...(planned.length ? { covariates_not_modelled: planned } : {}) };
  const blocked = (stage: PipelineStage, blockers: PipelineBlocker[], extra: Partial<PlanOutcome> = {}): PlanOutcome => ({ ...base, ...extra, status: "blocked", stage_reached: stage, blockers });
  const stage = (name: PipelineStage, state: "started" | "finished", detail?: string): void => dependencies.on_stage?.({ plan_id: plan.plan_id, stage: name, state, ...(detail ? { detail } : {}) });
  return { base, blocked, stage };
};

/** Runs one compiled plan from mapping to statistical result, stopping at the first blocking stage. */
export const executePlan = async (plan: CompiledStudyPlan, frame: StudyFrame, dependencies: PlanExecutionDependencies): Promise<PlanOutcome> => {
  const prepared = await preparePlan(plan, dependencies);
  return prepared.kind === "prepared" ? runPreparedPlan(prepared.study_spec ? { ...plan, study_spec: prepared.study_spec } : plan, frame, prepared, dependencies) : prepared;
};

/** Maps a plan's variables and freezes its execution manifest without reading patient data. */
/** `accepted`: variables (role and term, see acceptKey) whose broader concept the researcher accepted although it does not carry every word of the term. */
export const preparePlan = async (plan: CompiledStudyPlan, dependencies: Pick<PlanExecutionDependencies, "mapping" | "catalog" | "on_stage">, accepted?: ReadonlySet<string>): Promise<PreparedPlan | (PlanOutcome & { kind?: undefined })> => {
  const { blocked, stage } = planHelpers(plan, dependencies);
  stage("mapping", "started");
  const reviewed = await dependencies.mapping.assess(plan.study_spec, true);
  const variables = accepted?.size ? reviewed.variables.map((variable) => variable.status === "needs_confirmation" && variable.candidates.length && accepted.has(acceptKey(variable.role, variable.requested_term))
    ? { ...variable, status: "resolved" as const, candidates: [{ ...variable.candidates[0]!, requires_clinician_confirmation: false }] } : variable) : reviewed.variables;
  const assessed = variables === reviewed.variables ? reviewed : { ...reviewed, variables, status: variables.every(({ status }) => status === "resolved") ? "ready" as const : reviewed.status,
    summary: { ...reviewed.summary, resolved: variables.filter(({ status }) => status === "resolved").length, needs_confirmation: variables.filter(({ status }) => status === "needs_confirmation").length } };
  // Optional adjustment variables (illness severity) that cannot be mapped are left out instead of blocking the plan.
  const optional = new Set((plan.roles.severity ?? []).map((name) => name.toLowerCase()));
  const droppable = assessed.variables.filter((variable) => variable.role === "covariate" && variable.status !== "resolved" && optional.has(variable.requested_term.toLowerCase()));
  const dropped = [...new Set(droppable.map(({ requested_term }) => requested_term))];
  // A drug listed among the levels of the comparison that has no record in MIMIC-IV is left out of the population, with a note;
  // the plan of that drug itself stays blocked. Without this one absent drug would block every plan of the question.
  const absent = assessed.variables.filter((variable) => variable.role === "population" && variable.status === "unmapped" && /^population\.(?:level|exposed|comparator)(?:_b)?\d+$/u.test(variable.condition_id ?? ""));
  const absentIds = new Set(absent.map(({ condition_id }) => condition_id!));
  const absentNames = [...new Set(absent.map(({ requested_term }) => requested_term))];
  const withoutAbsent = (variables: typeof assessed.variables) => variables.filter((variable) => !absent.includes(variable));
  const review = dropped.length || absent.length ? { ...assessed, variables: withoutAbsent(assessed.variables.filter((variable) => !droppable.includes(variable))) } : assessed;
  const populationCriteria = plan.study_spec.population?.criteria;
  const prunedCriteria = absent.length && populationCriteria ? pruneConditions(populationCriteria, absentIds) : populationCriteria;
  const pruneNote = absentNames.length ? [`${absentNames.join(", ")} has no record in MIMIC-IV and is left out of the comparison.`] : [];
  const studySpec = absent.length && !dropped.length ? { ...plan.study_spec, ...(prunedCriteria && plan.study_spec.population ? { population: { ...plan.study_spec.population, criteria: prunedCriteria } } : {}), assumptions: [...(plan.study_spec.assumptions ?? []), ...pruneNote] }
    : dropped.length ? { ...plan.study_spec, ...(absent.length && prunedCriteria && plan.study_spec.population ? { population: { ...plan.study_spec.population, criteria: prunedCriteria } } : {}), covariates: (plan.study_spec.covariates ?? []).filter(({ name }) => !dropped.some((term) => term.toLowerCase() === name.toLowerCase())),
    assumptions: [...(plan.study_spec.assumptions ?? []), ...pruneNote, `Severity variable(s) ${dropped.join(", ")} could not be mapped to MIMIC-IV and are not used.`] } : plan.study_spec;
  const mapping = summarizeMapping(review);
  stage("mapping", "finished", `${mapping.filter(({ status }) => status === "resolved").length}/${mapping.length} variables resolved`);
  const unresolved = mapping.filter(({ status }) => status !== "resolved");
  if (unresolved.length) {
    return blocked("mapping", unresolved.map((variable) => ({
      stage: "mapping", code: variable.status === "unmapped" ? "VARIABLE_UNMAPPED" : "VARIABLE_CONFIRMATION_REQUIRED",
      message: {
        en: `${variable.role} “${variable.requested_term}”: ${variable.status === "unmapped" ? "no MIMIC-IV dictionary entry or field was found" : `${variable.candidates.length} candidate(s) need confirmation`}${variable.reason ? ` (${variable.reason})` : ""}.`,
        zh: `${variable.role}“${variable.requested_term}”：${variable.status === "unmapped" ? "未在 MIMIC-IV 字典或字段中找到对应项" : `有 ${variable.candidates.length} 个候选映射需要确认`}。`,
      },
    })), { mapping });
  }

  const repeated = outcomeIsPopulation(mapping.filter(({ characteristic }) => !characteristic));
  if (repeated) {
    return blocked("mapping", [{ stage: "mapping", code: "OUTCOME_IS_POPULATION", message: {
      en: `The outcome “${repeated}” resolves to the same diagnosis that defines the study population, so it is true by definition for almost every patient. A new event after discharge (for example readmission) is needed, and this design follows one admission only.`,
      zh: `结局“${repeated}”与定义研究人群的诊断相同，对几乎所有患者按定义都成立。需要出院后的新事件（例如再入院），而本设计只随访单次住院。`,
    } }], { mapping });
  }

  // The prediction methods model a yes/no outcome only (study_methods.R run_prediction); a numeric, count or time-to-event outcome
  // stops here with the reason, not after the plan was shown and locked.
  const predictedType = outcomeTypeOf(plan);
  if (plan.study_spec.intent_family === "prediction" && predictedType !== "binary") {
    const kind = { continuous: ["a numeric", "数值"], count: ["a count", "计数"], time_to_event: ["a time-to-event", "生存时间"] }[predictedType];
    return blocked("method", [{ stage: "method", code: "PREDICTION_OUTCOME_NOT_BINARY", message: {
      en: `Prediction is available for a yes/no outcome only; “${plan.study_spec.outcome?.name ?? "the outcome"}” is ${kind[0]} outcome. A cut-off (for example “length of stay of 7 days or more”) makes it a yes/no outcome.`,
      zh: `预测只支持是/否结局；“${plan.study_spec.outcome?.name ?? "结局"}”是${kind[1]}结局。给出切点（例如“住院 7 天及以上”）即可变为是/否结局。`,
    } }], { mapping });
  }

  const manifest = compileExecutionManifest({ study: studySpec, mapping: review, catalog: dependencies.catalog, allowDatabaseVerified: true });
  if (manifest.status !== "ready") {
    return blocked("manifest", manifest.blockers.map((blocker) => ({ stage: "manifest", code: blocker.code, message: { en: blocker.message, zh: `执行清单无法生成：${blocker.message}` } })), { mapping, manifest: { manifest_id: manifest.manifest_id, status: manifest.status } });
  }

  return { kind: "prepared", mapping, manifest, ...(dropped.length ? { study_spec: studySpec, dropped } : {}) };
};

/**
 * The extractor counts a row as incomplete when any extracted variable is missing, including adjustment variables the plan
 * switched off. The patient flow should drop only rows missing a variable the model uses, so that step is recounted here.
 */
export const modelledExclusions = (cohort: { rows: Array<Record<string, unknown>>; columns?: Array<{ column: string }>; quality: { excluded_rows: number; exclusion_reasons?: Record<string, number> } }, config: { covariates: string[]; modifier?: string; mediator?: string; predictors?: string[] }): { excluded_rows: number; exclusion_reasons?: Record<string, number> } => {
  const reasons = cohort.quality.exclusion_reasons;
  if (!reasons?.incomplete_model_variables) return { excluded_rows: cohort.quality.excluded_rows, ...(reasons ? { exclusion_reasons: reasons } : {}) };
  const present = new Set(cohort.columns?.map(({ column }) => column));
  const used = [...new Set(["exposure", "outcome", ...config.covariates, ...(config.modifier ? [config.modifier] : []), ...(config.mediator ? [config.mediator] : []), ...(config.predictors ?? [])])].filter((column) => present.has(column));
  const missing = cohort.rows.filter((row) => used.some((column) => row[column] === undefined || row[column] === null || row[column] === "")).length;
  const { incomplete_model_variables: before, ...rest } = reasons;
  return { excluded_rows: cohort.quality.excluded_rows - before + missing, exclusion_reasons: { ...rest, ...(missing ? { incomplete_model_variables: missing } : {}) } };
};

/** Reads the cohort for a prepared plan and runs the chosen method; no model call and no re-mapping. */
export const runPreparedPlan = async (plan: CompiledStudyPlan, frame: StudyFrame, prepared: PreparedPlan, dependencies: PlanExecutionDependencies): Promise<PlanOutcome> => {
  const helpers = planHelpers(plan, dependencies); const { blocked, stage } = helpers;
  const { mapping, manifest } = prepared;
  const base0 = { ...helpers.base, ...(manifest.score_exclusions?.length ? { score_exclusions: manifest.score_exclusions } : {}) };
  stage("cohort", "started", `${manifest.sources.length} MIMIC tables`);
  const extracted = applyRatioExposure(plan, await dependencies.runner.run(dependencies.archive_path, manifest));
  const grouped = applyGrouping(frame, extracted, frame.study_type === "effect_modification" ? methodConfigFor(plan, extracted, "probe").modifier : undefined);
  const cohort = grouped.cohort;
  const base = { ...base0, ...(grouped.note ? { design_notes: [grouped.note] } : {}) };
  stage("cohort", "finished", `${cohort.rows.length} analysis rows`);
  const cohortSummary = { rows: cohort.rows.length, analysis_units: cohort.quality.analysis_units, ...modelledExclusions(cohort, methodConfigFor(plan, cohort, "probe")), cohort_integrity_id: cohort.cohort_integrity_id };
  // With a cohort, what the model receives is known from its columns (a description models nothing).
  const described = frame.study_type === "descriptive";
  const notModelledBy = (methodId: string): CovariateNotModelled[] => described ? [] : covariatesNotModelled(plan, cohort, methodConfigFor(plan, cohort, methodId));
  if (plan.study_spec.outcome_structure === "time_to_event" && !cohort.rows.some((row) => "time" in row && "event" in row)) {
    return withNotModelled(blocked("cohort", [{ stage: "cohort", code: "TIME_TO_EVENT_EXTRACTION_UNAVAILABLE", message: { en: "The cohort extractor does not yet produce follow-up time and event status for this outcome.", zh: "当前队列提取尚不能为该结局生成随访时间与事件状态。" } }], { mapping, manifest: { manifest_id: manifest.manifest_id, status: manifest.status }, cohort: cohortSummary }), notModelledBy("probe"));
  }

  const outcomeType = outcomeTypeOf(plan);
  const probe = methodConfigFor(plan, cohort, "probe");
  const profile = profileDataset(cohort.rows, probe, outcomeType, described);
  const options = methodOptions(frame.study_type, outcomeType, frame.facets.goal).map((option) => ({ ...option, readiness: assessMethodReadiness(option, profile) }));
  const chosen = dependencies.choose_method?.(plan, options) ?? options.find(({ readiness }) => readiness.available)?.method_id;
  const context = { mapping, manifest: { manifest_id: manifest.manifest_id, status: manifest.status }, cohort: cohortSummary, method_options: options };
  if (!chosen) {
    return withNotModelled(blocked("method", [{ stage: "method", code: "NO_METHOD_READY", message: { en: `None of the three methods can run on this cohort: ${options[0]!.readiness.reasons.map(({ en }) => en).join(" ")}`, zh: `三种方法均无法在该队列上运行：${options[0]!.readiness.reasons.map(({ zh }) => zh).join("")}` } }], context), notModelledBy("probe"));
  }

  stage("analysis", "started", chosen);
  const config = methodConfigFor(plan, cohort, chosen);
  // What the model received: the adjustment variables it was given, and why each other one of the study spec was not.
  const notModelled = notModelledBy(chosen);
  const modelledBase = withNotModelled(base as typeof base & { covariates_not_modelled?: CovariateNotModelled[] }, notModelled);
  const result = await dependencies.executor.run(cohort.rows, config, join(dependencies.output_dir, plan.plan_id.replaceAll(/[^a-zA-Z0-9_.-]/gu, "_"), chosen));
  if (result.status !== "completed") {
    return { ...modelledBase, ...context, chosen_method: chosen, result, status: "failed", stage_reached: "analysis", blockers: [{ stage: "analysis", code: "METHOD_FAILED", message: { en: friendlyFailure(result.error), zh: `统计方法运行失败：${friendlyFailureZh(result.error)}` } }] };
  }
  // A characteristic is profiled as what it is, so no check reads an outcome-type characteristic as the outcome.
  const dataProfile = profileAnalysisColumns(cohort.rows, (cohort.columns ?? []).map((column) => column.characteristic ? { ...column, role: "characteristic" } : column));
  const outcomeWindow = plan.study_spec.time_windows?.find(({ purpose }) => purpose === "outcome");
  const quality = dependencies.result_checks ? checkPlanResult({
    intent: plan.study_spec.intent_family, ...(plan.study_spec.outcome_structure ? { outcome_structure: plan.study_spec.outcome_structure } : {}),
    ...(plan.study_spec.index_time ? { index_event: plan.study_spec.index_time.event } : {}),
    outcome_to_encounter_end: Boolean(outcomeWindow && "end_event" in outcomeWindow),
    // Only adjustment variables actually modelled count (not switched-off severity variables, the exposure itself or a ratio part).
    covariate_names: (plan.study_spec.covariates ?? []).map(({ name }) => name).filter((name) => !notModelled.some((left) => left.name.toLowerCase() === name.toLowerCase())),
    mapping, profile: dataProfile, result, ...selectionOf(cohort.quality), ...(described ? { description: true } : {}),
  }, dependencies.result_checks) : undefined;
  return { ...modelledBase, ...context, chosen_method: chosen, result, data_profile: dataProfile, ...(quality ? { quality } : {}), status: "completed", stage_reached: "analysis", blockers: [] };
};
