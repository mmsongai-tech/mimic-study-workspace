import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { ConfirmedStudySpec } from "../research-design/index.js";
import type { BackendRuntimeConfig } from "./runtime-config.js";

export type LocalRunJobStatus = "running" | "completed" | "failed";
export type LocalRunJobPhase = "queued" | "initializing" | "mapping_and_execution" | "finalizing" | "completed" | "interrupted" | "failed";

export interface LocalRunJobRecord {
  job_id: string;
  session_id: string;
  study_integrity_id: string;
  status: LocalRunJobStatus;
  phase: LocalRunJobPhase;
  attempt: number;
  started_at: string;
  updated_at: string;
  heartbeat_at: string;
  result_id?: string;
  error?: { code: string; message: string; retryable: boolean };
}

interface JobRow {
  job_id: string;
  session_id: string;
  study_integrity_id: string;
  status: LocalRunJobStatus;
  phase: LocalRunJobPhase;
  attempt: number;
  started_at: string;
  updated_at: string;
  heartbeat_at: string;
  result_id: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
}

const toRecord = (row: JobRow): LocalRunJobRecord => ({
  job_id: row.job_id,
  session_id: row.session_id,
  study_integrity_id: row.study_integrity_id,
  status: row.status,
  phase: row.phase,
  attempt: row.attempt,
  started_at: row.started_at,
  updated_at: row.updated_at,
  heartbeat_at: row.heartbeat_at,
  ...(row.result_id ? { result_id: row.result_id } : {}),
  ...(row.error_code && row.error_message ? { error: { code: row.error_code, message: row.error_message, retryable: row.retryable === 1 } } : {}),
});

/** Persists local run lifecycle without storing questions, prompts, keys, or patient data. */
export class SqliteLocalRunJobRepository {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`CREATE TABLE IF NOT EXISTS local_run_jobs (
      job_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      study_integrity_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      result_id TEXT,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER
    ) STRICT`);
  }

  close(): void { this.database.close(); }

  recoverInterrupted(at: string): void {
    this.database.prepare(`UPDATE local_run_jobs SET
      status = 'failed', phase = 'interrupted', updated_at = ?, heartbeat_at = ?,
      error_code = 'LOCAL_RUN_INTERRUPTED',
      error_message = 'The previous backend session ended before the local run completed.', retryable = 1
      WHERE status = 'running'`).run(at, at);
  }

  claim(jobId: string, sessionId: string, studyIntegrityId: string, at: string): { record: LocalRunJobRecord; should_start: boolean } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.find(jobId);
      if (current?.status === "running" || current?.status === "completed") {
        this.database.exec("COMMIT");
        return { record: current, should_start: false };
      }
      if (current) {
        this.database.prepare(`UPDATE local_run_jobs SET
          status = 'running', phase = 'queued', attempt = attempt + 1,
          started_at = ?, updated_at = ?, heartbeat_at = ?, result_id = NULL,
          error_code = NULL, error_message = NULL, retryable = NULL
          WHERE job_id = ?`).run(at, at, at, jobId);
      } else {
        this.database.prepare(`INSERT INTO local_run_jobs (
          job_id, session_id, study_integrity_id, status, phase, attempt,
          started_at, updated_at, heartbeat_at
        ) VALUES (?, ?, ?, 'running', 'queued', 1, ?, ?, ?)`)
          .run(jobId, sessionId, studyIntegrityId, at, at, at);
      }
      const record = this.find(jobId)!;
      this.database.exec("COMMIT");
      return { record, should_start: true };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  find(jobId: string): LocalRunJobRecord | undefined {
    const row = this.database.prepare("SELECT * FROM local_run_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  touch(jobId: string, phase: LocalRunJobPhase, at: string): void {
    this.database.prepare("UPDATE local_run_jobs SET phase = ?, updated_at = ?, heartbeat_at = ? WHERE job_id = ? AND status = 'running'")
      .run(phase, at, at, jobId);
  }

  complete(jobId: string, resultId: string, at: string): void {
    this.database.prepare(`UPDATE local_run_jobs SET status = 'completed', phase = 'completed',
      result_id = ?, updated_at = ?, heartbeat_at = ?, error_code = NULL,
      error_message = NULL, retryable = NULL WHERE job_id = ?`)
      .run(resultId, at, at, jobId);
  }

  fail(jobId: string, code: string, message: string, retryable: boolean, at: string): void {
    this.database.prepare(`UPDATE local_run_jobs SET status = 'failed', phase = 'failed',
      updated_at = ?, heartbeat_at = ?, error_code = ?, error_message = ?, retryable = ?
      WHERE job_id = ?`).run(at, at, code, message, retryable ? 1 : 0, jobId);
  }
}

export interface LocalRunJobExecutor {
  execute(sessionId: string, onPhase: (phase: LocalRunJobPhase) => void): Promise<string>;
}

