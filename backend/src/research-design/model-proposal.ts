import type { ResearchIntent, StudySpec } from "./study-spec.js";
import type { StudySpecChange } from "./study-spec.js";

export interface IntentAssessment {
  recommended_intent: ResearchIntent | "undetermined";
  confidence: "high" | "medium" | "low";
  reason: string;
  alternative_intents: ResearchIntent[];
  clarification_required: boolean;
  clarifying_question: string | null;
}

export interface ClarifyingQuestion {
  id: string;
  prompt: string;
  reason: string;
  required: boolean;
  response_kind: "text" | "single_select" | "multi_select" | "boolean";
  options: Array<{ value: string; label: string; explanation: string }>;
}

export interface ResearchDesignProposal {
  assistant_message: string;
  intent_assessment: IntentAssessment;
  spec_patch: StudySpecChange[];
  candidate_spec?: StudySpec;
  assumptions: string[];
  clarifying_questions: ClarifyingQuestion[];
  suggestions: Array<{ id: string; label: string; explanation: string; candidate_spec?: StudySpec }>;
  warnings: Array<{ code: string; message: string; field_path?: string }>;
  readiness: "needs_clarification" | "candidate_ready";
}
