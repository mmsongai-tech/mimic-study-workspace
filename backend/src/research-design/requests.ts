export interface StartDesignRequest {
  message: string;
  context?: string;
  template_id?: string;
  study_spec_contract?: "objectives-v1";
  allow_openai_fallback?: boolean;
  client_request_id: string;
}

export type DesignAnswer = string | boolean | string[];

export interface ContinueDesignRequest {
  session_id: string;
  base_revision: number;
  message?: string;
  answers?: Record<string, DesignAnswer>;
  suggestion_id?: string;
  client_request_id: string;
}

export interface ConfirmDesignRequest {
  session_id: string;
  base_revision: number;
  client_request_id: string;
}
