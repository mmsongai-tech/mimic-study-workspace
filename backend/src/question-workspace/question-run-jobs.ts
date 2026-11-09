import { spawn } from "node:child_process";
import type { ClarifyPolicy } from "../question-clarification/index.js";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lockQuestionPlan, type PlanChoices, type PlanOptionChoice, type QuestionPlanDraft } from "../question-pipeline/index.js";
import { readRunProgress, type RunProgressEvent } from "./run-progress-file.js";

/**
 * queued → drafting → awaiting_confirmation → (confirm) queued → running → completed. With auto_confirm the draft is
 * locked with the recommended methods and runs without waiting. Re-analyses of a completed run skip the draft.
 */
export type RunStatus = "queued" | "drafting" | "awaiting_confirmation" | "running" | "completed" | "failed" | "cancelled";
export interface QuestionRunRecord {
  id: string;
  question: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  /** Re-analysis of an earlier run's framing with chosen methods. */
  reanalysis_of?: string;
  methods?: Record<string, string>;
  /** Design-option choices for a re-analysis; a plan without an entry keeps its own design defaults. */
  options?: Record<string, PlanOptionChoice>;
  /** Lock the draft with the recommended methods and run it without waiting for confirmation. */
  auto_confirm?: boolean;
  /** What to do with an outcome that names nothing measurable: ask the researcher (default) or choose a reading for a test run. */
  clarify?: ClarifyPolicy;
  /** Variables (see acceptKey) whose broader concept the researcher accepted when the mapping only partly covered them. */
  accept?: string[];
  /** Set once the plan is confirmed; the run executes exactly this lock. */
  lock_id?: string;
  confirmed_by?: "user" | "automatic";
  progress: Array<{ at: string; stage: string; detail?: string }>;
  error?: string;
  /** Where the run was started; command-line runs are listed read-only. */
  source?: "workspace" | "command_line";
  /** Live progress from the run's progress.json: current stage, heartbeat and whether it stopped reporting. */
  live?: { current?: RunProgressEvent; heartbeat_at: string; stalled: boolean; events: RunProgressEvent[] };
  /**
   * Recorded once, when a run finishes, from its own run.json — lets the run list show whether a "completed" run
   * actually produced a usable result without re-reading every run's full result file on every list poll.
   */
  result_summary?: { completed: number; plans: number };
  /** Set when the workspace is running behind an invite-code gate: the session token that started this run, so
   * one tester's run list never shows another's. Absent entirely when the gate is off. */
  session_owner?: string;
}

export interface QuestionRunLauncher {
  /** Starts one run writing into `directory`; resolves when the process exits. */
  launch(input: LaunchInput, onProgress: (event: Record<string, unknown>) => void): Promise<{ exit_code: number; stderr: string }>;
}
/** draft: frame and prepare, no data read; locked: run a confirmed plan file; otherwise a re-analysis of an earlier run. */
export interface LaunchInput { directory: string; question: string; mode?: "draft" | "locked"; locked_file?: string; from_run?: string; methods?: Record<string, string>; options?: Record<string, PlanOptionChoice>; clarify?: ClarifyPolicy; accept?: string[] }

/** Head and tail of a process's stderr, joined once when they overlap. */
export const mergeStderr = (head: string, tail: string): string => {
  if (!tail || head.endsWith(tail)) return head;
  for (let overlap = Math.min(head.length, tail.length); overlap > 0; overlap -= 1) if (head.endsWith(tail.slice(0, overlap))) return `${head}${tail.slice(overlap)}`;
  return `${head}\n…\n${tail}`;
};

/** A process that died before producing a result (out of memory, killed): not a verdict on the question. */
export const crashedAtStartup = (stderr: string): boolean => /heap out of memory|FATAL ERROR|Killed|SIGKILL|SIGTERM|SIGABRT/u.test(stderr);

/** Launches the question-report-run entrypoint as a child process and relays its PROGRESS lines. */
/** Heap for a child run: a locked run holds a full MIMIC table scan, which exceeds Node's default ceiling on 16 GB. */
const CHILD_HEAP_MB = 8192;

