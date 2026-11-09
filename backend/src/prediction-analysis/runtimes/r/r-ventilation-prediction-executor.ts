import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PredictionAnalysisResult, PredictionInput, PredictionStatisticalExecutor } from "../../domain/prediction-analysis.js";

const executeFile = promisify(execFile);
const parse = (value: string) => new Map(value.trim().split("\n").map((line) => { const at = line.indexOf("\t"); if (at < 1) throw new Error("Malformed R output"); return [line.slice(0, at), line.slice(at + 1)]; }));
const number = (values: Map<string, string>, key: string) => { const value = Number(values.get(key)); if (!Number.isFinite(value)) throw new Error(`Missing ${key}`); return value; };

export class RVentilationPredictionExecutor implements PredictionStatisticalExecutor {
  constructor(private readonly options: { rscript_binary: string; script_path: string; timeout_ms: number; temporary_root?: string }) {}
  async execute(input: PredictionInput, studyIntegrityId: string): Promise<PredictionAnalysisResult> {
    const directory = await mkdtemp(join(this.options.temporary_root ?? tmpdir(), "mimic-r-prediction-"));
    try {
      const inputPath = join(directory, "input.csv"); const outputPath = join(directory, "output.tsv");
      const rocPath = join(directory, "roc.svg"); const calibrationPath = join(directory, "calibration.svg");
      const rows = input.records.map((r) => [r.synthetic_subject_id, r.age_years, r.respiratory_rate, r.spo2_fio2_ratio, r.gcs, Number(r.invasive_ventilation_24h)].join(","));
      await writeFile(inputPath, ["subject_id,age_years,respiratory_rate,spo2_fio2_ratio,gcs,outcome", ...rows].join("\n"), { mode: 0o600 });
      await executeFile(this.options.rscript_binary, ["--vanilla", this.options.script_path, inputPath, outputPath, rocPath, calibrationPath], { timeout: this.options.timeout_ms, maxBuffer: 1_000_000 });
      const [raw, roc, calibration] = await Promise.all([readFile(outputPath, "utf8"), readFile(rocPath, "utf8"), readFile(calibrationPath, "utf8")]);
      const values = parse(raw);
      return {
        capability_id: "prediction.invasive_ventilation_24h.v1", analysis_kind: "binary_prediction", study_integrity_id: studyIntegrityId,
        counts: { total: number(values,"total"), development: number(values,"development"), validation: number(values,"validation"), validation_events: number(values,"validation_events") },
        estimates: { auroc: number(values,"auroc"), brier_score: number(values,"brier"), calibration_intercept: number(values,"calibration_intercept"), calibration_slope: number(values,"calibration_slope"), sensitivity: number(values,"sensitivity"), specificity: number(values,"specificity"), probability_threshold: number(values,"probability_threshold") },
        diagnostics: { complete_cases: number(values,"total"), missing_records: number(values,"missing_records"), model_converged: number(values,"converged") === 1, events_per_parameter: number(values,"events_per_parameter") },
        method: { id: "logistic_prediction_internal_validation", version: "1.0.0", validation: "deterministic_70_30_split", threshold_selection: "development_youden" }, runtime: { language: "r", version: values.get("r_version") ?? "unknown" },
        publication_outputs: { figures: [{ id:"roc_curve", title:"ROC curve", mime_type:"image/svg+xml", content:roc }, { id:"calibration_plot", title:"Calibration plot", mime_type:"image/svg+xml", content:calibration }], tables: [{ id:"model_coefficients", title:"Prediction model coefficients", columns:["Predictor","Coefficient"], rows:[["Age",values.get("coefficient_age")??"—"],["Respiratory rate",values.get("coefficient_rr")??"—"],["SpO2/FiO2 ratio",values.get("coefficient_ratio")??"—"],["GCS",values.get("coefficient_gcs")??"—"]] }] },
        provenance: input.provenance, warnings: ["Synthetic internal validation only; external clinical validity is not established.", "The model must not be used for patient-level decisions."],
      };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
