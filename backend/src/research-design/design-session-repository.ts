import type { DesignConfirmation, DesignSession } from "./design-session.js";
import type { ProcessedDesignRequest } from "./processed-design-request.js";

export interface DesignSessionRepository {
  claimRequest(claim: {
    request_id: string;
    operation: "start" | "continue";
    request_fingerprint: string;
    claim_token: string;
    expires_at: string;
  }): Promise<"acquired" | "pending" | "conflict">;
  releaseRequest(requestId: string, claimToken: string): Promise<void>;
  create(
    session: DesignSession,
    request: ProcessedDesignRequest,
    claimToken: string,
  ): Promise<boolean>;
  saveRevision(
    session: DesignSession,
    expectedRevision: number,
    request: ProcessedDesignRequest,
    claimToken: string,
  ): Promise<boolean>;
  findById(id: string): Promise<DesignSession | undefined>;
  findConfirmedByResearchQuestion?(question: string): Promise<DesignSession | undefined>;
  findProcessedRequest(requestId: string): Promise<ProcessedDesignRequest | undefined>;
  confirm(
    sessionId: string,
    expectedRevision: number,
    confirmation: DesignConfirmation,
    request: ProcessedDesignRequest,
  ): Promise<boolean>;
}
