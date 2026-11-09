import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { BackendRuntimeConfig } from "./runtime-config.js";
import type { MultiObjectiveRunPhase, ObjectiveProgramTrace } from "../research-program/index.js";

export type MultiObjectiveRunJobStatus = "running" | "completed" | "failed";
export type MultiObjectiveRunJobPhase = "queued" | MultiObjectiveRunPhase | "completed" | "interrupted" | "failed";

export interface MultiObjectiveRunJobRecord {
  job_id: string;
  status: MultiObjectiveRunJobStatus;
  phase: MultiObjectiveRunJobPhase;
  attempt: number;
  started_at: string;
  updated_at: string;
  heartbeat_at: string;
  result_id?: string;
  objective_traces?: ObjectiveProgramTrace[];
  error?: { code: string; message: string; retryable: boolean };
}

interface JobRow {
  job_id: string;
  question_fingerprint: string;
  status: MultiObjectiveRunJobStatus;
  phase: MultiObjectiveRunJobPhase;
  attempt: number;
  started_at: string;
  updated_at: string;
  heartbeat_at: string;
  result_id: string | null;
  objective_traces_json: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
}

const toRecord = (row: JobRow): MultiObjectiveRunJobRecord => ({
  job_id: row.job_id,
  status: row.status,
  phase: row.phase,
  attempt: row.attempt,
  started_at: row.started_at,
  updated_at: row.updated_at,
  heartbeat_at: row.heartbeat_at,
  ...(row.result_id ? { result_id: row.result_id } : {}),
  ...(row.objective_traces_json ? { objective_traces: JSON.parse(row.objective_traces_json) as ObjectiveProgramTrace[] } : {}),
  ...(row.error_code && row.error_message ? { error: { code: row.error_code, message: row.error_message, retryable: row.retryable === 1 } } : {}),
});

/** Computes a stable job identity from the question text without persisting the text itself. */
export const multiObjectiveRunJobId = (originalQuestion: string): { job_id: string; question_fingerprint: string } => {
  const fingerprint = `sha256:${createHash("sha256").update(originalQuestion.trim()).digest("hex")}`;
  return { job_id: `program-job:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`, question_fingerprint: fingerprint };
};

