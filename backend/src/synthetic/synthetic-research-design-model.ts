import type { ResearchDesignModel } from "../research-design/research-design-model.js";
import type { ResearchDesignProposal } from "../research-design/model-proposal.js";

type SyntheticCapability = "lactate" | "ventilation" | "vasopressor";

const supportedQuestion = (message: string): SyntheticCapability | undefined => {
  const normalized = message.toLocaleLowerCase("en-US");
  const hasLactate = normalized.includes("lactate") || normalized.includes("乳酸");
  const hasMortality = normalized.includes("mortality") || normalized.includes("death") || normalized.includes("死亡");
  if (hasLactate && hasMortality) return "lactate";
  if ((normalized.includes("ventilation") || normalized.includes("机械通气")) &&
      (normalized.includes("predict") || normalized.includes("预测"))) return "ventilation";
  if ((normalized.includes("vasopressor") || normalized.includes("升压药")) && hasMortality) return "vasopressor";
  return undefined;
};

const inferredPurpose = (message: string): "association" | "prediction" | "treatment_effect" | undefined => {
  if (/(关联|相关|关系|association|associated with)/iu.test(message)) return "association";
  if (/(预测|风险|predict|risk prediction)/iu.test(message)) return "prediction";
  if (/(治疗效果|治疗影响|干预效果|treatment effect|causal effect)/iu.test(message)) return "treatment_effect";
  return undefined;
};

const questionTerms = (message: string): { exposure: string; outcome: string } => {
  const terms = message.split(/\s*(?:和|与|及|and|versus|vs\.?|对|关联|关系|影响)\s*/iu).map((term) => term.trim().replace(/(?:关联|关系|影响)$/u, "")).filter(Boolean);
  return { exposure: terms[0] ?? message.trim(), outcome: terms[1] ?? "院内死亡" };
};

const genericProposal = (message: string, intent: "association" | "prediction" | "treatment_effect"): ResearchDesignProposal => {
  const { exposure, outcome } = questionTerms(message);
  const analysisFamily = intent === "association" ? "association" : intent === "prediction" ? "binary_prediction" : "propensity_weighted_treatment_effect";
  const role = intent === "prediction" ? "predictor" : "exposure";
  return {
    assistant_message: "The research question has been structured for review. Data mapping and execution feasibility remain separate checks.",
    intent_assessment: { recommended_intent: intent, confidence: "high", reason: "The research purpose is explicit in the question or was selected by the researcher.", alternative_intents: [], clarification_required: false, clarifying_question: null },
    spec_patch: [
      { op: "replace", path: "/intent_family", value: intent },
      { op: "add", path: "/title", value: `${exposure} and ${outcome}` },
      { op: "add", path: "/research_question", value: message },
      { op: "add", path: "/population", value: { description: "Adults with an eligible ICU admission" } },
      { op: "add", path: "/index_time", value: { event: "ICU admission", selection_rule: "First eligible ICU admission" } },
      { op: "add", path: "/exposure_or_predictors", value: [{ name: exposure, role, operational_definition: "Researcher-confirmed definition and index-relative measurement window" }] },
      { op: "add", path: "/outcome", value: { name: outcome, role: "outcome", operational_definition: "Researcher-confirmed outcome definition and ascertainment window" } },
      { op: "add", path: "/outcome_structure", value: "binary" },
      { op: "add", path: "/time_windows", value: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 1, unit: "month" }] },
      { op: "add", path: "/estimand", value: { target_population: "Adults with an eligible ICU admission", exposure_contrast: `${exposure} according to the confirmed definition`, outcome_measure: outcome, summary_measure: intent === "prediction" ? "Predicted probability and discrimination" : intent === "treatment_effect" ? "Marginal risk difference and risk ratio" : "Risk difference and odds ratio" } },
      { op: "add", path: "/analysis_family", value: analysisFamily },
    ],
    assumptions: ["The question is preserved; clinical concepts, source fields, and time windows require researcher review."],
    clarifying_questions: [], suggestions: [],
    warnings: [{ code: "DATA_MAPPING_REQUIRED", message: "The design is reviewable, but execution requires validated clinical mappings and a compatible capability." }],
    readiness: "candidate_ready",
  };
};

const unsupportedProposal = (message: string): ResearchDesignProposal => ({
  assistant_message: "The question is preserved and ready for a research-purpose decision. Data mapping and execution feasibility will be checked after the design is confirmed.",
  intent_assessment: {
    recommended_intent: "undetermined",
    confidence: "low",
    reason: "The request does not match one of the synthetic runtime's three executable capabilities.",
    alternative_intents: ["association"],
    clarification_required: true,
    clarifying_question: "Which research purpose should be used for this question?",
  },
  spec_patch: [{ op: "add", path: "/research_question", value: message }],
  assumptions: [],
  clarifying_questions: [{
    id: "research-purpose",
    prompt: "Which research purpose should be used for this question?",
    reason: "The original question remains unchanged; choose the purpose before the platform drafts the protocol.",
    required: true,
    response_kind: "single_select",
    options: [{
      value: "association",
      label: "Association study",
      explanation: "Estimate the relationship between the selected exposure and outcome.",
    }, {
      value: "prediction",
      label: "Prediction study",
      explanation: "Estimate individual outcome risk from predictors available at the index time.",
    }, {
      value: "treatment_effect",
      label: "Treatment-effect study",
      explanation: "Estimate the effect of a defined treatment strategy on the outcome.",
    }],
  }],
  suggestions: [],
  warnings: [{ code: "DATA_MAPPING_REQUIRED", message: "The design will be mapped and checked for execution after the purpose is selected." }],
  readiness: "needs_clarification",
});

