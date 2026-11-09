import type { StudySpec } from "./study-spec.js";
import type { DesignPhase } from "./design-rules.js";
import type { ResearchDesignClarificationTurn } from "./research-design-model.js";
import type { ResearchDesignProposal } from "./model-proposal.js";

export interface DesignRevision {
  revision: number;
  spec: StudySpec;
  phase: DesignPhase;
}

export interface DesignConfirmation {
  result: ConfirmedStudySpec;
}

export interface ReusedDesignReview {
  source_integrity_id: string;
  decisions: ReviewableDesignDecision[];
}

export interface ReviewableDesignDecision {
  question_id: string;
  question: string;
  selected_value: string | string[] | boolean;
  selected_label: string;
  response_kind?: "text" | "single_select" | "multi_select" | "boolean";
  options?: Array<{ value: string; label: string; explanation: string }>;
}

export interface DesignSession {
  id: string;
  revision: number;
  spec: StudySpec;
  phase: DesignPhase;
  revisions: DesignRevision[];
  clarification_history?: ResearchDesignClarificationTurn[];
  clarification_review_history?: ReviewableDesignDecision[];
  last_proposal?: ResearchDesignProposal;
  confirmation?: DesignConfirmation;
  confirmation_history?: DesignConfirmation[];
  reused_design_review?: ReusedDesignReview;
}

export interface ConfirmedStudySpec {
  schema_version: "1.0.0";
  session_id: string;
  revision: number;
  confirmed_at: string;
  spec: StudySpec;
  integrity_id: string;
}
