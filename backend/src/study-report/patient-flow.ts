/**
 * The exclusion steps between every admission assessed and the analysis cohort, in the order the extractor applies them
 * (local-execution-graph-runner finalize): a unit without a time zero, a unit that ends before the follow-up start, a
 * unit that already had the outcome at the follow-up start (the landmark, or a prediction's prediction time), units
 * outside the study population, then repeat
 * admissions of a patient; only then are the exposure and outcome of each
 * patient's first eligible unit read, and a unit missing either is excluded, never replaced by a later one. The model's
 * own complete-case exclusion comes after the cohort and is reported separately.
 */
export const FLOW_STEP_KEYS = ["no_time_zero", "ended_before_landmark", "outcome_before_landmark", "outcome_before_prediction_time", "not_in_population", "not_first_eligible_unit_of_patient", "incomplete_required_variables"] as const;

export interface FlowStep { key: string; removed: number; remaining: number }

export const patientFlow = (cohort: { analysis_units: number; exclusion_reasons?: Record<string, number> | undefined }): FlowStep[] => {
  let remaining = cohort.analysis_units;
  return FLOW_STEP_KEYS.filter((key) => cohort.exclusion_reasons?.[key]).map((key) => {
    const removed = cohort.exclusion_reasons![key]!;
    remaining -= removed;
    return { key, removed, remaining: Math.max(remaining, 0) };
  });
};
