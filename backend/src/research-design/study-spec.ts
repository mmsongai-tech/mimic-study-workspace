export type ResearchIntent = "association" | "prediction" | "treatment_effect";

export type OutcomeStructure =
  | "binary"
  | "continuous"
  | "count"
  | "time_to_event"
  | "repeated_measure"
  | "competing_risk";

export interface PopulationDefinition {
  description: string;
  inclusion_criteria?: string[];
  exclusion_criteria?: string[];
  criteria?: StudyCondition;
}

export interface StudyConditionBase {
  condition_id: string;
  source_text: string;
}

export type StudyCondition =
  | (StudyConditionBase & { kind: "all" | "any"; operands: StudyCondition[] })
  | (StudyConditionBase & { kind: "not"; operand: StudyCondition })
  | (StudyConditionBase & { kind: "concept"; concept: string; assertion: "present" | "absent" })
  | (StudyConditionBase & { kind: "numeric_comparison"; concept: string; operator: "gt" | "gte" | "eq" | "lt" | "lte"; value: number; unit?: string })
  | (StudyConditionBase & { kind: "category_comparison"; concept: string; operator: "in" | "not_in"; values: string[] })
  | (StudyConditionBase & { kind: "event_exists"; concept: string; occurrence: "present" | "absent"; window?: TimeWindow });

export interface IndexTimeDefinition {
  event: string;
  selection_rule: string;
}

export type StudyVariableRole = "exposure" | "predictor" | "outcome" | "covariate";

export interface StudyVariable {
  name: string;
  role: StudyVariableRole;
  operational_definition: string;
  definition?: StudyCondition;
  derivation?: MeasurementDifferenceDefinition;
  aggregation?: "first" | "last" | "minimum" | "maximum" | "mean" | "median" | "sum" | "standard_deviation" | "any" | "count";
  contrast?:
    | { kind: "as_recorded" }
    | { kind: "binary_presence" }
    | { kind: "threshold"; operator: "gt" | "gte" | "lt" | "lte"; value: number; unit?: string };
}

export type TimeWindow = {
  purpose: "baseline" | "exposure" | "follow_up" | "outcome";
  anchor: "index_time";
  start_offset: number;
  end_offset: number;
  unit: "minute" | "hour" | "day" | "week" | "month" | "year";
} | {
  purpose: "baseline" | "exposure" | "follow_up" | "outcome";
  anchor: "index_time";
  end_event: "end_of_encounter";
};

export interface EstimandDefinition {
  target_population: string;
  exposure_contrast: string;
  outcome_measure: string;
  summary_measure: string;
}

export interface EffectModifierDefinition {
  variable_name: string;
  analysis: "interaction_and_stratified";
  report_levels?: string[];
}

export interface MeasurementDifferenceDefinition {
  schema_version: "1.0.0";
  operator: "difference";
  source_concept: string;
  aggregation: "first" | "last" | "minimum" | "maximum" | "mean" | "median" | "standard_deviation";
  baseline: TimeWindow;
  follow_up: TimeWindow;
  direction: "baseline_minus_follow_up" | "follow_up_minus_baseline";
}

export interface RequestedAnalysisObjective {
  objective_id: string;
  source_text: string;
  outcome_structure?: OutcomeStructure;
  requires_derivation?: boolean;
}

export interface AnalysisObjectiveDefinition {
  objective_id: string;
  status: "ready" | "blocked";
  blocking_reason?: string;
  outcome: StudyVariable;
  outcome_structure: OutcomeStructure;
  time_windows: TimeWindow[];
  estimand: EstimandDefinition;
  analysis_family: NonNullable<StudySpec["analysis_family"]>;
}

/** Boolean outcome conditions are NOT objective lists. */
export interface AnalysisObjectiveSet {
  schema_version: "1.0.0";
  original_question: string;
  requested: RequestedAnalysisObjective[];
  objectives: AnalysisObjectiveDefinition[];
}

export interface StudySpec {
  schema_version: "1.0.0";
  intent_family: ResearchIntent | "undetermined";
  title?: string;
  research_question?: string;
  population?: PopulationDefinition;
  index_time?: IndexTimeDefinition;
  exposure_or_predictors?: StudyVariable[];
  outcome?: StudyVariable;
  outcome_structure?: OutcomeStructure;
  time_windows?: TimeWindow[];
  covariates?: StudyVariable[];
  /**
   * What a description reports (no outcome, no estimand): each characteristic's proportion or mean, overall and by group. Role
   * "outcome" is read over the outcome window and role "covariate" in the first 24 hours; none is modelled. Condition ids start
   * with "characteristic.".
   */
  characteristics?: StudyVariable[];
  effect_modifiers?: EffectModifierDefinition[];
  estimand?: EstimandDefinition;
  analysis_family?:
    | "association"
    | "binary_prediction"
    | "propensity_weighted_treatment_effect"
    | "time_to_event_association"
    | "time_to_event_prediction"
    | "time_to_event_treatment_effect";
  assumptions?: string[];
  analysis_objectives?: AnalysisObjectiveSet;
}

export type StudySpecChange =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

/**
 * A follow-up window (a change outcome's or a change mediator's) lasts at least this long after the baseline window it
 * follows, wherever windows are moved (a question's "first N hours", a time choice when confirming), so it is never empty.
 */
export const MINIMUM_FOLLOW_UP_HOURS = 24;
export const followUpEnd = (start: number, end: number): number => Math.max(end, start + MINIMUM_FOLLOW_UP_HOURS);

/**
 * Definitions and population texts are written for the default windows: exposure and baseline in the first 24 hours, a
 * change from 24 to 72 hours. Windows moved afterwards (a question's "first 6 hours", a time choice when confirming) are
 * stated as the plan runs. The windows are the study spec's own, which the extractor reads.
 */
export const restateWindows = (text: string, windows: TimeWindow[] | undefined): string => {
  const hours = (window: TimeWindow | undefined): [number, number] | undefined => window && "end_offset" in window && window.unit === "hour" ? [window.start_offset, window.end_offset] : undefined;
  const read = hours(windows?.find(({ purpose }) => purpose === "exposure") ?? windows?.find(({ purpose }) => purpose === "baseline"));
  const followUp = hours(windows?.find(({ purpose }) => purpose === "follow_up"));
  let restated = text;
  if (read && read[0] === 0 && read[1] !== 24) restated = restated.replace(/\b(within|in) the first 24 hours\b/gu, `$1 the first ${read[1]} hours`);
  if (followUp) restated = restated.replace(/\bfrom 24 to \d+(?:\.\d+)? hours\b/gu, `from ${followUp[0]} to ${followUp[1]} hours`);
  return restated;
};
