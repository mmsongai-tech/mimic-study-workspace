import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AssociationAnalysisError,
  type AssociationAnalysisResult,
  type AssociationInput,
  type AssociationStatisticalExecutor,
} from "../../domain/association-analysis.js";

const executeFile = promisify(execFile);

export interface RAssociationExecutorOptions {
  rscript_binary: string;
  script_path: string;
  temporary_root?: string;
  timeout_ms: number;
}

const escapeCsv = (value: string | number | boolean): string => {
  const text = String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const parseOutput = (content: string): Map<string, string> => new Map(
  content.trim().split("\n").map((line) => {
    const separator = line.indexOf("\t");
    if (separator < 1) throw new Error("Malformed R output.");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }),
);

const requireNumber = (output: Map<string, string>, key: string): number => {
  const value = Number(output.get(key));
  if (!Number.isFinite(value)) throw new Error(`Missing numeric R output: ${key}`);
  return value;
};

export class RAssociationStatisticalExecutor implements AssociationStatisticalExecutor {
  constructor(private readonly options: RAssociationExecutorOptions) {}

  async execute(
    input: AssociationInput,
    studyIntegrityId: string,
    threshold: number,
  ): Promise<AssociationAnalysisResult> {
    if (!Number.isFinite(threshold) || threshold <= 0) {
      throw new AssociationAnalysisError("ANALYSIS_INPUT_INVALID", "The lactate threshold is invalid.");
    }
    const directory = await mkdtemp(join(this.options.temporary_root ?? tmpdir(), "mimic-r-analysis-"));
    try {
      const inputPath = join(directory, "input.csv");
      const outputPath = join(directory, "analysis.tsv");
      const figurePath = join(directory, "group-risks.svg");
      const sensitivityFigurePath = join(directory, "threshold-sensitivity.svg");
      const rows = input.records.map((record) => [
        escapeCsv(record.synthetic_subject_id),
        escapeCsv(record.max_lactate_first_6h),
        escapeCsv(record.in_hospital_death),
        escapeCsv(record.age_years ?? ""),
        escapeCsv(record.sex ?? ""),
      ].join(","));
      await writeFile(inputPath, ["subject_id,max_lactate_first_6h,in_hospital_death,age_years,sex", ...rows].join("\n"), {
        encoding: "utf8",
        mode: 0o600,
      });
      await executeFile(this.options.rscript_binary, [
        "--vanilla",
        this.options.script_path,
        inputPath,
        outputPath,
        figurePath,
        sensitivityFigurePath,
        String(threshold),
      ], { timeout: this.options.timeout_ms, maxBuffer: 1_000_000 });
      const [rawOutput, figure, sensitivityFigure] = await Promise.all([
        readFile(outputPath, "utf8"),
        readFile(figurePath, "utf8"),
        readFile(sensitivityFigurePath, "utf8"),
      ]);
      const output = parseOutput(rawOutput);
      if (!figure.includes("<svg") || !sensitivityFigure.includes("<svg")) {
        throw new Error("R did not produce the required SVG figures.");
      }
      const adjustedStatus = output.get("adjusted_model_status") === "completed" ? "completed" : "not_estimable";
      const adjustedEstimates = adjustedStatus === "completed" ? {
        exposure_odds_ratio: requireNumber(output, "adjusted_or"),
        exposure_odds_ratio_ci_95: [requireNumber(output, "adjusted_ci_lower"), requireNumber(output, "adjusted_ci_upper")] as [number, number],
        p_value: requireNumber(output, "adjusted_p_value"),
        covariates: ["age_years", "sex"],
      } : undefined;
      const tableOne = {
        id: "table_1",
        title: "Baseline characteristics by lactate exposure group",
        columns: ["Characteristic", "Overall", "Exposed", "Unexposed"],
        rows: [
          ["Participants, n", output.get("table_total_n") ?? "—", output.get("table_exposed_n") ?? "—", output.get("table_unexposed_n") ?? "—"],
          ["Age, mean (SD), years", output.get("table_total_age") ?? "—", output.get("table_exposed_age") ?? "—", output.get("table_unexposed_age") ?? "—"],
          ["Female, n (%)", output.get("table_total_female") ?? "—", output.get("table_exposed_female") ?? "—", output.get("table_unexposed_female") ?? "—"],
          ["Lactate, median (IQR), mmol/L", output.get("table_total_lactate") ?? "—", output.get("table_exposed_lactate") ?? "—", output.get("table_unexposed_lactate") ?? "—"],
          ["In-hospital death, n (%)", output.get("table_total_death") ?? "—", output.get("table_exposed_death") ?? "—", output.get("table_unexposed_death") ?? "—"],
        ],
      };
      const sensitivityCount = requireNumber(output, "sensitivity_count");
      const thresholdResults = Array.from({ length: sensitivityCount }, (_, index) => {
        const prefix = `sensitivity_${index + 1}`;
        return {
          threshold_mmol_l: requireNumber(output, `${prefix}_threshold`),
          exposed: requireNumber(output, `${prefix}_exposed`),
          unexposed: requireNumber(output, `${prefix}_unexposed`),
          odds_ratio: requireNumber(output, `${prefix}_or`),
          odds_ratio_ci_95: [requireNumber(output, `${prefix}_ci_lower`), requireNumber(output, `${prefix}_ci_upper`)] as [number, number],
        };
      });
      const continuous = output.has("continuous_or") ? {
        odds_ratio_per_mmol_l: requireNumber(output, "continuous_or"),
        odds_ratio_ci_95: [requireNumber(output, "continuous_ci_lower"), requireNumber(output, "continuous_ci_upper")] as [number, number],
        p_value: requireNumber(output, "continuous_p_value"),
        covariates: ["age_years", "sex"],
      } : undefined;
      return {
        capability_id: "association.lactate.in_hospital_mortality.v1",
        study_integrity_id: studyIntegrityId,
        threshold_mmol_l: threshold,
        counts: {
          total: requireNumber(output, "total"),
          exposed: requireNumber(output, "exposed"),
          unexposed: requireNumber(output, "unexposed"),
          exposed_events: requireNumber(output, "exposed_events"),
          unexposed_events: requireNumber(output, "unexposed_events"),
        },
        estimates: {
          exposed_risk: requireNumber(output, "exposed_risk"),
          unexposed_risk: requireNumber(output, "unexposed_risk"),
          risk_difference: requireNumber(output, "risk_difference"),
          odds_ratio: requireNumber(output, "odds_ratio"),
          odds_ratio_ci_95: [requireNumber(output, "ci_lower"), requireNumber(output, "ci_upper")],
        },
        ...(adjustedEstimates ? { adjusted_estimates: adjustedEstimates } : {}),
        sensitivity_analyses: {
          threshold_results: thresholdResults,
          ...(continuous ? { continuous_lactate: continuous } : {}),
        },
        diagnostics: {
          complete_cases: requireNumber(output, "complete_cases"),
          missing_records: requireNumber(output, "missing_records"),
          total_events: requireNumber(output, "total_events"),
          events_per_parameter: requireNumber(output, "events_per_parameter"),
          adjusted_model_status: adjustedStatus,
          model_converged: requireNumber(output, "model_converged") === 1,
          maximum_vif: requireNumber(output, "maximum_vif"),
          confidence_interval_width_ratio: requireNumber(output, "confidence_interval_width_ratio"),
          sparse_data_warning: requireNumber(output, "sparse_data_warning") === 1,
          ...(input.provenance.cohort_audit ? {
            source_eligible_records: input.provenance.cohort_audit.eligible_first_admissions,
            source_missing_exposure: input.provenance.cohort_audit.missing_lactate,
            excluded_source_measurements: input.provenance.cohort_audit.excluded_measurements,
          } : {}),
          ...(adjustedStatus === "not_estimable" ? { adjusted_model_reason: output.get("adjusted_model_reason") ?? "Insufficient complete data." } : {}),
        },
        method: {
          id: "crude_binary_association",
          version: "1.0.0",
          zero_cell_correction: "haldane_anscombe_if_needed",
        },
        runtime: { language: "r", version: output.get("r_version") ?? "unknown" },
        publication_outputs: {
          figures: [{
            id: "group_risks",
            title: "In-hospital mortality risk by lactate exposure group",
            mime_type: "image/svg+xml",
            content: figure,
          }, {
            id: "threshold_sensitivity",
            title: "Threshold sensitivity analysis",
            mime_type: "image/svg+xml",
            content: sensitivityFigure,
          }],
          tables: [tableOne],
        },
        provenance: input.provenance,
        warnings: input.provenance.data_mode === "synthetic" ? [
          "Synthetic fixture result; not clinical or real-data evidence.",
          "Crude association does not establish a causal treatment effect.",
        ] : [
          "Real MIMIC-IV complete-case analysis; missing early lactate may introduce selection bias.",
          "Values outside the prespecified 0–30 mmol/L plausibility range were excluded.",
          "Crude and limited adjusted associations do not establish a causal treatment effect.",
        ],
      };
    } catch (error) {
      if (error instanceof AssociationAnalysisError) throw error;
      throw new AssociationAnalysisError("ANALYSIS_EXECUTION_FAILED", "R statistical execution failed.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
