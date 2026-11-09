import { DatabaseSync } from "node:sqlite";
import type { DesignConfirmation, DesignSession } from "./design-session.js";
import type { DesignSessionRepository } from "./design-session-repository.js";
import type { ProcessedDesignRequest } from "./processed-design-request.js";

interface JsonRow { json: string }
interface ClaimRow {
  operation: string;
  request_fingerprint: string;
  claim_token: string;
  expires_at: string;
}

export class SqliteDesignSessionRepository implements DesignSessionRepository {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS design_sessions (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS processed_design_requests (
        request_id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS design_request_claims (
        request_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.database.close();
  }

  async claimRequest(claim: {
    request_id: string;
    operation: "start" | "continue";
    request_fingerprint: string;
    claim_token: string;
    expires_at: string;
  }): Promise<"acquired" | "pending" | "conflict"> {
    return this.transaction(() => {
      const current = this.database
        .prepare(`SELECT operation, request_fingerprint, claim_token, expires_at
          FROM design_request_claims WHERE request_id = ?`)
        .get(claim.request_id) as ClaimRow | undefined;
      if (current && new Date(current.expires_at).valueOf() > Date.now()) {
        return current.operation === claim.operation &&
          current.request_fingerprint === claim.request_fingerprint
          ? "pending"
          : "conflict";
      }
      this.database.prepare("DELETE FROM design_request_claims WHERE request_id = ?").run(claim.request_id);
      this.database.prepare(`INSERT INTO design_request_claims
        (request_id, operation, request_fingerprint, claim_token, expires_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(
          claim.request_id,
          claim.operation,
          claim.request_fingerprint,
          claim.claim_token,
          claim.expires_at,
        );
      return "acquired";
    });
  }

  async releaseRequest(requestId: string, claimToken: string): Promise<void> {
    this.database.prepare(
      "DELETE FROM design_request_claims WHERE request_id = ? AND claim_token = ?",
    ).run(requestId, claimToken);
  }

  async create(
    session: DesignSession,
    request: ProcessedDesignRequest,
    claimToken: string,
  ): Promise<boolean> {
    return this.transaction(() => {
      if (!this.ownsClaim(request.request_id, claimToken)) return false;
      if (this.hasSession(session.id) || this.hasProcessedRequest(request.request_id)) return false;
      this.database.prepare(
        "INSERT INTO design_sessions (id, revision, json) VALUES (?, ?, ?)",
      ).run(session.id, session.revision, JSON.stringify(session));
      this.insertProcessedRequest(request);
      this.deleteClaim(request.request_id, claimToken);
      return true;
    });
  }

  async saveRevision(
    session: DesignSession,
    expectedRevision: number,
    request: ProcessedDesignRequest,
    claimToken: string,
  ): Promise<boolean> {
    return this.transaction(() => {
      if (!this.ownsClaim(request.request_id, claimToken)) return false;
      if (this.hasProcessedRequest(request.request_id) || session.revision !== expectedRevision + 1) {
        return false;
      }
      const current = this.readSession(session.id);
      if (
        !current ||
        current.revision !== expectedRevision ||
        JSON.stringify(session.revisions.slice(0, -1)) !== JSON.stringify(current.revisions)
      ) return false;
      if (current.confirmation) {
        const expectedHistory = [...(current.confirmation_history ?? []), current.confirmation];
        if (
          session.confirmation ||
          JSON.stringify(session.confirmation_history) !== JSON.stringify(expectedHistory)
        ) return false;
      }
      const update = this.database.prepare(
        "UPDATE design_sessions SET revision = ?, json = ? WHERE id = ? AND revision = ?",
      ).run(session.revision, JSON.stringify(session), session.id, expectedRevision);
      if (update.changes !== 1) return false;
      this.insertProcessedRequest(request);
      this.deleteClaim(request.request_id, claimToken);
      return true;
    });
  }

  async findById(id: string): Promise<DesignSession | undefined> {
    return this.readSession(id);
  }

  async findConfirmedByResearchQuestion(question: string): Promise<DesignSession | undefined> {
    const row = this.database.prepare(`SELECT json FROM design_sessions
      WHERE json_extract(json, '$.phase') = 'confirmed'
        AND json_extract(json, '$.confirmation.result.integrity_id') IS NOT NULL
        AND json_extract(json, '$.spec.research_question') = ?
      ORDER BY revision DESC, rowid DESC LIMIT 1`).get(question) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as DesignSession : undefined;
  }

  async findProcessedRequest(requestId: string): Promise<ProcessedDesignRequest | undefined> {
    const row = this.database.prepare(
      "SELECT json FROM processed_design_requests WHERE request_id = ?",
    ).get(requestId) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as ProcessedDesignRequest : undefined;
  }

  async confirm(
    sessionId: string,
    expectedRevision: number,
    confirmation: DesignConfirmation,
    request: ProcessedDesignRequest,
  ): Promise<boolean> {
    return this.transaction(() => {
      if (this.hasProcessedRequest(request.request_id)) return false;
      const current = this.readSession(sessionId);
      if (!current || current.revision !== expectedRevision || current.confirmation) return false;
      const confirmed: DesignSession = { ...current, confirmation, phase: "confirmed" };
      const update = this.database.prepare(
        "UPDATE design_sessions SET json = ? WHERE id = ? AND revision = ?",
      ).run(JSON.stringify(confirmed), sessionId, expectedRevision);
      if (update.changes !== 1) return false;
      this.insertProcessedRequest(request);
      return true;
    });
  }

  private readSession(id: string): DesignSession | undefined {
    const row = this.database.prepare("SELECT json FROM design_sessions WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as DesignSession : undefined;
  }

  private hasSession(id: string): boolean {
    return this.database.prepare("SELECT 1 AS present FROM design_sessions WHERE id = ?")
      .get(id) !== undefined;
  }

  private hasProcessedRequest(requestId: string): boolean {
    return this.database.prepare("SELECT 1 AS present FROM processed_design_requests WHERE request_id = ?")
      .get(requestId) !== undefined;
  }

  private ownsClaim(requestId: string, claimToken: string): boolean {
    return this.database.prepare(
      "SELECT 1 AS present FROM design_request_claims WHERE request_id = ? AND claim_token = ?",
    ).get(requestId, claimToken) !== undefined;
  }

  private insertProcessedRequest(request: ProcessedDesignRequest): void {
    this.database.prepare(
      "INSERT INTO processed_design_requests (request_id, json) VALUES (?, ?)",
    ).run(request.request_id, JSON.stringify(request));
  }

  private deleteClaim(requestId: string, claimToken: string): void {
    this.database.prepare(
      "DELETE FROM design_request_claims WHERE request_id = ? AND claim_token = ?",
    ).run(requestId, claimToken);
  }

  private transaction<Result>(operation: () => Result): Result {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
