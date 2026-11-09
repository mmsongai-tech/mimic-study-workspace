import { DatabaseSync } from "node:sqlite";
import type { MultiObjectiveReportBundle } from "./multi-objective-report.js";

interface JsonRow { json: string }

export class SqliteMultiObjectiveReportRepository {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`CREATE TABLE IF NOT EXISTS multi_objective_report_evidence (
      report_id TEXT PRIMARY KEY,
      integrity_id TEXT NOT NULL UNIQUE,
      json TEXT NOT NULL
    ) STRICT`);
  }

  close(): void { this.database.close(); }

  async save(bundle: MultiObjectiveReportBundle): Promise<boolean> {
    const result = this.database.prepare(
      "INSERT OR IGNORE INTO multi_objective_report_evidence (report_id, integrity_id, json) VALUES (?, ?, ?)",
    ).run(bundle.artifact.report_id, bundle.artifact.integrity_id, JSON.stringify(bundle));
    return result.changes === 1;
  }

  async findByReportId(reportId: string): Promise<MultiObjectiveReportBundle | undefined> {
    const row = this.database.prepare("SELECT json FROM multi_objective_report_evidence WHERE report_id = ?")
      .get(reportId) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as MultiObjectiveReportBundle : undefined;
  }
}
