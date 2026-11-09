import type { DesignConfirmation, DesignSession } from "./design-session.js";
import type { DesignSessionRepository } from "./design-session-repository.js";
import type { ProcessedDesignRequest } from "./processed-design-request.js";

export class InMemoryDesignSessionRepository implements DesignSessionRepository {
  private readonly sessions = new Map<string, DesignSession>();
  private readonly processedRequests = new Map<string, ProcessedDesignRequest>();
  private readonly claims = new Map<string, {
    operation: "start" | "continue";
    request_fingerprint: string;
    claim_token: string;
    expires_at: string;
  }>();

  async claimRequest(claim: {
    request_id: string;
    operation: "start" | "continue";
    request_fingerprint: string;
    claim_token: string;
    expires_at: string;
  }): Promise<"acquired" | "pending" | "conflict"> {
    const current = this.claims.get(claim.request_id);
    if (current && new Date(current.expires_at).valueOf() > Date.now()) {
      return current.operation === claim.operation &&
        current.request_fingerprint === claim.request_fingerprint
        ? "pending"
        : "conflict";
    }
    this.claims.set(claim.request_id, structuredClone(claim));
    return "acquired";
  }

  async releaseRequest(requestId: string, claimToken: string): Promise<void> {
    if (this.claims.get(requestId)?.claim_token === claimToken) this.claims.delete(requestId);
  }

  async create(
    session: DesignSession,
    request: ProcessedDesignRequest,
    claimToken: string,
  ): Promise<boolean> {
    if (this.claims.get(request.request_id)?.claim_token !== claimToken) return false;
    if (this.sessions.has(session.id) || this.processedRequests.has(request.request_id)) return false;
    this.sessions.set(session.id, structuredClone(session));
    this.processedRequests.set(request.request_id, structuredClone(request));
    this.claims.delete(request.request_id);
    return true;
  }

  async saveRevision(
    session: DesignSession,
    expectedRevision: number,
    request: ProcessedDesignRequest,
    claimToken: string,
  ): Promise<boolean> {
    const current = this.sessions.get(session.id);
    if (this.claims.get(request.request_id)?.claim_token !== claimToken) return false;
    if (this.processedRequests.has(request.request_id)) return false;
    if (current?.revision !== expectedRevision) return false;
    if (session.revision !== expectedRevision + 1) return false;
    if (current?.confirmation) {
      const expectedHistory = [...(current.confirmation_history ?? []), current.confirmation];
      if (
        session.confirmation ||
        JSON.stringify(session.confirmation_history) !== JSON.stringify(expectedHistory)
      ) return false;
    }
    if (current && JSON.stringify(session.revisions.slice(0, -1)) !== JSON.stringify(current.revisions)) {
      return false;
    }
    this.sessions.set(session.id, structuredClone(session));
    this.processedRequests.set(request.request_id, structuredClone(request));
    this.claims.delete(request.request_id);
    return true;
  }

  async findById(id: string): Promise<DesignSession | undefined> {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : undefined;
  }

  async findConfirmedByResearchQuestion(question: string): Promise<DesignSession | undefined> {
    const session = [...this.sessions.values()]
      .filter(({ phase, confirmation, spec }) => phase === "confirmed" && Boolean(confirmation) && spec.research_question === question)
      .sort((left, right) => right.revision - left.revision)[0];
    return session ? structuredClone(session) : undefined;
  }

  async findProcessedRequest(requestId: string): Promise<ProcessedDesignRequest | undefined> {
    const request = this.processedRequests.get(requestId);
    return request ? structuredClone(request) : undefined;
  }

  async confirm(
    sessionId: string,
    expectedRevision: number,
    confirmation: DesignConfirmation,
    request: ProcessedDesignRequest,
  ): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.confirmation ||
      this.processedRequests.has(request.request_id)
    ) return false;
    this.sessions.set(sessionId, structuredClone({ ...current, confirmation, phase: "confirmed" }));
    this.processedRequests.set(request.request_id, structuredClone(request));
    return true;
  }
}
