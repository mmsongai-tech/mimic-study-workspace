import type { ResearchDesignModel } from "../research-design-model.js";
import type { ResearchDesignProposal } from "../model-proposal.js";

export const startRequest = {
  message: "Study whether a synthetic treatment is related to a synthetic outcome.",
  client_request_id: "start-1",
};

export const baseProposal = (
  changes: Partial<ResearchDesignProposal> = {},
): ResearchDesignProposal => ({
  assistant_message: "I organized the research question and highlighted what is still missing.",
  intent_assessment: {
    recommended_intent: "association",
    confidence: "high",
    reason: "The question asks about a relationship, not prediction or a causal effect.",
    alternative_intents: [],
    clarification_required: false,
    clarifying_question: null,
  },
  spec_patch: [
    { op: "replace", path: "/intent_family", value: "association" },
    { op: "add", path: "/research_question", value: startRequest.message },
  ],
  assumptions: [],
  clarifying_questions: [],
  suggestions: [],
  warnings: [],
  readiness: "needs_clarification",
  ...changes,
});

export const ambiguousProposal = (): ResearchDesignProposal =>
  baseProposal({
    assistant_message: "Please clarify the kind of question you want to answer.",
    intent_assessment: {
      recommended_intent: "undetermined",
      confidence: "low",
      reason: "The wording could mean association or treatment effect.",
      alternative_intents: ["association", "treatment_effect"],
      clarification_required: true,
      clarifying_question: "Do you want association or treatment effect?",
    },
    spec_patch: [{ op: "add", path: "/research_question", value: startRequest.message }],
    clarifying_questions: [
      {
        id: "intent",
        prompt: "Do you want association or treatment effect?",
        reason: "The answer changes the study design.",
        required: true,
        response_kind: "single_select",
        options: [
          { value: "association", label: "Association", explanation: "Study a relationship." },
          { value: "treatment_effect", label: "Treatment effect", explanation: "Study a causal effect." },
        ],
      },
    ],
  });

export const associationProposal = (): ResearchDesignProposal =>
  baseProposal({
    assistant_message: "The question is now classified as an association study.",
    intent_assessment: {
      recommended_intent: "association",
      confidence: "high",
      reason: "The user explicitly selected association.",
      alternative_intents: [],
      clarification_required: false,
      clarifying_question: null,
    },
    spec_patch: [{ op: "replace", path: "/intent_family", value: "association" }],
  });

export const completeAssociationProposal = (): ResearchDesignProposal =>
  baseProposal({
    readiness: "candidate_ready",
    spec_patch: [
      { op: "replace", path: "/intent_family", value: "association" },
      { op: "add", path: "/title", value: "Synthetic association study" },
      { op: "add", path: "/research_question", value: startRequest.message },
      { op: "add", path: "/population", value: { description: "Synthetic adult admissions", criteria: { condition_id: "population.synthetic_adult_admissions", source_text: "Synthetic adult admissions", kind: "concept", concept: "synthetic adult admission", assertion: "present" } } },
      { op: "add", path: "/index_time", value: { event: "Admission", selection_rule: "First eligible admission" } },
      {
        op: "add",
        path: "/exposure_or_predictors",
        value: [{ name: "Synthetic exposure", role: "exposure", operational_definition: "First value after admission", definition: { condition_id: "exposure.synthetic", source_text: "Synthetic exposure", kind: "concept", concept: "synthetic exposure", assertion: "present" } }],
      },
      { op: "add", path: "/outcome", value: { name: "Synthetic outcome", role: "outcome", operational_definition: "Recorded outcome", definition: { condition_id: "outcome.synthetic", source_text: "Synthetic outcome", kind: "event_exists", concept: "synthetic outcome", occurrence: "present" } } },
      { op: "add", path: "/outcome_structure", value: "binary" },
      {
        op: "add",
        path: "/time_windows",
        value: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 7, unit: "day" }],
      },
      {
        op: "add",
        path: "/estimand",
        value: {
          target_population: "Synthetic adult admissions",
          exposure_contrast: "Higher versus lower exposure",
          outcome_measure: "Outcome within seven days",
          summary_measure: "Risk ratio",
        },
      },
      { op: "add", path: "/analysis_family", value: "association" },
    ],
  });

export const modelReturning = (value: unknown): ResearchDesignModel => ({
  async propose() {
    return value;
  },
});

export const queuedModel = (...outputs: unknown[]): ResearchDesignModel => ({
  async propose() {
    const output = outputs.shift();
    if (!output) throw new Error("No model fixture remains.");
    return output;
  },
});
