import { DatabaseSync } from "node:sqlite";
import type { ModelAuditReader, ModelAuditWriter, SafeModelAuditRecord } from "./model-audit.js";
import { toSafeModelAuditRecord } from "./model-audit.js";

interface JsonRow { json: string }

/** Persists only the allow-listed audit projection; raw model events never enter SQLite. */
export class SqliteModelAuditRepository implements ModelAuditReader, ModelAuditWriter {
  private readonly database: DatabaseSync;
  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`CREATE TABLE IF NOT EXISTS safe_model_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      json TEXT NOT NULL
    ) STRICT`);
  }
  append(records: unknown[]): void {
    const statement = this.database.prepare("INSERT INTO safe_model_audit (json) VALUES (?)");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) statement.run(JSON.stringify(toSafeModelAuditRecord(record)));
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  list(limit: number): SafeModelAuditRecord[] {
    return (this.database.prepare("SELECT json FROM safe_model_audit ORDER BY sequence DESC LIMIT ?").all(limit) as unknown as JsonRow[])
      .map(({ json }) => toSafeModelAuditRecord(JSON.parse(json)));
  }
  close(): void { this.database.close(); }
}