export class SubprocessQuestionRunLauncher implements QuestionRunLauncher {
  constructor(private readonly options: { entrypoint: string; environment: NodeJS.ProcessEnv; cwd: string; heap_mb?: number }) {}
  launch(input: LaunchInput, onProgress: (event: Record<string, unknown>) => void): Promise<{ exit_code: number; stderr: string }> {
    const args = [`--max-old-space-size=${this.options.heap_mb ?? CHILD_HEAP_MB}`, "--import", "tsx", this.options.entrypoint, "--out", input.directory,
      ...(input.mode === "locked" && input.locked_file ? ["--locked", input.locked_file] : input.from_run ? ["--from-run", input.from_run] : ["--question", input.question]),
      ...(input.mode === "draft" ? ["--draft"] : []),
      ...(input.methods && Object.keys(input.methods).length ? ["--methods", JSON.stringify(input.methods)] : []),
      ...(input.options && Object.keys(input.options).length ? ["--options", JSON.stringify(input.options)] : []),
      ...(input.clarify && input.clarify !== "ask" ? ["--clarify", input.clarify] : []),
      ...(input.accept?.length ? ["--accept", JSON.stringify(input.accept)] : [])];
    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd: this.options.cwd, env: this.options.environment, stdio: ["ignore", "pipe", "pipe"] });
      // Keep the head of stderr as well as the tail: a crash prints its cause first and only a trailer last.
      let buffer = ""; let head = ""; let tail = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) if (line.startsWith("PROGRESS ")) { try { onProgress(JSON.parse(line.slice(9)) as Record<string, unknown>); } catch { /* ignore malformed progress */ } }
      });
      child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString("utf8"); head = `${head}${text}`.slice(0, 1500); tail = `${tail}${text}`.slice(-1500); });
      child.once("close", (code) => resolve({ exit_code: code ?? 1, stderr: mergeStderr(head, tail) }));
      child.once("error", (error) => resolve({ exit_code: 1, stderr: error.message }));
    });
  }
}

/**
 * File-backed queue of question runs. One run executes at a time because the local model and archive scans are
 * shared; status lives in each run folder, so the list survives restarts and interrupted runs are marked failed.
 */
export class QuestionRunJobService {
  private queue: Array<{ id: string; kind: "draft" | "run" }> = [];
  private active = false;
  /** The run the queue has taken up, whatever its stored status says at that instant. */
  private activeId: string | undefined;

  constructor(private readonly dependencies: { root: string; launcher: QuestionRunLauncher; now?: () => Date; command_line_root?: string }) {}

  directoryOf(id: string): string {
    if (!/^[a-z0-9-]{8,64}$/u.test(id)) throw new Error("Invalid run id.");
    if (id.startsWith("cli-") && this.dependencies.command_line_root) return join(this.dependencies.command_line_root, id.slice(4));
    return join(this.dependencies.root, id);
  }

  private async withLive(record: QuestionRunRecord): Promise<QuestionRunRecord> {
    const progress = await readRunProgress(this.directoryOf(record.id), this.dependencies.now?.() ?? new Date());
    return progress ? { ...record, live: { ...(progress.current ? { current: progress.current } : {}), heartbeat_at: progress.heartbeat_at, stalled: progress.stalled && (record.status === "running" || record.status === "drafting"), events: progress.events.slice(-40) } } : record;
  }

  /** Runs started from the command line (they write progress.json) appear alongside workspace runs. */
  private async commandLineRuns(): Promise<QuestionRunRecord[]> {
    const root = this.dependencies.command_line_root;
    if (!root) return [];
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const runs = await Promise.all(entries.filter((entry) => entry.isDirectory() && /^[a-z0-9-]{4,60}$/u.test(entry.name)).map(async (entry) => {
      const progress = await readRunProgress(join(root, entry.name), this.dependencies.now?.() ?? new Date());
      if (!progress) return undefined;
      const record: QuestionRunRecord = { id: `cli-${entry.name}`, question: progress.question, status: progress.status, created_at: progress.started_at, updated_at: progress.heartbeat_at, progress: [], source: "command_line", ...(progress.error ? { error: progress.error } : {}),
        live: { ...(progress.current ? { current: progress.current } : {}), heartbeat_at: progress.heartbeat_at, stalled: progress.stalled, events: progress.events.slice(-40) } };
      return record;
    }));
    return runs.filter((run): run is QuestionRunRecord => Boolean(run));
  }

