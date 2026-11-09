import { DatabaseSync } from "node:sqlite";
import type { RunEvidenceBundle } from "../domain/run-artifact.js";
import type { RunEvidenceRepository } from "./run-evidence-repository.js";

interface JsonRow { json: string }
interface TableInfoRow { name: string }

export class SqliteRunEvidenceRepository implements RunEvidenceRepository {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS run_evidence (
        run_id TEXT PRIMARY KEY,
        integrity_id TEXT NOT NULL UNIQUE,
        study_integrity_id TEXT NOT NULL,
        json TEXT NOT NULL
      ) STRICT;
    `);
    const columns = this.database.prepare("PRAGMA table_info(run_evidence)").all() as unknown as TableInfoRow[];
    if (!columns.some(({ name }) => name === "study_integrity_id")) {
      this.database.exec("ALTER TABLE run_evidence ADD COLUMN study_integrity_id TEXT");
      const rows = this.database.prepare("SELECT run_id, json FROM run_evidence").all() as unknown as Array<{ run_id: string; json: string }>;
      const update = this.database.prepare("UPDATE run_evidence SET study_integrity_id = ? WHERE run_id = ?");
      for (const row of rows) {
        const bundle = JSON.parse(row.json) as RunEvidenceBundle;
        update.run(bundle.artifact.study.integrity_id, row.run_id);
      }
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS run_evidence_study_integrity_idx ON run_evidence(study_integrity_id)");
  }

  close(): void {
    this.database.close();
  }

  async save(bundle: RunEvidenceBundle): Promise<boolean> {
    const inserted = this.database.prepare(
      "INSERT OR IGNORE INTO run_evidence (run_id, integrity_id, study_integrity_id, json) VALUES (?, ?, ?, ?)",
    ).run(
      bundle.artifact.run_id,
      bundle.artifact.integrity_id,
      bundle.artifact.study.integrity_id,
      JSON.stringify(bundle),
    );
    return inserted.changes === 1;
  }

  async findByRunId(runId: string): Promise<RunEvidenceBundle | undefined> {
    const row = this.database.prepare("SELECT json FROM run_evidence WHERE run_id = ?")
      .get(runId) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as RunEvidenceBundle : undefined;
  }

  async findByStudyIntegrityId(studyIntegrityId: string): Promise<RunEvidenceBundle[]> {
    const rows = this.database.prepare(
      "SELECT json FROM run_evidence WHERE study_integrity_id = ? ORDER BY rowid",
    ).all(studyIntegrityId) as unknown as JsonRow[];
    return rows.map(({ json }) => JSON.parse(json) as RunEvidenceBundle);
  }
}
