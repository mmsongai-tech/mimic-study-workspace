// Synthetic contract fixture. No patient records or question-specific production rules.
import { withAnalysisObjectiveSummary } from "../analysis-objectives.js";
import type { AnalysisObjectiveDefinition, StudySpec, TimeWindow } from "../study-spec.js";

export const syntheticObjectiveStudy = (): StudySpec => {
  const baseline: TimeWindow = { purpose: "baseline", anchor: "index_time", start_offset: -24, end_offset: 0, unit: "hour" };
  const follow: TimeWindow = { purpose: "follow_up", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" };
  const estimand = { target_population: "Synthetic population", exposure_contrast: "X versus no X", outcome_measure: "Measurement difference", summary_measure: "Adjusted mean difference" };
  const first: AnalysisObjectiveDefinition = {
    objective_id: "change", status: "ready", outcome_structure: "continuous", analysis_family: "association", estimand,
    time_windows: [{ ...follow, purpose: "outcome" }, follow],
    outcome: { name: "Arbitrary display label", role: "outcome", operational_definition: "Baseline mean minus follow-up mean",
      definition: { condition_id: "measure", source_text: "Measurement difference", kind: "concept", concept: "测量项目甲", assertion: "present" },
      derivation: { schema_version: "1.0.0", operator: "difference", source_concept: "Measurement A", aggregation: "mean", baseline, follow_up: follow, direction: "baseline_minus_follow_up" } },
  };
  const second: AnalysisObjectiveDefinition = {
    objective_id: "event", status: "ready", outcome_structure: "binary", analysis_family: "association",
    estimand: { ...estimand, outcome_measure: "Event", summary_measure: "Adjusted odds ratio" },
    time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }],
    outcome: { name: "Recorded event", role: "outcome", operational_definition: "Event during encounter",
      definition: { condition_id: "event", source_text: "Recorded event", kind: "event_exists", concept: "Event B", occurrence: "present" } },
  };
  const question = "Compare X for measurement difference and recorded event.";
  return withAnalysisObjectiveSummary({ schema_version: "1.0.0", intent_family: "association", title: "Synthetic multi-objective study", research_question: question,
    population: { description: "Synthetic population", criteria: { condition_id: "population", source_text: "Synthetic population", kind: "concept", concept: "Eligible encounter", assertion: "present" } },
    index_time: { event: "Encounter landmark", selection_rule: "First eligible encounter" },
    exposure_or_predictors: [{ name: "X", role: "exposure", operational_definition: "X in baseline window", contrast: { kind: "binary_presence" }, definition: { condition_id: "exposure", source_text: "X", kind: "event_exists", concept: "X", occurrence: "present" } }],
    time_windows: [baseline, { ...baseline, purpose: "exposure" }], covariates: [], assumptions: ["Association, not a causal conclusion"],
    analysis_objectives: { schema_version: "1.0.0", original_question: question,
      requested: [{ objective_id: "change", source_text: "Measurement difference", outcome_structure: "continuous", requires_derivation: true }, { objective_id: "event", source_text: "Recorded event", outcome_structure: "binary" }],
      objectives: [first, second] },
  });
};