type WorkerMessage = { type: "phase"; phase: LocalRunJobPhase } | { type: "completed"; result_id: string } | { type: "failed"; code: string; message: string; retryable: boolean };

/** Runs CPU-heavy archive work outside the HTTP process and returns only aggregate artifact identity. */
export class SubprocessLocalRunJobExecutor implements LocalRunJobExecutor {
  constructor(private readonly input: { config: BackendRuntimeConfig; archivePath: string }) {}

  execute(sessionId: string, onPhase: (phase: LocalRunJobPhase) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const modulePath = fileURLToPath(new URL("../entrypoints/local-run-worker.ts", import.meta.url));
      const child: ChildProcess = fork(modulePath, [], {
        cwd: process.cwd(),
        execArgv: process.execArgv,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          MIMIC_MODEL_ACCESS: "disabled",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let settled = false;
      const finish = (error?: Error, resultId?: string) => {
        if (settled) return;
        settled = true;
        child.disconnect();
        if (error) reject(error); else resolve(resultId!);
      };
      child.on("message", (message: WorkerMessage) => {
        if (message.type === "phase") onPhase(message.phase);
        else if (message.type === "completed") finish(undefined, message.result_id);
        else finish(Object.assign(new Error(message.message), { code: message.code, retryable: message.retryable }));
      });
      child.once("error", () => finish(Object.assign(new Error("The local run worker could not start."), { code: "LOCAL_RUN_WORKER_UNAVAILABLE", retryable: true })));
      child.once("exit", (code) => {
        if (!settled) finish(Object.assign(new Error(`The local run worker exited before completion (${code ?? "unknown"}).`), { code: "LOCAL_RUN_WORKER_EXITED", retryable: true }));
      });
      child.send({ config: this.input.config, archivePath: this.input.archivePath, sessionId });
    });
  }
}

export type LocalRunJobView<T> = LocalRunJobRecord & { elapsed_ms: number; result?: T };

/** Coordinates idempotent persistent jobs and hydrates completed aggregate artifacts. */
export class PersistentLocalRunJobService<T> {
  constructor(private readonly dependencies: {
    jobs: SqliteLocalRunJobRepository;
    executor: LocalRunJobExecutor;
    getResult: (id: string) => Promise<T | undefined>;
    now: () => Date;
    heartbeatIntervalMs?: number;
  }) {
    this.dependencies.jobs.recoverInterrupted(this.dependencies.now().toISOString());
  }

  async start(study: ConfirmedStudySpec): Promise<LocalRunJobView<T>> {
    const jobId = `job:${createHash("sha256").update(study.integrity_id).digest("hex").slice(0, 24)}`;
    const claimed = this.dependencies.jobs.claim(jobId, study.session_id, study.integrity_id, this.dependencies.now().toISOString());
    if (claimed.should_start) this.launch(jobId, study.session_id);
    return this.get(jobId) as Promise<LocalRunJobView<T>>;
  }

  async get(jobId: string): Promise<LocalRunJobView<T> | undefined> {
    const record = this.dependencies.jobs.find(jobId);
    if (!record) return undefined;
    const endTime = record.status === "running"
      ? this.dependencies.now().getTime()
      : new Date(record.updated_at).getTime();
    const elapsed_ms = Math.max(0, endTime - new Date(record.started_at).getTime());
    const result = record.status === "completed" && record.result_id
      ? await this.dependencies.getResult(record.result_id)
      : undefined;
    return { ...record, elapsed_ms, ...(result ? { result } : {}) };
  }

  close(): void { this.dependencies.jobs.close(); }

  private launch(jobId: string, sessionId: string): void {
    this.dependencies.jobs.touch(jobId, "initializing", this.dependencies.now().toISOString());
    const heartbeat = setInterval(() => {
      const current = this.dependencies.jobs.find(jobId);
      if (current?.status === "running") this.dependencies.jobs.touch(jobId, current.phase, this.dependencies.now().toISOString());
    }, this.dependencies.heartbeatIntervalMs ?? 2_000);
    void this.dependencies.executor.execute(sessionId, (phase) => {
      this.dependencies.jobs.touch(jobId, phase, this.dependencies.now().toISOString());
    }).then((resultId) => {
      this.dependencies.jobs.complete(jobId, resultId, this.dependencies.now().toISOString());
    }).catch((error: unknown) => {
      const candidate = error as { code?: string; message?: string; retryable?: boolean };
      this.dependencies.jobs.fail(
        jobId,
        candidate.code ?? "LOCAL_RUN_FAILED",
        candidate.message ?? "The local research run did not complete.",
        candidate.retryable !== false,
        this.dependencies.now().toISOString(),
      );
    }).finally(() => clearInterval(heartbeat));
  }
}
