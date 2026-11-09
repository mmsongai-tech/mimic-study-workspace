import type { OutcomeStructure, ResearchIntent, StudySpec } from "../research-design/study-spec.js";
import type { StatisticalMethodProfile } from "./analysis-plan.js";

type OutcomeRule = Pick<StatisticalMethodProfile,
  "primary_method" | "rationale" | "alternative_methods" | "required_conditions" |
  "required_diagnostics" | "sensitivity_analyses" | "blocking_diagnostic_codes">;

const reports = [
  "Research objective and estimand", "Cohort flow and denominators", "Variable definitions and timing",
  "Descriptive statistics", "Missing-data handling", "Primary analysis", "Assumption and model diagnostics",
  "Sensitivity analyses", "Effect estimates with uncertainty", "Limitations and interpretation boundary",
];

const association: Record<OutcomeStructure, OutcomeRule> = {
  binary: {
    primary_method: "Multivariable logistic regression with prespecified covariates",
    rationale: "The outcome is binary and the objective is an adjusted association at a defined horizon.",
    alternative_methods: ["Modified Poisson regression with robust variance", "Standardization for adjusted risks and risk differences"],
    required_conditions: ["Independent units or modeled dependence", "Exposure precedes outcome", "Adequate events", "Prespecified functional forms", "Defined missing-data strategy"],
    required_diagnostics: ["cohort_reconciliation", "missingness", "event_information", "model_convergence", "functional_form", "collinearity", "influence", "effect_uncertainty"],
    sensitivity_analyses: ["Alternative exposure coding", "Alternative covariate specification", "Alternative effect scale", "Prespecified missing-data analysis"],
    blocking_diagnostic_codes: ["cohort_reconciliation", "event_information", "model_convergence"],
  },
  continuous: {
    primary_method: "Multivariable linear regression with heteroskedasticity-robust uncertainty",
    rationale: "The outcome is continuous and the objective is an adjusted mean difference or slope.",
    alternative_methods: ["Quantile regression", "Generalized linear model with a prespecified distribution and link"],
    required_conditions: ["Independent units or modeled dependence", "Exposure precedes outcome", "Adequate mean structure", "Influence assessed", "Defined missing-data strategy"],
    required_diagnostics: ["cohort_reconciliation", "missingness", "model_convergence", "functional_form", "residual_pattern", "heteroskedasticity", "collinearity", "influence"],
    sensitivity_analyses: ["Robust or quantile regression", "Alternative transformations", "Influence analysis"],
    blocking_diagnostic_codes: ["cohort_reconciliation", "model_convergence"],
  },
  count: {
    primary_method: "Negative-binomial regression with an exposure offset when observation time differs",
    rationale: "The outcome is a count and clinical event data commonly exhibit overdispersion.",
    alternative_methods: ["Poisson regression with robust variance", "Hurdle model when structural zeros are justified"],
    required_conditions: ["Explicit count definition", "Correct observation-time offset", "Dependence addressed", "Overdispersion assessed", "Defined missing-data strategy"],
    required_diagnostics: ["cohort_reconciliation", "observation_opportunity", "overdispersion", "zero_inflation", "model_convergence", "effect_uncertainty"],
    sensitivity_analyses: ["Robust Poisson model", "Alternative offset", "Hurdle model when justified"],
    blocking_diagnostic_codes: ["cohort_reconciliation", "observation_opportunity", "model_convergence"],
  },
  time_to_event: {
    primary_method: "Kaplan–Meier summaries and multivariable time-to-event Cox regression",
    rationale: "The outcome is time to an event with variable follow-up and censoring.",
    alternative_methods: ["Flexible parametric survival model", "Restricted mean survival time regression"],
    required_conditions: ["Defined time origin, event, censoring, and horizon", "Exposure precedes follow-up", "Independent censoring considered", "Competing events handled", "Defined missing-data strategy"],
    required_diagnostics: ["cohort_reconciliation", "time_origin", "numbers_at_risk", "censoring", "event_information", "proportional_hazards", "functional_form", "model_convergence", "absolute_risk"],
    sensitivity_analyses: ["Restricted mean survival time", "Time-varying effect", "Alternative horizon", "Competing-risk analysis"],
    blocking_diagnostic_codes: ["cohort_reconciliation", "time_origin", "event_information", "model_convergence"],
  },
  repeated_measure: {
    primary_method: "Generalized estimating equations or a mixed-effects model selected for the outcome scale",
    rationale: "Repeated observations require an explicit within-person correlation and time model.",
    alternative_methods: ["Mixed-effects model", "Generalized estimating equations with robust variance"],
    required_conditions: ["Defined measurement schedule", "Within-person dependence modeled", "Outcome distribution specified", "Dropout considered", "Estimable correlation structure"],
    required_diagnostics: ["cohort_reconciliation", "measurement_counts", "missingness_over_time", "correlation_structure", "model_convergence", "residual_pattern"],
    sensitivity_analyses: ["Alternative correlation structure", "Alternative time parameterization", "Informative-dropout analysis"],
    blocking_diagnostic_codes: ["cohort_reconciliation", "measurement_counts", "model_convergence"],
  },
  competing_risk: {
    primary_method: "Cause-specific hazards and cumulative-incidence analysis",
    rationale: "A competing event prevents the event of interest and cannot be treated as ordinary censoring.",
    alternative_methods: ["Fine–Gray subdistribution hazards model", "Pseudo-observation regression"],
    required_conditions: ["Mutually classified event types", "Defined time origin and horizon", "Loss to follow-up separated from competing events", "Effect measure matches the question", "Adequate event counts"],
    required_diagnostics: ["cohort_reconciliation", "time_origin", "numbers_at_risk", "event_type_counts", "censoring", "model_convergence", "absolute_risk"],
    sensitivity_analyses: ["Cause-specific and subdistribution estimands", "Alternative horizon", "Restricted mean time lost"],
    blocking_diagnostic_codes: ["cohort_reconciliation", "time_origin", "event_type_counts", "model_convergence"],
  },
};

