import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface StudyMethodConfig {
  method_id: string;
  outcome_type: "binary" | "continuous" | "count" | "time_to_event";
  covariates: string[];
  modifier?: string;
  mediator?: string;
  predictors?: string[];
  /** A description's characteristics: each is described (proportion or mean with its 95% CI), overall and by the exposure column as grouping. */
  characteristics?: string[];
  labels?: Record<string, string>;
  time_unit?: string;
  seed?: number;
  alpha?: number;
  simulations?: number;
  bootstrap?: number;
  small_cell_threshold?: number;
}

export interface StudyMethodEstimate { term: string; label: string; measure: string; estimate: number | null; ci_low: number | null; ci_high: number | null; p_value: number | null }
export interface StudyMethodResult {
  method_id: string;
  method_library_version: string;
  status: "completed" | "failed";
  error?: string;
  n_input: number;
  n_analysed: number;
  estimates: StudyMethodEstimate[];
  diagnostics: Record<string, unknown>;
  warnings: string[];
  tables: Record<string, Array<Record<string, unknown>>>;
  figures: Array<{ file: string; title: string; kind: string }>;
  /** Directory holding the figure files; owned by the caller. */
  output_dir: string;
}

const SCRIPT = fileURLToPath(new URL("./runtimes/r/study_methods.R", import.meta.url));

const csvCell = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  const text = typeof value === "boolean" ? String(value) : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
};

/**
 * Runs one registered method over patient-level analysis rows. The rows are written to a private temporary
 * CSV that is always deleted; only the aggregate result and figures remain in `output_dir`.
 */
export class RStudyMethodExecutor {
  constructor(private readonly options: { rscript_binary?: string; timeout_ms?: number } = {}) {}

  async run(rows: Array<Record<string, unknown>>, config: StudyMethodConfig, outputDir: string): Promise<StudyMethodResult> {
    const workDir = await mkdtemp(join(tmpdir(), "mimic-study-method-"));
    try {
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\n");
      const dataPath = join(workDir, "analysis.csv"); const configPath = join(workDir, "config.json");
      await writeFile(dataPath, `${csv}\n`, { mode: 0o600 });
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.options.rscript_binary ?? "Rscript", ["--vanilla", SCRIPT, dataPath, configPath, outputDir], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000); });
        const timer = setTimeout(() => child.kill("SIGKILL"), this.options.timeout_ms ?? 600_000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          if (signal) reject(new Error(`The statistical method ${config.method_id} timed out.`));
          else if (code !== 0) reject(new Error(`The statistical method ${config.method_id} exited with code ${code}: ${stderr.split("\n").filter((line) => /error/iu.test(line)).slice(-2).join(" ") || "no diagnostic"}`));
          else resolve();
        });
      });
      const parsed = JSON.parse(await readFile(join(outputDir, "result.json"), "utf8")) as Omit<StudyMethodResult, "output_dir">;
      return { ...parsed, warnings: parsed.warnings ?? [], output_dir: outputDir };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
