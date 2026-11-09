/**
 * Types mirroring the backend's actual JSON shapes exactly (ported from backend/src/{question-workspace,
 * question-pipeline, study-framing, study-protocol, result-checks, study-analysis, research-design}). This is a
 * frontend-only project with its own build; these are hand-kept in sync with the server, not re-exported from it,
 * because the server package has no browser-safe build target of its own.
 */

export type LocalizedText = { en: string; zh: string };

// ---- study-framing -------------------------------------------------------------------------------------------

export type StudyGoal = "describe" | "compare_groups" | "relate_factor" | "evaluate_treatment" | "predict";
export type OutcomeKind = "event" | "time_to_event" | "value" | "change_over_time" | "count" | "none";
export type StudyType =
  | "descriptive" | "group_comparison" | "association" | "treatment_effect" | "time_to_event"
  | "longitudinal_change" | "dose_response" | "effect_modification" | "mediation" | "prediction";
export type SlotCategory = "demographic" | "encounter" | "vital_sign" | "laboratory" | "medication" | "intervention" | "diagnosis" | "score" | "outcome" | "unknown";
export type SlotAggregation = "maximum" | "minimum" | "mean" | "first" | "last" | "sum";

export interface FrameSlot {
  text: string;
  verbatim: boolean;
  qualified_text?: string;
  aggregation?: SlotAggregation;
  threshold?: { operator: "gt" | "gte" | "lt" | "lte"; value: number; unit?: string };
  normalized?: { label_en: string; category: SlotCategory };
  categories?: string[];
  categories_normalized?: Array<{ text: string; label_en: string; category: SlotCategory; ratio?: { numerator_en: string; denominator_en: string } }>;
  components?: string[];
  components_normalized?: Array<{ text: string; label_en: string; category: SlotCategory }>;
  components_resolved?: Array<{ text: string; concept_en: string; substituted_from?: string }>;
}

export type FrameAmbiguityCode = "SLOT_MISSING" | "ASYMMETRIC_COMPARATOR" | "SLOT_NOT_IN_QUESTION" | "VAGUE_OUTCOME" | "OUTCOME_NOT_MEASURABLE" | "NOT_IN_MIMIC" | "QUESTION_NOT_READ" | "MODEL_NOT_RESPONDING" | "STUDY_TYPE_NOT_SUPPORTED";
export interface FrameAmbiguity { code: FrameAmbiguityCode; slot?: string; message: string; message_zh?: string }

export interface StudyFrame {
  frame_id: string;
  sub_question: string;
  study_type: StudyType;
  facets: { goal: StudyGoal; outcome_kind: OutcomeKind; dose_question: boolean; has_modifier: boolean; has_mediator: boolean };
  population?: FrameSlot;
  exposure?: FrameSlot;
  comparator?: { kind: "absence" | "active" | "unspecified"; text?: string };
  outcome?: FrameSlot;
  modifiers: FrameSlot[];
  mediators: FrameSlot[];
  predictors: FrameSlot[];
  /** A description's characteristics (study type descriptive): described, never an outcome to model. */
  characteristics?: FrameSlot[];
  time_window?: string;
  assumptions: string[];
  ambiguities: FrameAmbiguity[];
  status: "ready" | "needs_clarification";
}

export interface StudyFrameSet { schema_version: "1.0.0"; original_question: string; frames: StudyFrame[] }

// ---- research-design (StudySpec) -----------------------------------------------------------------------------

export type ResearchIntent = "association" | "prediction" | "treatment_effect";
export type OutcomeStructure = "binary" | "continuous" | "count" | "time_to_event" | "repeated_measure" | "competing_risk";

export interface StudyConditionBase { condition_id: string; source_text: string }
export type StudyCondition =
  | (StudyConditionBase & { kind: "all" | "any"; operands: StudyCondition[] })
  | (StudyConditionBase & { kind: "not"; operand: StudyCondition })
  | (StudyConditionBase & { kind: "concept"; concept: string; assertion: "present" | "absent" })
  | (StudyConditionBase & { kind: "numeric_comparison"; concept: string; operator: "gt" | "gte" | "eq" | "lt" | "lte"; value: number; unit?: string })
  | (StudyConditionBase & { kind: "category_comparison"; concept: string; operator: "in" | "not_in"; values: string[] })
  | (StudyConditionBase & { kind: "event_exists"; concept: string; occurrence: "present" | "absent"; window?: TimeWindow });

export type TimeWindow =
  | { purpose: "baseline" | "exposure" | "follow_up" | "outcome"; anchor: "index_time"; start_offset: number; end_offset: number; unit: "minute" | "hour" | "day" | "week" | "month" | "year" }
  | { purpose: "baseline" | "exposure" | "follow_up" | "outcome"; anchor: "index_time"; end_event: "end_of_encounter" };

