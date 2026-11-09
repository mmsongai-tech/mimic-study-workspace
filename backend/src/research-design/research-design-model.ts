import type { StudySpec } from "./study-spec.js";
import type { ContinueDesignRequest, StartDesignRequest } from "./requests.js";
import type { ResearchDesignTemplateContext } from "./research-design-template.js";

export interface ResearchDesignClarificationTurn {
  message?: string;
  answers?: ContinueDesignRequest["answers"];
  suggestion_id?: string;
  answer_context?: Array<{
    question_id: string;
    question: string;
    selected_value: string | string[] | boolean;
    selected_label: string;
  }>;
}

export interface ResearchDesignModel {
  propose(input: {
    request: StartDesignRequest | ContinueDesignRequest;
    current_spec: StudySpec;
    template_context?: ResearchDesignTemplateContext;
    clarification_history?: ResearchDesignClarificationTurn[];
  }): Promise<unknown>;
}

export type ResearchDesignModelFailureCode = "MODEL_TIMEOUT" | "MODEL_AUTHENTICATION_FAILED" | "MODEL_OPENAI_AUTHENTICATION_FAILED" | "MODEL_RESPONSE_INVALID" | "MODEL_RATE_LIMITED" | "MODEL_FALLBACK_AUTHORIZATION_REQUIRED" | "MODEL_UNAVAILABLE";

export class ResearchDesignModelError extends Error {
  constructor(public readonly code: ResearchDesignModelFailureCode, public readonly fallback_model?: string, public readonly attempts: Array<{ provider: string; model: string; order: number; latency_ms: number; outcome: "failed" | "succeeded"; failure_class?: string }> = []) {
    super("The research design model call did not complete successfully.");
    this.name = "ResearchDesignModelError";
  }
}
