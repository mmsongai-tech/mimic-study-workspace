export type DesignErrorCode =
  | "DESIGN_INVALID_INPUT"
  | "DESIGN_PROPOSAL_INVALID"
  | "DESIGN_SESSION_NOT_FOUND"
  | "DESIGN_REVISION_CONFLICT"
  | "DESIGN_IDEMPOTENCY_CONFLICT"
  | "DESIGN_REQUEST_IN_PROGRESS"
  | "DESIGN_LIMIT_EXCEEDED"
  | "DESIGN_NOT_READY"
  | "DESIGN_MODEL_UNAVAILABLE"
  | "DESIGN_MODEL_TIMEOUT"
  | "DESIGN_MODEL_AUTHENTICATION_FAILED"
  | "DESIGN_MODEL_OPENAI_AUTHENTICATION_FAILED"
  | "DESIGN_MODEL_RESPONSE_INVALID"
  | "DESIGN_MODEL_RATE_LIMITED"
  | "DESIGN_MODEL_FALLBACK_AUTHORIZATION_REQUIRED"
  | "DESIGN_STORAGE_FAILURE";

export class DesignError extends Error {
  constructor(
    public readonly code: DesignErrorCode,
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = "DesignError";
  }
}