const editableText = (answers: unknown, key: string, fallback: string): string => {
  if (!answers || typeof answers !== "object") return fallback;
  const value = (answers as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
};

const executableProposal = (message: string, answers?: unknown): ResearchDesignProposal => {
  const population = editableText(answers, "population", "Synthetic adult ICU admissions");
  const indexEvent = editableText(answers, "index_event", "ICU admission");
  const selectionRule = editableText(answers, "selection_rule", "First eligible ICU admission");
  const exposure = editableText(answers, "exposure", "Lactate");
  const outcome = editableText(answers, "outcome", "In-hospital mortality");
  const summaryMeasure = editableText(answers, "summary_measure", "Crude odds ratio and risk difference");
  return ({
  assistant_message: "The synthetic lactate and in-hospital mortality association design is ready for confirmation.",
  intent_assessment: {
    recommended_intent: "association",
    confidence: "high",
    reason: "The question asks for an association between lactate and in-hospital mortality.",
    alternative_intents: [],
    clarification_required: false,
    clarifying_question: null,
  },
  spec_patch: [
    { op: "replace", path: "/intent_family", value: "association" },
    { op: "add", path: "/title", value: "Lactate and in-hospital mortality" },
    { op: "add", path: "/research_question", value: message },
    { op: "add", path: "/population", value: { description: population, criteria: { condition_id: "population.synthetic_icu", source_text: population, kind: "concept", concept: population, assertion: "present" } } },
    { op: "add", path: "/index_time", value: { event: indexEvent, selection_rule: selectionRule } },
    {
      op: "add",
      path: "/exposure_or_predictors",
      value: [{ name: exposure, role: "exposure", operational_definition: "Maximum lactate in the first six hours after ICU admission", definition: { condition_id: "exposure.lactate", source_text: exposure, kind: "concept", concept: exposure, assertion: "present" } }],
    },
    {
      op: "add",
      path: "/outcome",
      value: { name: outcome, role: "outcome", operational_definition: "Death before hospital discharge", definition: { condition_id: "outcome.mortality", source_text: outcome, kind: "event_exists", concept: outcome, occurrence: "present" } },
    },
    { op: "add", path: "/outcome_structure", value: "binary" },
    {
      op: "add",
      path: "/time_windows",
      value: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 1, unit: "month" }],
    },
    {
      op: "add",
      path: "/estimand",
      value: {
        target_population: population,
        exposure_contrast: "Maximum lactate at or above versus below the selected threshold",
        outcome_measure: outcome,
        summary_measure: summaryMeasure,
      },
    },
    { op: "add", path: "/analysis_family", value: "association" },
  ],
  assumptions: ["This runtime uses only self-authored synthetic records."],
  clarifying_questions: [],
  suggestions: [],
  warnings: [{ code: "SYNTHETIC_DATA_ONLY", message: "Results are demonstration evidence, not clinical findings." }],
  readiness: "candidate_ready",
  });
};

const ventilationProposal = (message: string, answers?: unknown): ResearchDesignProposal => {
  const population=editableText(answers,"population","Synthetic adult ICU admissions not invasively ventilated at ICU admission");
  const indexEvent=editableText(answers,"index_event","ICU admission"); const selectionRule=editableText(answers,"selection_rule","First eligible ICU admission");
  const leadPredictor=editableText(answers,"exposure","Age"); const outcome=editableText(answers,"outcome","Invasive mechanical ventilation within 24 hours");
  const summary=editableText(answers,"summary_measure","AUROC, Brier score, calibration, sensitivity and specificity");
  return ({
  assistant_message: "The 24-hour invasive ventilation prediction design is ready for confirmation.",
  intent_assessment: {
    recommended_intent: "prediction", confidence: "high",
    reason: "The question asks for individual risk prediction of invasive ventilation.",
    alternative_intents: [], clarification_required: false, clarifying_question: null,
  },
  spec_patch: [
    { op: "replace", path: "/intent_family", value: "prediction" },
    { op: "add", path: "/title", value: "24-hour invasive ventilation prediction" },
    { op: "add", path: "/research_question", value: message },
    { op: "add", path: "/population", value: { description: population } },
    { op: "add", path: "/index_time", value: { event: indexEvent, selection_rule: selectionRule } },
    { op: "add", path: "/exposure_or_predictors", value: [
      { name: leadPredictor, role: "predictor", operational_definition: "Prespecified leading predictor at ICU admission" },
      { name: "Respiratory rate", role: "predictor", operational_definition: "First respiratory rate after ICU admission" },
      { name: "SpO2/FiO2 ratio", role: "predictor", operational_definition: "First valid ratio within two hours" },
      { name: "Glasgow Coma Scale", role: "predictor", operational_definition: "First total GCS after ICU admission" },
    ] },
    { op: "add", path: "/outcome", value: { name: outcome, role: "outcome", operational_definition: "Initiation of invasive ventilation within 24 hours after ICU admission" } },
    { op: "add", path: "/outcome_structure", value: "binary" },
    { op: "add", path: "/time_windows", value: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }] },
    { op: "add", path: "/estimand", value: { target_population: population, exposure_contrast: "Predicted probability from prespecified admission predictors", outcome_measure: outcome, summary_measure: summary } },
    { op: "add", path: "/analysis_family", value: "binary_prediction" },
  ],
  assumptions: ["Deterministic internal validation uses only self-authored synthetic records."],
  clarifying_questions: [], suggestions: [],
  warnings: [{ code: "SYNTHETIC_DATA_ONLY", message: "Model performance is demonstration evidence and is not clinically validated." }],
  readiness: "candidate_ready",
  });
};

