import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RunProgressEvent { at: string; stage: string; detail?: string }
export interface RunProgress {
  schema_version: "1.0.0";
  question: string;
  status: "running" | "completed" | "failed";
  pid: number;
  started_at: string;
  heartbeat_at: string;
  finished_at?: string;
  current?: RunProgressEvent;
  events: RunProgressEvent[];
  error?: string;
}

/** A run is stalled when it claims to run but its heartbeat is older than this. */
export const STALLED_AFTER_MS = 90_000;
const MAX_EVENTS = 300;

/**
 * Live status of one question run, written atomically to `<run>/progress.json`: every stage event and a heartbeat
 * every 15 s, so a crashed, sleeping or blocked run is visible as stalled instead of silently "running".
 */
export class RunProgressFile {
  private state: RunProgress;
  private timer?: NodeJS.Timeout;
  private writing = Promise.resolve();

  constructor(private readonly directory: string, question: string, private readonly now: () => Date = () => new Date()) {
    const at = this.now().toISOString();
    this.state = { schema_version: "1.0.0", question, status: "running", pid: process.pid, started_at: at, heartbeat_at: at, events: [] };
  }

  start(): Promise<void> {
    this.timer = setInterval(() => { void this.flush(); }, 15_000);
    this.timer.unref();
    return this.flush();
  }

  event(stage: string, detail?: string): Promise<void> {
    const entry: RunProgressEvent = { at: this.now().toISOString(), stage, ...(detail ? { detail } : {}) };
    this.state.current = entry;
    this.state.events = [...this.state.events, entry].slice(-MAX_EVENTS);
    return this.flush();
  }

  finish(status: "completed" | "failed", error?: string): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.state.status = status;
    this.state.finished_at = this.now().toISOString();
    if (error) this.state.error = error;
    return this.flush();
  }

  private flush(): Promise<void> {
    this.state.heartbeat_at = this.now().toISOString();
    const snapshot = JSON.stringify(this.state, null, 2);
    const target = join(this.directory, "progress.json");
    this.writing = this.writing.then(async () => {
      const temporary = `${target}.${randomUUID().slice(0, 6)}.tmp`;
      await writeFile(temporary, `${snapshot}\n`);
      await rename(temporary, target);
    }).catch(() => undefined);
    return this.writing;
  }
}

/** Reads a run's progress; a "running" run whose heartbeat is too old is reported as stalled. */
export const readRunProgress = async (directory: string, now: Date = new Date()): Promise<(RunProgress & { stalled: boolean }) | undefined> => {
  try {
    const progress = JSON.parse(await readFile(join(directory, "progress.json"), "utf8")) as RunProgress;
    return { ...progress, stalled: progress.status === "running" && now.getTime() - Date.parse(progress.heartbeat_at) > STALLED_AFTER_MS };
  } catch { return undefined; }
};