/** Persists multi-objective run lifecycle keyed by a question fingerprint; never the question, prompts, keys, or patient data. */
export class SqliteMultiObjectiveRunJobRepository {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`CREATE TABLE IF NOT EXISTS multi_objective_run_jobs (
      job_id TEXT PRIMARY KEY,
      question_fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      result_id TEXT,
      objective_traces_json TEXT,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER
    ) STRICT`);
  }

  close(): void { this.database.close(); }

  recoverInterrupted(at: string): void {
    this.database.prepare(`UPDATE multi_objective_run_jobs SET
      status = 'failed', phase = 'interrupted', updated_at = ?, heartbeat_at = ?,
      error_code = 'MULTI_OBJECTIVE_RUN_INTERRUPTED',
      error_message = 'The previous backend session ended before the multi-objective run completed.', retryable = 1
      WHERE status = 'running'`).run(at, at);
  }

  claim(jobId: string, questionFingerprint: string, at: string, forceRestart = false): { record: MultiObjectiveRunJobRecord; should_start: boolean } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.find(jobId);
      if (current?.status === "running") {
        this.database.exec("COMMIT");
        return { record: current, should_start: false };
      }
      if (current?.status === "completed" && !forceRestart) {
        this.database.exec("COMMIT");
        return { record: current, should_start: false };
      }
      if (current) {
        this.database.prepare(`UPDATE multi_objective_run_jobs SET
          status = 'running', phase = 'queued', attempt = attempt + 1,
          started_at = ?, updated_at = ?, heartbeat_at = ?, result_id = NULL,
          error_code = NULL, error_message = NULL, retryable = NULL
          WHERE job_id = ?`).run(at, at, at, jobId);
      } else {
        this.database.prepare(`INSERT INTO multi_objective_run_jobs (
          job_id, question_fingerprint, status, phase, attempt,
          started_at, updated_at, heartbeat_at
        ) VALUES (?, ?, 'running', 'queued', 1, ?, ?, ?)`)
          .run(jobId, questionFingerprint, at, at, at);
      }
      const record = this.find(jobId)!;
      this.database.exec("COMMIT");
      return { record, should_start: true };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  find(jobId: string): MultiObjectiveRunJobRecord | undefined {
    const row = this.database.prepare("SELECT * FROM multi_objective_run_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  touch(jobId: string, phase: MultiObjectiveRunJobPhase, at: string): void {
    this.database.prepare("UPDATE multi_objective_run_jobs SET phase = ?, updated_at = ?, heartbeat_at = ? WHERE job_id = ? AND status = 'running'")
      .run(phase, at, at, jobId);
  }

  complete(jobId: string, resultId: string, objectiveTraces: ObjectiveProgramTrace[], at: string): void {
    this.database.prepare(`UPDATE multi_objective_run_jobs SET status = 'completed', phase = 'completed',
      result_id = ?, objective_traces_json = ?, updated_at = ?, heartbeat_at = ?, error_code = NULL,
      error_message = NULL, retryable = NULL WHERE job_id = ?`)
      .run(resultId, JSON.stringify(objectiveTraces), at, at, jobId);
  }

  fail(jobId: string, code: string, message: string, retryable: boolean, at: string): void {
    this.database.prepare(`UPDATE multi_objective_run_jobs SET status = 'failed', phase = 'failed',
      updated_at = ?, heartbeat_at = ?, error_code = ?, error_message = ?, retryable = ?
      WHERE job_id = ?`).run(at, at, code, message, retryable ? 1 : 0, jobId);
  }
}

export interface MultiObjectiveRunExecutorResult { result_id: string; objective_traces: ObjectiveProgramTrace[] }

export interface MultiObjectiveRunJobExecutor {
  execute(originalQuestion: string, onPhase: (phase: MultiObjectiveRunPhase) => void): Promise<MultiObjectiveRunExecutorResult>;
}

type WorkerMessage = { type: "phase"; phase: MultiObjectiveRunPhase } | ({ type: "completed" } & MultiObjectiveRunExecutorResult) | { type: "failed"; code: string; message: string; retryable: boolean };

/** Runs the full objective-decomposition-through-execution program outside the HTTP process. */
export class SubprocessMultiObjectiveRunJobExecutor implements MultiObjectiveRunJobExecutor {
  constructor(private readonly input: { config: BackendRuntimeConfig; archivePath: string; localModelEnabled: boolean; localModelProfile?: string; localModelBaseUrl?: string }) {}

