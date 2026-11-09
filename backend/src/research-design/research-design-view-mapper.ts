import type { DesignAction, DesignPhase } from "./design-rules.js";
import type { StudySpec } from "./study-spec.js";
import type { ResearchDesignProposal } from "./model-proposal.js";
import type { ResearchDesignView } from "./responses.js";

export const toResearchDesignView = (
  sessionId: string,
  revision: number,
  spec: StudySpec,
  proposal: ResearchDesignProposal,
  phase: DesignPhase,
  allowedActions: DesignAction[],
): ResearchDesignView => ({
  session_id: sessionId,
  revision,
  phase,
  assistant_message: proposal.assistant_message,
  intent_assessment: proposal.intent_assessment,
  study_spec: spec,
  assumptions: proposal.assumptions,
  clarifying_questions: proposal.clarifying_questions,
  suggestions: proposal.suggestions,
  warnings: proposal.warnings.map((warning) => ({ ...warning, blocking: false })),
  allowed_actions: allowedActions,
});