  /**
   * Resumes unfinished runs after a restart, oldest first: a run that was drafting or waiting for its draft is drafted
   * again; a confirmed run (it has a lock on disk) runs again from that lock, so nobody has to confirm twice.
   */
  async recover(): Promise<void> {
    await mkdir(this.dependencies.root, { recursive: true });
    const unfinished = (await this.list()).filter(({ source, status }) => source === "workspace" && (status === "running" || status === "queued" || status === "drafting"))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const record of unfinished) {
      const kind = record.lock_id || record.reanalysis_of ? "run" as const : "draft" as const;
      const note = { at: (this.dependencies.now?.() ?? new Date()).toISOString(), stage: "resumed", detail: `restarted after the workspace server restarted (was ${record.status})` };
      await this.update(record.id, { status: "queued", progress: [...record.progress, note] });
      this.queue.push({ id: record.id, kind });
    }
    void this.drain();
  }

  async start(input: { question: string; reanalysis_of?: string; methods?: Record<string, string>; options?: Record<string, PlanOptionChoice>; auto_confirm?: boolean; clarify?: ClarifyPolicy; accept?: string[]; session_owner?: string }): Promise<QuestionRunRecord> {
    const question = input.question.trim();
    if (!question && !input.reanalysis_of) throw new Error("A research question is required.");
    if (question.length > 2000) throw new Error("The research question is too long.");
    let reanalysedQuestion: string | undefined;
    if (input.reanalysis_of) {
      const source = input.reanalysis_of.startsWith("cli-") ? await this.get(input.reanalysis_of) : await this.read(input.reanalysis_of);
      if (!source || source.status !== "completed") throw new Error("Only a completed run can be re-analysed.");
      reanalysedQuestion = source.question;
    }
    const now = (this.dependencies.now?.() ?? new Date()).toISOString();
    const id = `${now.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const record: QuestionRunRecord = { id, question: reanalysedQuestion ?? question, status: "queued", created_at: now, updated_at: now, progress: [], ...(input.reanalysis_of ? { reanalysis_of: input.reanalysis_of } : {}), ...(input.methods ? { methods: input.methods } : {}), ...(input.options ? { options: input.options } : {}), ...(input.auto_confirm ? { auto_confirm: true } : {}), ...(input.clarify && input.clarify !== "ask" ? { clarify: input.clarify } : {}), ...(input.accept?.length ? { accept: input.accept } : {}), ...(input.session_owner ? { session_owner: input.session_owner } : {}) };
    await mkdir(this.directoryOf(id), { recursive: true });
    await this.write(record);
    this.queue.push({ id, kind: input.reanalysis_of ? "run" : "draft" });
    void this.drain();
    return record;
  }

  /** The prepared plan awaiting confirmation (or already confirmed). */
  async plan(id: string): Promise<QuestionPlanDraft | undefined> {
    try { return JSON.parse(await readFile(join(this.directoryOf(id), "plan-draft.json"), "utf8")) as QuestionPlanDraft; } catch { return undefined; }
  }

  /** Read once, right when a run finishes, so the run list never has to re-read every full result file to show it. */
  private async readResultSummary(id: string): Promise<{ completed: number; plans: number } | undefined> {
    try {
      const result = JSON.parse(await readFile(join(this.directoryOf(id), "run.json"), "utf8")) as { summary?: { completed?: number; plans?: number } };
      return result.summary && typeof result.summary.completed === "number" && typeof result.summary.plans === "number"
        ? { completed: result.summary.completed, plans: result.summary.plans } : undefined;
    } catch { return undefined; }
  }

  /** Locks the draft with the user's choices and queues the unattended run. */
  async confirm(id: string, choices: Partial<PlanChoices>, confirmedBy: "user" | "automatic" = "user"): Promise<QuestionRunRecord> {
    const record = await this.read(id);
    if (!record || record.status !== "awaiting_confirmation") throw new Error("Only a plan awaiting confirmation can be confirmed.");
    const draft = await this.plan(id);
    if (!draft) throw new Error("The plan draft is missing; start the question again.");
    const locked = lockQuestionPlan(draft, choices, confirmedBy, this.dependencies.now?.() ?? new Date(), { allow_unrunnable: confirmedBy === "automatic" });
    const target = join(this.directoryOf(id), "locked-plan.json"); const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(locked, null, 2)}\n`); await rename(temporary, target);
    await this.update(id, { status: "queued", lock_id: locked.lock_id, confirmed_by: confirmedBy, ...(Object.keys(locked.choices.methods).length ? { methods: locked.choices.methods } : {}) });
    this.queue.push({ id, kind: "run" });
    void this.drain();
    return (await this.get(id))!;
  }

  /**
   * Gives up a run that is still waiting in the queue, before it starts. A run already drafting or running holds the
   * local model and the archive scan and is not interrupted from here.
   */
  async cancel(id: string): Promise<QuestionRunRecord> {
    const record = await this.read(id);
    if (!record) throw new Error("Run not found.");
    if (record.status !== "queued" || !this.queue.some((entry) => entry.id === id)) throw new Error("Only a run that is still waiting in the queue can be cancelled.");
    this.queue = this.queue.filter((entry) => entry.id !== id);
    await this.update(id, { status: "cancelled" });
    return (await this.read(id))!;
  }

  /** Deletes a workspace run and its files. A run that is drafting or running is kept: cancel or wait for it first. */
  async remove(id: string): Promise<void> {
    if (id.startsWith("cli-")) throw new Error("A command-line run is read-only here.");
    const record = await this.read(id);
    if (!record) throw new Error("Run not found.");
    if (this.activeId === id || record.status === "drafting" || record.status === "running") throw new Error("A run in progress cannot be deleted; wait for it to finish.");
    this.queue = this.queue.filter((entry) => entry.id !== id);
    await rm(this.directoryOf(id), { recursive: true, force: true });
  }

  async get(id: string): Promise<QuestionRunRecord | undefined> {
    if (id.startsWith("cli-")) return (await this.commandLineRuns()).find((run) => run.id === id);
    const record = await this.read(id);
    return record ? this.withLive(record) : undefined;
  }

  private async read(id: string): Promise<QuestionRunRecord | undefined> {
    try { return JSON.parse(await readFile(join(this.directoryOf(id), "status.json"), "utf8")) as QuestionRunRecord; } catch { return undefined; }
  }

  async list(): Promise<QuestionRunRecord[]> {
    const entries = await readdir(this.dependencies.root, { withFileTypes: true }).catch(() => []);
    const records = await Promise.all(entries.filter((entry) => entry.isDirectory() && /^[a-z0-9-]{8,64}$/u.test(entry.name)).map((entry) => this.get(entry.name)));
    const workspace = records.filter((record): record is QuestionRunRecord => Boolean(record)).map((record) => ({ ...record, source: "workspace" as const }));
    return [...workspace, ...await this.commandLineRuns()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length) {
        const { id, kind } = this.queue.shift()!;
        this.activeId = id;
        const record = await this.read(id);
        if (!record) continue;
        await this.update(id, { status: kind === "draft" ? "drafting" : "running" });
        const locked = kind === "run" && record.lock_id;
        const outcome = await this.dependencies.launcher.launch({
          directory: this.directoryOf(id), question: record.question,
          ...(kind === "draft" ? { mode: "draft" as const } : locked ? { mode: "locked" as const, locked_file: join(this.directoryOf(id), "locked-plan.json") } : {}),
          ...(!locked && record.reanalysis_of ? { from_run: this.directoryOf(record.reanalysis_of) } : {}),
          ...(!locked && record.methods ? { methods: record.methods } : {}),
          ...(!locked && record.options ? { options: record.options } : {}),
          ...(kind === "draft" && record.clarify ? { clarify: record.clarify } : {}),
          ...(kind === "draft" && record.accept?.length ? { accept: record.accept } : {}),
        }, (event) => { void this.appendProgress(id, event); });
        if (outcome.exit_code !== 0) {
          const lines = outcome.stderr.trim().split("\n").map((line) => line.trim()).filter(Boolean);
          // The cause of a crash is its first line (e.g. "FATAL ERROR: … heap out of memory"), not the trailer.
          const cause = (crashedAtStartup(outcome.stderr) ? lines.find((line) => /FATAL|out of memory|Error|Killed|SIG/u.test(line)) : undefined) ?? lines.at(-1) ?? `exit ${outcome.exit_code}`;
          await this.update(id, { status: "failed", error: crashedAtStartup(outcome.stderr) ? `The run's process crashed (${cause}). This is a resource problem on this computer, not a result: start the run again.` : cause });
          continue;
        }
        if (kind !== "draft") {
          const summary = await this.readResultSummary(id);
          await this.update(id, { status: "completed", ...(summary ? { result_summary: summary } : {}) });
          continue;
        }
        await this.update(id, { status: "awaiting_confirmation" });
        if (record.auto_confirm) {
          try { await this.confirm(id, {}, "automatic"); }
          catch (error) { await this.update(id, { status: "failed", error: error instanceof Error ? error.message : "The plan could not be confirmed." }); }
        }
      }
    } finally { this.active = false; this.activeId = undefined; }
  }

  private async appendProgress(id: string, event: Record<string, unknown>): Promise<void> {
    const record = await this.read(id); if (!record) return;
    const detail = event.stage === "plan" ? `${event.index}/${event.total} ${event.plan_id}: ${event.status} (${event.stage_reached})` : undefined;
    record.progress.push({ at: (this.dependencies.now?.() ?? new Date()).toISOString(), stage: String(event.stage ?? "unknown"), ...(detail ? { detail } : {}) });
    await this.write(record);
  }

  private async update(id: string, changes: Partial<QuestionRunRecord>): Promise<void> {
    const record = await this.read(id); if (!record) return;
    await this.write({ ...record, ...changes, updated_at: (this.dependencies.now?.() ?? new Date()).toISOString() });
  }

  private async write(record: QuestionRunRecord): Promise<void> {
    const target = join(this.directoryOf(record.id), "status.json"); const temporary = `${target}.${randomUUID().slice(0, 6)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temporary, target);
  }
}
