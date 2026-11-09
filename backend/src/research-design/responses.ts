import type { DesignAction, DesignPhase } from "./design-rules.js";
import type { StudySpec } from "./study-spec.js";
import type { ConfirmedStudySpec, ReusedDesignReview } from "./design-session.js";
export type { ConfirmedStudySpec } from "./design-session.js";
import type { ClarifyingQuestion, IntentAssessment } from "./model-proposal.js";

export interface ResearchDesignView {
  session_id: string;
  revision: number;
  phase: DesignPhase;
  assistant_message: string;
  intent_assessment: IntentAssessment;
  study_spec: StudySpec;
  assumptions: string[];
  clarifying_questions: ClarifyingQuestion[];
  suggestions: Array<{ id: string; label: string; explanation: string }>;
  warnings: Array<{ code: string; message: string; blocking: boolean; field_path?: string }>;
  allowed_actions: DesignAction[];
  confirmed?: ConfirmedStudySpec;
  reused_design_review?: ReusedDesignReview;
}

export interface ResearchDesignSessionSnapshot extends Omit<ResearchDesignView, "session_id" | "revision" | "phase" | "study_spec"> {
  session_id: string;
  revision: number;
  phase: DesignPhase;
  study_spec: StudySpec;
  confirmed?: ConfirmedStudySpec;
}
