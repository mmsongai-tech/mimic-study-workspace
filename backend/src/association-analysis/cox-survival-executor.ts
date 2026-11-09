import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
export interface CoxSurvivalRecord { duration: number; event: boolean; exposure: boolean; }
export interface CoxSurvivalResult { schema_version: "1.0.0"; status: "completed"; method_id: "cox_proportional_hazards.v1"; counts: { total: number; events: number; censored: number }; estimates: { hazard_ratio: number; confidence_interval_95: [number | null, number | null] }; diagnostics: { ph_p_value: number | null; model_converged: boolean }; model: { formula: string; limitations: string[] }; }
export class RCoxSurvivalExecutor {
  constructor(private readonly options: { rscript_binary: string; script_path: string; timeout_ms: number; temporary_root?: string }) {}
  async execute(records: readonly CoxSurvivalRecord[]): Promise<CoxSurvivalResult> {
    if (!records.length || records.some(({ duration, exposure }) => !Number.isFinite(duration) || duration < 0 || typeof exposure !== "boolean")) throw new Error("Valid survival records are required.");
    if (!records.some(({ event }) => event) || !records.some(({ event }) => !event)) throw new Error("Survival input must contain both events and censored records.");
    const directory = await mkdtemp(join(this.options.temporary_root ?? tmpdir(), "mimic-r-cox-"));
    try {
      const inputPath = join(directory, "input.csv"); const outputPath = join(directory, "output.tsv");
      const csv = ["duration,event,exposure", ...records.map(({ duration, event, exposure }) => `${duration},${event ? 1 : 0},${exposure ? 1 : 0}`)].join("\n");
      await writeFile(inputPath, csv, { mode: 0o600 }); await exec(this.options.rscript_binary, ["--vanilla", this.options.script_path, inputPath, outputPath], { timeout: this.options.timeout_ms, maxBuffer: 100_000 });
      const values = new Map((await readFile(outputPath, "utf8")).trim().split("\n").map((line) => { const at = line.indexOf("\t"); return [line.slice(0, at), line.slice(at + 1)]; }));
      const number = (key: string) => { const value = Number(values.get(key)); if (!Number.isFinite(value)) throw new Error(`Missing Cox output: ${key}`); return value; };
      const optionalNumber = (key: string) => { const value = Number(values.get(key)); return Number.isFinite(value) ? value : null; };
      const ph = optionalNumber("ph_p_value");
      return { schema_version: "1.0.0", status: "completed", method_id: "cox_proportional_hazards.v1", counts: { total: number("total"), events: number("events"), censored: number("censored") }, estimates: { hazard_ratio: number("hazard_ratio"), confidence_interval_95: [optionalNumber("ci_lower"), optionalNumber("ci_upper")] }, diagnostics: { ph_p_value: ph, model_converged: number("converged") === 1 }, model: { formula: "Surv(duration, event) ~ exposure", limitations: ["Single-exposure Cox model; covariate adjustment requires an approved field manifest.", "Proportional-hazards and censoring assumptions require clinical review."] } };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