const vasopressorProposal = (message: string, answers?: unknown): ResearchDesignProposal => {
  const population=editableText(answers,"population","Synthetic adult ICU admissions with hypotension"); const indexEvent=editableText(answers,"index_event","First qualifying hypotension after ICU admission");
  const selectionRule=editableText(answers,"selection_rule","First eligible ICU admission"); const exposure=editableText(answers,"exposure","Early vasopressor initiation");
  const outcome=editableText(answers,"outcome","In-hospital mortality"); const summary=editableText(answers,"summary_measure","IPTW-adjusted risk difference and risk ratio");
  return ({
  assistant_message: "The early vasopressor treatment-effect design is ready for confirmation.",
  intent_assessment: {
    recommended_intent: "treatment_effect", confidence: "high",
    reason: "The question asks for the effect of an early treatment strategy on mortality.",
    alternative_intents: ["association"], clarification_required: false, clarifying_question: null,
  },
  spec_patch: [
    { op: "replace", path: "/intent_family", value: "treatment_effect" },
    { op: "add", path: "/title", value: "Early vasopressor use and in-hospital mortality" },
    { op: "add", path: "/research_question", value: message },
    { op: "add", path: "/population", value: { description: population } },
    { op: "add", path: "/index_time", value: { event: indexEvent, selection_rule: selectionRule } },
    { op: "add", path: "/exposure_or_predictors", value: [{ name: exposure, role: "exposure", operational_definition: "Any vasopressor started within six hours of index time" }] },
    { op: "add", path: "/covariates", value: [
      { name: "Age", role: "covariate", operational_definition: "Age at ICU admission" },
      { name: "SOFA score", role: "covariate", operational_definition: "Baseline SOFA score" },
      { name: "Lactate", role: "covariate", operational_definition: "Baseline lactate" },
    ] },
    { op: "add", path: "/outcome", value: { name: outcome, role: "outcome", operational_definition: "Death before hospital discharge" } },
    { op: "add", path: "/outcome_structure", value: "binary" },
    { op: "add", path: "/time_windows", value: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 6, unit: "hour" }, { purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 1, unit: "month" }] },
    { op: "add", path: "/estimand", value: { target_population: population, exposure_contrast: `${exposure} versus no initiation within six hours`, outcome_measure: outcome, summary_measure: summary } },
    { op: "add", path: "/analysis_family", value: "propensity_weighted_treatment_effect" },
  ],
  assumptions: ["Conditional exchangeability is assumed only for synthetic workflow demonstration."],
  clarifying_questions: [], suggestions: [],
  warnings: [{ code: "SYNTHETIC_DATA_ONLY", message: "The synthetic estimate is not a clinical treatment recommendation." }],
  readiness: "candidate_ready",
  });
};

export const createSyntheticResearchDesignModel = (): ResearchDesignModel => ({
  async propose({ request, current_spec }) {
    const message = "message" in request && request.message
      ? request.message
      : current_spec.research_question ?? "";
    const answers = "answers" in request ? request.answers : undefined;
    const selectedCapability = answers && typeof answers === "object" && !Array.isArray(answers)
      ? (answers as Record<string, unknown>)["research-purpose"] ?? (answers as Record<string, unknown>)["synthetic-capability"]
      : undefined;
    if (selectedCapability === "association" || selectedCapability === "prediction" || selectedCapability === "treatment_effect") {
      return genericProposal(message, selectedCapability);
    }
    const capability = selectedCapability === "lactate-mortality-association"
      ? "lactate"
      : selectedCapability === "ventilation-prediction"
        ? "ventilation"
        : selectedCapability === "vasopressor-treatment-effect"
          ? "vasopressor"
          : supportedQuestion(message);
    if (capability === "lactate") return executableProposal(message, answers);
    if (capability === "ventilation") return ventilationProposal(message, answers);
    if (capability === "vasopressor") return vasopressorProposal(message, answers);
    const purpose = inferredPurpose(message);
    if (purpose) return genericProposal(message, purpose);
    return unsupportedProposal(message);
  },
});