export type StudyVariableRole = "exposure" | "predictor" | "outcome" | "covariate";
export interface StudyVariable {
  name: string;
  role: StudyVariableRole;
  operational_definition: string;
  definition?: StudyCondition;
  aggregation?: "first" | "last" | "minimum" | "maximum" | "mean" | "median" | "sum" | "any" | "count";
  contrast?: { kind: "as_recorded" } | { kind: "binary_presence" } | { kind: "threshold"; operator: "gt" | "gte" | "lt" | "lte"; value: number; unit?: string };
}

export interface StudySpec {
  schema_version: "1.0.0";
  intent_family: ResearchIntent | "undetermined";
  title?: string;
  research_question?: string;
  population?: { description: string; inclusion_criteria?: string[]; exclusion_criteria?: string[]; criteria?: StudyCondition };
  index_time?: { event: string; selection_rule: string };
  exposure_or_predictors?: StudyVariable[];
  outcome?: StudyVariable;
  outcome_structure?: OutcomeStructure;
  time_windows?: TimeWindow[];
  covariates?: StudyVariable[];
  /** A description's characteristics, each described as a proportion or mean (backend research-design StudySpec). */
  characteristics?: StudyVariable[];
  effect_modifiers?: Array<{ variable_name: string; analysis: string }>;
  estimand?: { target_population: string; exposure_contrast: string; outcome_measure: string; summary_measure: string };
  analysis_family?: "association" | "binary_prediction" | "propensity_weighted_treatment_effect" | "time_to_event_association" | "time_to_event_prediction" | "time_to_event_treatment_effect";
  assumptions?: string[];
}

// ---- study-protocol --------------------------------------------------------------------------------------------

export interface ProtocolElement { key: "eligibility" | "treatment" | "comparator" | "time_zero" | "outcome" | "follow_up" | "confounders" | "analysis"; label: LocalizedText; emulation: string; emulation_zh?: string }
export interface DesignCheck { check_id: string; status: "pass" | "warn"; message: LocalizedText }
export interface StudyProtocol { protocol_version: string; elements: ProtocolElement[]; design_checks: DesignCheck[] }

// ---- result-checks ----------------------------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail";
export interface ResultCheck { check_id: string; status: CheckStatus; title: LocalizedText; observed: string; expected: string; message: LocalizedText }
export interface ResultQuality { rules_version: string; status: CheckStatus; checks: ResultCheck[] }
export interface ColumnProfile {
  column: string; role: string; label: string; mapping_id?: string; kind: "binary" | "numeric" | "categorical";
  n: number; missing: number; distinct: number; n_true?: number; mean?: number; sd?: number; q1?: number; median?: number; q3?: number;
}

// ---- study-analysis -----------------------------------------------------------------------------------------

export interface MethodRequirement {
  min_rows: number; min_events?: number; needs_binary_exposure?: boolean; needs_continuous_exposure?: boolean;
  needs_covariates?: boolean; needs_modifier?: boolean; needs_mediator?: boolean; needs_predictors?: number; needs_time_to_event?: boolean;
}
export interface AnalysisMethodOption { method_id: string; label: LocalizedText; when_preferred: LocalizedText; requirements: MethodRequirement }
export interface MethodReadiness { method_id: string; available: boolean; reasons: LocalizedText[] }

export interface StudyMethodEstimate { term: string; label: string; measure: string; estimate: number | null; ci_low: number | null; ci_high: number | null; p_value: number | null }
export interface StudyMethodResult {
  method_id: string; method_library_version: string; status: "completed" | "failed"; error?: string;
  n_input: number; n_analysed: number; estimates: StudyMethodEstimate[]; diagnostics: Record<string, unknown>;
  warnings: string[]; tables: Record<string, Array<Record<string, unknown>>>;
  figures: Array<{ file: string; title: string; kind: string }>; output_dir: string;
}

// ---- question-pipeline: plan-execution -------------------------------------------------------------------------

export type PipelineStage = "framing" | "mapping" | "manifest" | "cohort" | "method" | "analysis";
export interface PipelineBlocker { stage: PipelineStage; code: string; message: LocalizedText }
export interface MappingSummaryVariable {
  role: string; characteristic?: boolean; requested_term: string; status: "resolved" | "needs_confirmation" | "unmapped";
  selected?: { mapping_id: string; label: string; status: string; table: string; identifiers: number; values: string[] };
  candidates: Array<{ mapping_id: string; label: string; table: string; status: string }>;
  reason?: string;
}

export interface PlanOutcome {
  plan_id: string; frame_id: string; exposure_level?: string; status: "completed" | "blocked" | "failed"; stage_reached: PipelineStage;
  study_spec: StudySpec; mapping?: MappingSummaryVariable[]; manifest?: { manifest_id: string; status: "ready" | "blocked" };
  cohort?: { rows: number; analysis_units: number; excluded_rows: number; exclusion_reasons?: Record<string, number>; cohort_integrity_id: string };
  method_options?: Array<AnalysisMethodOption & { readiness: MethodReadiness }>;
  chosen_method?: string; result?: StudyMethodResult; data_profile?: ColumnProfile[]; quality?: ResultQuality;
  protocol?: StudyProtocol;
  design_notes?: LocalizedText[];
  covariates_not_modelled?: Array<{ name: string; reason: "switched_off" | "exposure" | "exposure_part" | "mediator" | "not_mapped" | "other" }>;
  method_note?: LocalizedText;
  score_exclusions?: Array<{ variable: string; removed_groups: string[]; because_of: string }>;
  blockers: PipelineBlocker[];
}