const prediction: Record<OutcomeStructure, OutcomeRule> = Object.fromEntries(
  (Object.keys(association) as OutcomeStructure[]).map((structure) => {
    const specifics: Record<OutcomeStructure, [string, string, string[]]> = {
      binary: ["Penalized logistic prediction model with resampling-based internal validation", "The target is individual binary risk and validation must quantify discrimination, calibration, and optimism.", ["Prespecified logistic model", "Nonlinear model with nested tuning"]],
      continuous: ["Penalized continuous-outcome model with resampling-based validation", "The target is an individual continuous outcome and validation must quantify error and calibration.", ["Prespecified linear prediction model", "Distributional regression"]],
      count: ["Penalized count-outcome model with resampling-based validation", "The target is an individual count and prediction must respect observation opportunity and dispersion.", ["Negative-binomial prediction model", "Two-part prediction model"]],
      time_to_event: ["Penalized time-to-event prediction model with censoring-aware validation", "The target is individual risk over time and validation must account for censoring and horizon.", ["Flexible parametric survival model", "Random survival forest with nested tuning"]],
      repeated_measure: ["Landmark or joint longitudinal prediction model with temporal validation", "Repeated updates require explicit prediction times and strict separation of history from future data.", ["Landmark supermodel", "Joint longitudinal–event model"]],
      competing_risk: ["Competing-risk prediction model with horizon-specific calibration and discrimination", "Individual absolute risk must account for events that prevent the outcome of interest.", ["Cause-specific prediction", "Direct cumulative-incidence prediction"]],
    };
    const [primary_method, rationale, alternatives] = specifics[structure];
    return [structure, {
      primary_method, rationale, alternative_methods: alternatives,
      required_conditions: ["Prediction time precedes outcome", "Predictors are available at prediction time", "Data leakage is prevented", "Preprocessing occurs within resampling", "Sample size supports model complexity", ...association[structure].required_conditions.filter((item) => /time origin|event|observation|measurement|competing/iu.test(item))],
      required_diagnostics: [...new Set(["cohort_reconciliation", "missingness", "resampling_integrity", "model_convergence", structure.includes("time") || structure === "competing_risk" ? "time_dependent_discrimination" : "discrimination", "calibration", "overall_error", ...association[structure].required_diagnostics.filter((item) => ["event_information", "event_type_counts", "censoring", "measurement_counts", "observation_opportunity"].includes(item))])],
      sensitivity_analyses: ["Bootstrap optimism correction", "Alternative model complexity", "Clinically relevant threshold or horizon analysis"],
      blocking_diagnostic_codes: [...new Set(["cohort_reconciliation", "resampling_integrity", "model_convergence", ...association[structure].blocking_diagnostic_codes.filter((item) => ["event_information", "event_type_counts", "time_origin", "measurement_counts", "observation_opportunity"].includes(item))])],
    } satisfies OutcomeRule];
  }),
) as Record<OutcomeStructure, OutcomeRule>;

