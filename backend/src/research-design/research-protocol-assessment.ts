import type { StudySpec } from "./study-spec.js";
import { validateStudyCondition } from "./study-condition.js";
import { assessAnalysisObjectiveContract, projectAnalysisObjective } from "./analysis-objectives.js";

export type ProtocolRequirementSeverity = "required" | "recommended";

export interface ProtocolRequirement {
  code: string;
  field_path: string;
  severity: ProtocolRequirementSeverity;
  question: string;
  reason: string;
}

export interface ResearchProtocolAssessment {
  status: "complete" | "needs_clarification";
  requirements: ProtocolRequirement[];
}

const missingText = (value: string | undefined): boolean => !value?.trim();

export const assessResearchProtocol = (spec: StudySpec): ResearchProtocolAssessment => {
  if (spec.analysis_objectives) {
    const requirements: ProtocolRequirement[] = assessAnalysisObjectiveContract(spec).map((issue) => ({
      code: issue.code, field_path: issue.field_path, severity: "required", question: issue.message, reason: issue.message,
    }));
    for (const [index, objective] of spec.analysis_objectives.objectives.entries()) {
      if (objective.status === "blocked") continue;
      const assessment = assessResearchProtocol(projectAnalysisObjective(spec, objective));
      requirements.push(...assessment.requirements.map((item) => ({ ...item, field_path: `/analysis_objectives/objectives/${index}${item.field_path}` })));
    }
    return { status: requirements.some(({ severity }) => severity === "required") ? "needs_clarification" : "complete", requirements };
  }
  const requirements: ProtocolRequirement[] = [];
  const required = (condition: boolean, code: string, fieldPath: string, question: string, reason: string): void => {
    if (condition) requirements.push({ code, field_path: fieldPath, severity: "required", question, reason });
  };
  const recommended = (condition: boolean, code: string, fieldPath: string, question: string, reason: string): void => {
    if (condition) requirements.push({ code, field_path: fieldPath, severity: "recommended", question, reason });
  };

  required(spec.intent_family === "undetermined", "PURPOSE_REQUIRED", "/intent_family", "Is the objective association, prediction, or treatment effect?", "The research purpose determines the estimand and analysis family.");
  required(missingText(spec.research_question), "QUESTION_REQUIRED", "/research_question", "What is the exact research question?", "A reviewable protocol must preserve the researcher's question.");
  required(!spec.population || missingText(spec.population.description), "POPULATION_REQUIRED", "/population", "Who is eligible for the study?", "The target population and denominator must be explicit.");
  required(Boolean(spec.population && !spec.population.criteria), "STRUCTURED_POPULATION_REQUIRED", "/population/criteria", "Represent every population restriction as explicit logical conditions.", "Local dictionary mapping and denominator construction require a condition tree rather than a narrative cohort label.");
  required(!spec.index_time || missingText(spec.index_time.event) || missingText(spec.index_time.selection_rule), "TIME_ZERO_REQUIRED", "/index_time", "What event defines time zero, and which eligible record is selected?", "Time zero prevents temporal ambiguity and immortal-time errors.");
  required(!spec.exposure_or_predictors?.length, "INPUT_REQUIRED", "/exposure_or_predictors", "What exposure, treatment, or predictors will be evaluated?", "The primary study input must be operationally defined.");
  required(!spec.outcome || missingText(spec.outcome.name) || missingText(spec.outcome.operational_definition), "OUTCOME_REQUIRED", "/outcome", "What is the outcome and how is it operationally defined?", "Outcome classification must be reproducible.");
  for (const [index, variable] of (spec.exposure_or_predictors ?? []).entries()) {
    required(!variable.definition, "STRUCTURED_INPUT_REQUIRED", `/exposure_or_predictors/${index}/definition`, `Represent ${variable.name} as an explicit condition.`, "Local terminology and dictionary evidence must bind to a specific semantic condition.");
  }
  required(Boolean(spec.outcome && !spec.outcome.definition), "STRUCTURED_OUTCOME_REQUIRED", "/outcome/definition", "Represent each separately estimated outcome as an explicit condition leaf.", "A partial dictionary match must not stand in for an unspecified or compound outcome.");
  required(!spec.outcome_structure, "OUTCOME_STRUCTURE_REQUIRED", "/outcome_structure", "Is the outcome binary, continuous, count, time-to-event, repeated, or competing-risk?", "Outcome structure determines the statistical method family.");
  required(!spec.time_windows?.some(({ purpose }) => purpose === "outcome" || purpose === "follow_up"), "OUTCOME_WINDOW_REQUIRED", "/time_windows", "Over what period is the outcome assessed?", "The estimand requires a defined follow-up or outcome horizon.");
  required(!spec.estimand, "ESTIMAND_REQUIRED", "/estimand", "What target population, contrast, outcome measure, and summary measure should be estimated?", "A method cannot be selected responsibly without a target estimand.");
  required(!spec.analysis_family, "ANALYSIS_FAMILY_REQUIRED", "/analysis_family", "Which analysis family corresponds to the confirmed purpose and outcome?", "Execution must use a compatible registered or guarded method.");

  const expectedRole = spec.intent_family === "prediction" ? "predictor" : "exposure";
  required(Boolean(spec.exposure_or_predictors?.some(({ role }) => role !== expectedRole)), "INPUT_ROLE_MISMATCH", "/exposure_or_predictors", `Confirm that every primary input is a${expectedRole === "exposure" ? "n exposure or treatment" : " predictor"}.`, "Input roles must match the research purpose.");
  required(Boolean(spec.outcome && spec.outcome.role !== "outcome"), "OUTCOME_ROLE_MISMATCH", "/outcome/role", "Confirm that the designated outcome has the outcome role.", "Role mismatches make the protocol internally inconsistent.");
  required(Boolean(spec.time_windows?.some((window) => "end_offset" in window && window.end_offset < window.start_offset)), "INVALID_TIME_WINDOW", "/time_windows", "Correct the time window whose end precedes its start.", "Negative-duration windows cannot be executed.");
  required(Boolean(spec.effect_modifiers?.length && spec.intent_family === "prediction"), "EFFECT_MODIFIER_PURPOSE_MISMATCH", "/effect_modifiers", "Represent subgroup prediction performance separately from exposure-effect modification.", "The effect-modifier contract applies to association and treatment-effect contrasts, not prediction inputs.");
  const covariateNames = new Set((spec.covariates ?? []).map(({ name }) => name));
  required(Boolean(spec.effect_modifiers?.some(({ variable_name }) => !covariateNames.has(variable_name))), "EFFECT_MODIFIER_VARIABLE_MISSING", "/effect_modifiers", "Add every effect modifier to the mapped baseline covariates.", "Interaction and stratified estimates require a verified baseline variable mapping.");
  for (const [path, condition] of [
    ["/population/criteria", spec.population?.criteria],
    ...((spec.exposure_or_predictors ?? []).map((variable, index) => [`/exposure_or_predictors/${index}/definition`, variable.definition] as const)),
    ["/outcome/definition", spec.outcome?.definition],
    ...((spec.covariates ?? []).map((variable, index) => [`/covariates/${index}/definition`, variable.definition] as const)),
  ] as const) if (condition) for (const issue of validateStudyCondition(condition)) required(true, issue.code, `${path}/${issue.condition_id}`, "Correct the structured condition definition.", issue.message);

  recommended(!spec.population?.inclusion_criteria?.length, "INCLUSION_CRITERIA_RECOMMENDED", "/population/inclusion_criteria", "Which inclusion criteria define the eligible population?", "Explicit inclusion criteria improve denominator auditability.");
  recommended(!spec.population?.exclusion_criteria?.length, "EXCLUSION_CRITERIA_RECOMMENDED", "/population/exclusion_criteria", "Which exclusions should be applied?", "Explicit exclusions reduce post hoc cohort changes.");
  recommended(!spec.assumptions?.length, "ASSUMPTIONS_RECOMMENDED", "/assumptions", "Which design and statistical assumptions require review?", "Assumptions should be visible before analysis.");
  recommended(!spec.covariates?.length && spec.intent_family !== "prediction", "COVARIATES_RECOMMENDED", "/covariates", "Which baseline variables are confounders or precision covariates?", "Association and treatment-effect estimates usually require prespecified adjustment variables.");
  for (const [index, variable] of (spec.covariates ?? []).entries()) {
    recommended(!variable.definition, "STRUCTURED_COVARIATE_RECOMMENDED", `/covariates/${index}/definition`, `Represent ${variable.name} as an explicit baseline condition.`, "A condition tree improves traceability, while the mapping layer must still verify the named variable against local evidence.");
  }

  return {
    status: requirements.some(({ severity }) => severity === "required") ? "needs_clarification" : "complete",
    requirements,
  };
};
