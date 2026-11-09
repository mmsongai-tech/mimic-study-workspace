import { DatabaseSync } from "node:sqlite";
import type { GuardedRunEvidenceBundle, GuardedRunEvidenceRepository } from "./guarded-research-workflow-service.js";

interface JsonRow { json: string }

export class SqliteGuardedRunEvidenceRepository implements GuardedRunEvidenceRepository {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS guarded_run_evidence (
        run_id TEXT PRIMARY KEY,
        integrity_id TEXT NOT NULL UNIQUE,
        study_integrity_id TEXT NOT NULL,
        json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS guarded_run_evidence_study_idx
        ON guarded_run_evidence(study_integrity_id);
    `);
  }

  close(): void {
    this.database.close();
  }

  async save(bundle: GuardedRunEvidenceBundle): Promise<boolean> {
    const inserted = this.database.prepare(
      "INSERT OR IGNORE INTO guarded_run_evidence (run_id, integrity_id, study_integrity_id, json) VALUES (?, ?, ?, ?)",
    ).run(
      bundle.artifact.run_id,
      bundle.artifact.integrity_id,
      bundle.artifact.study.integrity_id,
      JSON.stringify(bundle),
    );
    return inserted.changes === 1;
  }

  async findByRunId(runId: string): Promise<GuardedRunEvidenceBundle | undefined> {
    const row = this.database.prepare("SELECT json FROM guarded_run_evidence WHERE run_id = ?").get(runId) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as GuardedRunEvidenceBundle : undefined;
  }
}
