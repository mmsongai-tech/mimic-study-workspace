import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ResearchIntent, OutcomeStructure } from "../research-design/index.js";
import type { ProjectedAnalysisRow } from "./local-execution-graph-runner.js";
import { buildPublicationOutputs, type PublicationOutputs } from "./publication-output-builder.js";

const executeFile = promisify(execFile);
const CSV_MISSING_VALUE = "__MIMIC_INTERNAL_MISSING__";
const csv = (value: unknown): string => { const text = value === undefined || value === null ? CSV_MISSING_VALUE : String(value); return /[",\n]/u.test(text) ? `"${text.replaceAll('"','""')}"` : text; };
const parse = (text: string): Record<string, string | number | boolean | null> => Object.fromEntries(text.trim().split(/\r?\n/u).map((line) => { const at = line.indexOf("\t"); const raw = line.slice(at + 1); const number = Number(raw); return [line.slice(0, at), raw === "NA" || raw === "NaN" ? null : Number.isFinite(number) ? number : raw === "TRUE" ? true : raw === "FALSE" ? false : raw]; }));

export interface GenericStatisticalResult { status: "completed"; study_family: ResearchIntent; outcome_structure: OutcomeStructure; registered_method_id: string; registered_method_version: string; method: string; counts: Record<string, number | null>; estimates: Record<string, number | string | null>; diagnostics: Record<string, number | boolean | null>; sensitivity: { analysis: string; estimate: number | null }; publication_outputs: PublicationOutputs; runtime: { language: "r"; version: string }; }

/** Runs one generic, manifest-shaped statistical model without study-specific column names. */
export class GenericRAnalysisExecutor {
  constructor(private readonly options: { rscript_binary: string; script_path: string; timeout_ms: number; temporary_root?: string }) {}
  async execute(input: { rows: ProjectedAnalysisRow[]; study_family: ResearchIntent; outcome_structure: OutcomeStructure; registered_method_id?: string; registered_method_version?: string }): Promise<GenericStatisticalResult> {
    const directory = await mkdtemp(join(this.options.temporary_root ?? tmpdir(), "mimic-generic-r-"));
    try {
      const columns = [...new Set(input.rows.flatMap((row) => Object.keys(row)))]; const inputPath = join(directory,"input.csv"); const outputPath = join(directory,"output.tsv");
      await writeFile(inputPath, [columns.join(","), ...input.rows.map((row) => columns.map((column) => csv(row[column])).join(","))].join("\n"), { mode: 0o600 });
      await executeFile(this.options.rscript_binary, ["--vanilla", this.options.script_path, inputPath, outputPath, input.study_family, input.outcome_structure], { timeout: this.options.timeout_ms, maxBuffer: 1_000_000 });
      const values = parse(await readFile(outputPath,"utf8")); const numeric = (key: string): number | null => typeof values[key] === "number" ? values[key] as number : null;
      const oddsRatioScale = input.study_family === "association" && input.outcome_structure === "binary";
      const estimates = Object.fromEntries(["estimate","ci_lower","ci_upper","ci_method","effect_scale","risk_exposed","risk_unexposed","risk_difference","risk_difference_ci_lower","risk_difference_ci_upper","treated_outcome","untreated_outcome","risk_treated","risk_untreated","mean_treated","mean_untreated","auroc","brier","interaction_estimate","interaction_effect_scale","interaction_ci_lower","interaction_ci_upper","stratum_1_level","stratum_1_treated_outcome","stratum_1_untreated_outcome","stratum_1_effect","stratum_1_ci_lower","stratum_1_ci_upper","stratum_2_level","stratum_2_treated_outcome","stratum_2_untreated_outcome","stratum_2_effect","stratum_2_ci_lower","stratum_2_ci_upper"].filter((key)=>values[key]!==undefined).map((key)=>[key,values[key] as number|string|null]));
      if (oddsRatioScale) {
        for (const key of ["estimate", "ci_lower", "ci_upper"] as const) if (typeof estimates[key] === "number") estimates[key] = Math.exp(estimates[key]);
        estimates.effect_scale = "odds_ratio";
      }
      const sensitivityEstimate = numeric("sensitivity_estimate");
      const result = { status:"completed" as const, study_family:input.study_family, outcome_structure:input.outcome_structure, registered_method_id:input.registered_method_id ?? `${input.study_family}.${input.outcome_structure}.v1`, registered_method_version:input.registered_method_version ?? "1.0.0", method:String(values.method ?? "unknown"), counts:{ total:numeric("total"), complete:numeric("complete"), missing:numeric("missing"), events:numeric("events"), exposed:numeric("exposed"), unexposed:numeric("unexposed"), exposed_events:numeric("exposed_events"), unexposed_events:numeric("unexposed_events") }, estimates, diagnostics:Object.fromEntries(["converged","parameters","events_per_parameter","effective_sample_size","sensitivity_at_0_5","specificity_at_0_5","calibration_intercept","calibration_slope","propensity_minimum","propensity_maximum","maximum_weighted_smd","zero_variance_adjustments_dropped"].map((key)=>[key,key==="converged"?numeric(key)===1:numeric(key)])), sensitivity:{ analysis:String(values.sensitivity ?? "none"), estimate:oddsRatioScale && sensitivityEstimate !== null ? Math.exp(sensitivityEstimate) : sensitivityEstimate }, runtime:{ language:"r" as const, version:String(values.r_version ?? "unknown") } };
      const allModelColumns = [...new Set(input.rows.flatMap((row) => Object.keys(row)).filter((key) => key === "exposure" || key === "outcome" || /^(predictor|covariate|effect_modifier)_/u.test(key)))];
      const zeroVarianceAdjustments = allModelColumns.filter((key) => /^(predictor|covariate)_/u.test(key) && new Set(input.rows.map((row) => row[key]).filter((value) => value !== undefined && value !== null && value !== "").map(String)).size < 2);
      const modelColumns = allModelColumns.filter((key) => !zeroVarianceAdjustments.includes(key));
      const completeRows = input.rows.filter((row) => modelColumns.every((key) => row[key] !== undefined && row[key] !== null && row[key] !== ""));
      const publicationRows: ProjectedAnalysisRow[] = completeRows.map((row) => {
        const projected = { ...row };
        for (const key of zeroVarianceAdjustments) delete projected[key];
        return projected;
      });
      return { ...result, publication_outputs: buildPublicationOutputs(publicationRows, result) };
    } finally { await rm(directory,{recursive:true,force:true}); }
  }
}