// ---- question-pipeline: question-plan (draft / lock) -----------------------------------------------------------

export interface TimeOptionOffer {
  exposure?: { default_hours: number; choices: number[] };
  follow_up_end?: { default_hours: number; choices: number[] };
  outcome_horizon?: { default_hours: number; choices: number[] };
}
export interface TimeChoice { exposure_hours?: number; follow_up_end_hours?: number; outcome_horizon_hours?: number }
export interface DesignOptions {
  landmark?: { hours: number; default: boolean };
  severity?: { names: string[]; default_on: string[] };
  time?: TimeOptionOffer;
}
export interface PlanOptionChoice { landmark?: boolean; severity_on?: string[]; time?: TimeChoice }

export interface DraftPlan {
  plan: { plan_id: string; frame_id: string; exposure_level?: string; study_spec: StudySpec };
  status: "ready" | "blocked";
  mapping?: MappingSummaryVariable[];
  manifest?: { manifest_id: string };
  blocked_outcome?: PlanOutcome;
  method_options: AnalysisMethodOption[];
  default_method?: string;
  protocol: StudyProtocol;
  design_options?: DesignOptions;
}

export interface QuestionPlanDraft {
  schema_version: "1.0.0";
  draft_id: string;
  question: string;
  created_at: string;
  versions: { study_spec_compiler: string; method_registry: string; protocol: string; model: string };
  data_source: { id: string; version: string };
  frame_set: StudyFrameSet;
  plans: DraftPlan[];
  unanswered_frames: Array<{ frame: StudyFrame; reasons: LocalizedText[] }>;
  model_audit: unknown[];
  /** Readings offered for an outcome that named nothing measurable ("efficacy"), and the one taken if a test run chose. */
  clarifications?: ClarificationRecord[];
  /** Ways on offered for a variable the mapping only partly covers. */
  mapping_clarifications?: MappingClarificationRecord[];
}

export interface MappingOption {
  option_id: "define" | "broader" | "stop"; label: LocalizedText;
  proposal?: { definition: import("./variables-types").VariableDefinition; facts: { codes: number; admissions: number; rows: number } };
}
export interface MappingClarificationRecord {
  plan_id: string; frame_id: string; role: string; term: string; candidate?: string; uncovered: string[]; options: MappingOption[];
  chosen?: { option_id: MappingOption["option_id"]; by: "user" | "automatic_first" | "automatic_random" };
}

export interface ClarificationOption { option_id: string; label: LocalizedText; question: string; sub_question: string }
export interface ClarificationRecord {
  frame_id: string; slot: "outcome"; text: string; sub_question: string; options: ClarificationOption[];
  chosen?: { option_id: string; by: "user" | "automatic_first" | "automatic_random" }; catalog_version: string;
}

// ---- question-pipeline: question-pipeline-service (final result) ------------------------------------------------

export interface QuestionRunResult {
  schema_version: "1.0.0";
  run_id: string;
  question: string;
  created_at: string;
  versions: { study_spec_compiler: string; method_registry: string; model: string };
  data_source: { id: string; version: string };
  frame_set: StudyFrameSet;
  plans: PlanOutcome[];
  unanswered_frames: Array<{ frame: StudyFrame; reasons: LocalizedText[] }>;
  summary: { frames: number; plans: number; completed: number; blocked: number; failed: number; needs_clarification: number };
  /** Holm-adjusted headline P values when a question ran several analyses (backend question-pipeline/multiplicity.ts). */
  multiplicity?: { method: "holm"; analyses: number; significant_before?: number; significant_after?: number; adjusted: Array<{ plan_id: string; p_value: number; p_adjusted: number }> };
  model_audit: unknown[];
  plan_lock?: { lock_id: string; locked_at: string; confirmed_by: "user" | "automatic" };
}

// ---- question-workspace: run record + live progress --------------------------------------------------------

export type RunStatus = "queued" | "drafting" | "awaiting_confirmation" | "running" | "completed" | "failed" | "cancelled";
export interface RunProgressEvent { at: string; stage: string; detail?: string }

export interface QuestionRunRecord {
  id: string;
  question: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  reanalysis_of?: string;
  methods?: Record<string, string>;
  auto_confirm?: boolean;
  lock_id?: string;
  confirmed_by?: "user" | "automatic";
  progress: Array<{ at: string; stage: string; detail?: string }>;
  error?: string;
  source?: "workspace" | "command_line";
  live?: { current?: RunProgressEvent; heartbeat_at: string; stalled: boolean; events: RunProgressEvent[] };
  result_summary?: { completed: number; plans: number };
}