const treatment: Record<OutcomeStructure, OutcomeRule> = Object.fromEntries(
  (Object.keys(association) as OutcomeStructure[]).map((structure) => {
    const specifics: Record<OutcomeStructure, [string, string, string[]]> = {
      binary: ["Stabilized inverse-probability weighting for a marginal risk difference", "The objective is a marginal treatment contrast for a binary outcome.", ["Propensity-score matching", "Outcome-regression standardization"]],
      continuous: ["Stabilized inverse-probability weighting for a marginal mean difference", "The objective is a marginal treatment contrast for a continuous outcome.", ["Matching followed by marginal estimation", "Outcome-regression standardization"]],
      count: ["Propensity weighting with a doubly robust marginal count model", "The objective is a marginal treatment effect on event counts.", ["Weighted negative-binomial regression", "Standardized count regression"]],
      time_to_event: ["Weighted time-to-event analysis with absolute risk and restricted-mean contrasts", "The objective is a treatment contrast over follow-up under explicit confounding and censoring assumptions.", ["Weighted pooled logistic model", "Parametric g-formula"]],
      repeated_measure: ["Marginal structural model for time-varying treatment and longitudinal outcomes", "Repeated treatment and confounder histories require treatment-confounder feedback to be handled.", ["Parametric g-formula", "Structural nested model with specialist review"]],
      competing_risk: ["Weighted cumulative-incidence analysis aligned to a target trial", "The objective is an absolute treatment effect when competing events change outcome probability.", ["Weighted cause-specific models", "Parametric g-formula for competing events"]],
    };
    const [primary_method, rationale, alternatives] = specifics[structure];
    return [structure, {
      primary_method, rationale, alternative_methods: alternatives,
      required_conditions: ["Eligibility, treatment assignment, and time zero are aligned", "Treatment strategies are well-defined", "Measured confounders precede treatment", "Conditional or sequential exchangeability is stated", "Positivity and consistency are plausible", "Informative censoring is addressed"],
      required_diagnostics: [...new Set(["cohort_reconciliation", "treatment_timing", "propensity_overlap", "covariate_balance", "weight_distribution", "effective_sample_size", "model_convergence", "effect_uncertainty", ...association[structure].required_diagnostics.filter((item) => ["event_type_counts", "measurement_counts", "observation_opportunity", "censoring", "absolute_risk"].includes(item))])],
      sensitivity_analyses: ["Weight truncation", "Matching or standardization", "Alternative confounder specification", "Quantitative unmeasured-confounding analysis"],
      blocking_diagnostic_codes: [...new Set(["cohort_reconciliation", "treatment_timing", "propensity_overlap", "covariate_balance", "effective_sample_size", "model_convergence", ...association[structure].blocking_diagnostic_codes.filter((item) => ["event_type_counts", "time_origin", "measurement_counts", "observation_opportunity"].includes(item))])],
    } satisfies OutcomeRule];
  }),
) as Record<OutcomeStructure, OutcomeRule>;

const rules: Record<ResearchIntent, Record<OutcomeStructure, OutcomeRule>> = {
  association,
  prediction,
  treatment_effect: treatment,
};

export const selectStatisticalMethod = (studySpec: StudySpec): StatisticalMethodProfile => {
  if (studySpec.intent_family === "undetermined") throw new Error("A classified research intent is required before method selection.");
  const outcomeStructure = studySpec.outcome_structure ?? "binary";
  const rule = rules[studySpec.intent_family][outcomeStructure];
  const requiredDiagnostics = [...rule.required_diagnostics];
  if ((outcomeStructure === "time_to_event" || outcomeStructure === "competing_risk") && !requiredDiagnostics.includes("Numbers at risk")) {
    requiredDiagnostics.push("Numbers at risk");
  }
  return {
    method_id: `${studySpec.intent_family}.${outcomeStructure}.v1`,
    method_version: studySpec.intent_family === "treatment_effect" ? "1.2.0" : "1.0.0",
    study_family: studySpec.intent_family,
    outcome_structure: outcomeStructure,
    ...structuredClone(rule),
    required_diagnostics: requiredDiagnostics,
    minimum_report_sections: [...reports],
  };
};
