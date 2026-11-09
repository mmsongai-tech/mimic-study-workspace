import { DesignError } from "./design-error.js";
import type { ResearchIntent, StudySpec } from "./study-spec.js";

export type DesignPhase = "drafting" | "needs_clarification" | "ready_to_confirm" | "confirmed";
export type DesignAction = "continue" | "confirm" | "revise";

export const assertIntentCanChange = (
  clarificationRequired: boolean,
  patchPaths: string[],
): void => {
  if (clarificationRequired && patchPaths.includes("/intent_family")) {
    throw new DesignError(
      "DESIGN_PROPOSAL_INVALID",
      "The model cannot select a research type before clarification.",
    );
  }
};

export const assertIntentIsConsistent = (
  spec: StudySpec,
  recommendedIntent: ResearchIntent | "undetermined",
  clarificationRequired: boolean,
): void => {
  if (!clarificationRequired && spec.intent_family !== recommendedIntent) {
    throw new DesignError("DESIGN_PROPOSAL_INVALID", "The research type is inconsistent.");
  }
};

export const alignUnresolvedIntentWithAssessment = (
  spec: StudySpec,
  recommendedIntent: ResearchIntent | "undetermined",
  clarificationRequired: boolean,
): StudySpec => {
  if (
    !clarificationRequired &&
    spec.intent_family === "undetermined" &&
    recommendedIntent !== "undetermined"
  ) {
    return { ...spec, intent_family: recommendedIntent };
  }
  return spec;
};

export const decideDesignState = (
  clarificationRequired: boolean,
  candidateReady: boolean,
  confirmedSchemaMatches: boolean,
): { phase: DesignPhase; allowedActions: DesignAction[] } => {
  if (clarificationRequired) {
    return { phase: "needs_clarification", allowedActions: ["continue"] };
  }
  if (candidateReady && confirmedSchemaMatches) {
    return { phase: "ready_to_confirm", allowedActions: ["continue", "confirm"] };
  }
  return { phase: "drafting", allowedActions: ["continue"] };
};