  execute(originalQuestion: string, onPhase: (phase: MultiObjectiveRunPhase) => void): Promise<MultiObjectiveRunExecutorResult> {
    return new Promise((resolve, reject) => {
      const modulePath = fileURLToPath(new URL("../entrypoints/multi-objective-run-worker.ts", import.meta.url));
      const child: ChildProcess = fork(modulePath, [], {
        cwd: process.cwd(),
        execArgv: process.execArgv,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          MIMIC_MODEL_ACCESS: this.input.localModelEnabled ? "disabled" : process.env.MIMIC_MODEL_ACCESS ?? "disabled",
          ...(this.input.localModelEnabled ? {
            MIMIC_LOCAL_MODEL_ENABLED: "enabled",
            MIMIC_LOCAL_MODEL_PROFILE: this.input.localModelProfile ?? "",
            MIMIC_LOCAL_MODEL_BASE_URL: this.input.localModelBaseUrl ?? "",
          } : {}),
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let settled = false;
      const finish = (error?: Error, result?: MultiObjectiveRunExecutorResult) => {
        if (settled) return;
        settled = true;
        child.disconnect();
        if (error) reject(error); else resolve(result!);
      };
      child.on("message", (message: WorkerMessage) => {
        if (message.type === "phase") onPhase(message.phase);
        else if (message.type === "completed") finish(undefined, { result_id: message.result_id, objective_traces: message.objective_traces });
        else finish(Object.assign(new Error(message.message), { code: message.code, retryable: message.retryable }));
      });
      child.once("error", () => finish(Object.assign(new Error("The multi-objective run worker could not start."), { code: "MULTI_OBJECTIVE_RUN_WORKER_UNAVAILABLE", retryable: true })));
      child.once("exit", (code) => {
        if (!settled) finish(Object.assign(new Error(`The multi-objective run worker exited before completion (${code ?? "unknown"}).`), { code: "MULTI_OBJECTIVE_RUN_WORKER_EXITED", retryable: true }));
      });
      child.send({ config: this.input.config, archivePath: this.input.archivePath, originalQuestion });
    });
  }
}

export type MultiObjectiveRunJobView<T> = MultiObjectiveRunJobRecord & { elapsed_ms: number; result?: T };

/** Coordinates idempotent persistent multi-objective runs and hydrates completed report artifacts. */
export class PersistentMultiObjectiveRunJobService<T> {
  constructor(private readonly dependencies: {
    jobs: SqliteMultiObjectiveRunJobRepository;
    executor: MultiObjectiveRunJobExecutor;
    getResult: (id: string) => Promise<T | undefined>;
    now: () => Date;
    heartbeatIntervalMs?: number;
  }) {
    this.dependencies.jobs.recoverInterrupted(this.dependencies.now().toISOString());
  }

  /**
   * Starts (or resumes) the run for a question. `retry: true` forces a completed run to be
   * re-executed from scratch — used after a reviewer resolves blocked variable mappings, since
   * mapping confirmations are read fresh on every pipeline run rather than patched in place.
   */
  async start(originalQuestion: string, options?: { retry?: boolean }): Promise<MultiObjectiveRunJobView<T>> {
    const { job_id: jobId, question_fingerprint: questionFingerprint } = multiObjectiveRunJobId(originalQuestion);
    const claimed = this.dependencies.jobs.claim(jobId, questionFingerprint, this.dependencies.now().toISOString(), options?.retry === true);
    if (claimed.should_start) this.launch(jobId, originalQuestion);
    return this.get(jobId) as Promise<MultiObjectiveRunJobView<T>>;
  }

  async get(jobId: string): Promise<MultiObjectiveRunJobView<T> | undefined> {
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

  private launch(jobId: string, originalQuestion: string): void {
    this.dependencies.jobs.touch(jobId, "queued", this.dependencies.now().toISOString());
    const heartbeat = setInterval(() => {
      const current = this.dependencies.jobs.find(jobId);
      if (current?.status === "running") this.dependencies.jobs.touch(jobId, current.phase, this.dependencies.now().toISOString());
    }, this.dependencies.heartbeatIntervalMs ?? 2_000);
    void this.dependencies.executor.execute(originalQuestion, (phase) => {
      this.dependencies.jobs.touch(jobId, phase, this.dependencies.now().toISOString());
    }).then(({ result_id: resultId, objective_traces: objectiveTraces }) => {
      this.dependencies.jobs.complete(jobId, resultId, objectiveTraces, this.dependencies.now().toISOString());
    }).catch((error: unknown) => {
      const candidate = error as { code?: string; message?: string; retryable?: boolean };
      this.dependencies.jobs.fail(
        jobId,
        candidate.code ?? "MULTI_OBJECTIVE_RUN_FAILED",
        candidate.message ?? "The multi-objective research run did not complete.",
        candidate.retryable !== false,
        this.dependencies.now().toISOString(),
      );
    }).finally(() => clearInterval(heartbeat));
  }
}
