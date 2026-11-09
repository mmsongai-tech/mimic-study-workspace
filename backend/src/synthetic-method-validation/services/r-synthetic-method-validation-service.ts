import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assessStatisticalDiagnostics, selectStatisticalMethod, type StatisticalDiagnosticObservation } from "../../analysis-planning/index.js";
import type { OutcomeStructure, StudySpec } from "../../research-design/index.js";
import { SyntheticMethodValidationError, type SyntheticMethodValidationResult, type SyntheticValidationScenario } from "../domain/method-validation.js";

const executeFile = promisify(execFile);
const structures: Record<SyntheticValidationScenario, OutcomeStructure> = {
  continuous_association: "continuous",
  count_association: "count",
  time_to_event_association: "time_to_event",
  repeated_measure_association: "repeated_measure",
  competing_risk_association: "competing_risk",
};

const parse = (content: string): Map<string, string> => new Map(content.trim().split("\n").map((line) => {
  const separator = line.indexOf("\t");
  if (separator < 1) throw new Error("Malformed validation output.");
  return [line.slice(0, separator), line.slice(separator + 1)];
}));

const number = (output: Map<string, string>, key: string): number => {
  const value = Number(output.get(key));
  if (!Number.isFinite(value)) throw new Error(`Missing numeric output: ${key}`);
  return value;
};

const format = (value: number): string => value.toFixed(3);

export class RSyntheticMethodValidationService {
  constructor(private readonly options: { rscript_binary: string; script_path: string; timeout_ms: number; temporary_root?: string }) {}

  async execute(scenario: SyntheticValidationScenario): Promise<SyntheticMethodValidationResult> {
    const outcomeStructure = structures[scenario];
    if (!outcomeStructure) throw new SyntheticMethodValidationError("VALIDATION_SCENARIO_UNSUPPORTED", "The synthetic validation scenario is unsupported.");
    const spec: StudySpec = { schema_version: "1.0.0", intent_family: "association", outcome_structure: outcomeStructure };
    const method = selectStatisticalMethod(spec);
    const directory = await mkdtemp(join(this.options.temporary_root ?? tmpdir(), "mimic-method-validation-"));
    try {
      const outputPath = join(directory, "result.tsv");
      const figurePath = join(directory, "estimate.svg");
      try {
        await executeFile(this.options.rscript_binary, ["--vanilla", this.options.script_path, scenario, outputPath, figurePath], {
          timeout: this.options.timeout_ms,
          maxBuffer: 256_000,
        });
      } catch (error) {
        const unavailable = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
        throw new SyntheticMethodValidationError(
          unavailable ? "VALIDATION_RUNTIME_UNAVAILABLE" : "VALIDATION_EXECUTION_FAILED",
          unavailable ? "The configured R runtime is unavailable." : "The synthetic R method validation failed.",
        );
      }
      const [rawOutput, figure] = await Promise.all([readFile(outputPath, "utf8"), readFile(figurePath, "utf8")]);
      if (!figure.includes("<svg")) throw new Error("Synthetic validation figure is invalid.");
      const output = parse(rawOutput);
      const converged = number(output, "converged") === 1;
      const diagnosticObservations: StatisticalDiagnosticObservation[] = method.blocking_diagnostic_codes.map((code) => ({
        code,
        state: code === "model_convergence" && !converged ? "fail" : "pass",
        summary: code === "model_convergence" ? (converged ? "The fitted model converged." : "The fitted model did not converge.") : "The deterministic synthetic fixture satisfies this validation condition.",
      }));
      const diagnostics = assessStatisticalDiagnostics(method, diagnosticObservations);
      const estimate = {
        term: "synthetic_exposure",
        value: number(output, "estimate"),
        confidence_interval_95: [number(output, "ci_lower"), number(output, "ci_upper")] as [number, number],
        p_value: number(output, "p_value"),
      };
      const sample = {
        observations: number(output, "observations"),
        study_units: number(output, "study_units"),
        ...(number(output, "events") > 0 ? { events: number(output, "events") } : {}),
        ...(number(output, "competing_events") > 0 ? { competing_events: number(output, "competing_events") } : {}),
        ...(number(output, "repeated_observations") > 0 ? { repeated_observations: number(output, "repeated_observations") } : {}),
      };
      const warnings = [
        "Deterministic synthetic validation only; this is not clinical, real-data, or scientific-validity evidence.",
        "Passing fixture diagnostics does not replace diagnostic evaluation on the eventual analysis dataset.",
      ];
      const report = [
        `# Synthetic validation: ${scenario.replaceAll("_", " ")}`,
        "", "## Research purpose and outcome structure", "",
        `Purpose: ${method.study_family}`, `Outcome structure: ${method.outcome_structure}`, `Method profile: ${method.method_id} (${method.method_version})`,
        "", "## Why this method", "", method.rationale,
        "", "## Required conditions", "", ...method.required_conditions.map((item) => `- ${item}`),
        "", "## Synthetic execution", "", `R method: ${output.get("method") ?? "not recorded"}`, `Observations / study units: ${sample.observations} / ${sample.study_units}`,
        `Exposure estimate: ${format(estimate.value)} (95% CI ${format(estimate.confidence_interval_95[0])}–${format(estimate.confidence_interval_95[1])})`,
        `P-value: ${estimate.p_value < 0.001 ? "<0.001" : format(estimate.p_value)}`,
        "", "## Diagnostic decision", "", `Decision: ${diagnostics.decision}`,
        ...diagnostics.observations.map(({ code, state, summary }) => `- ${code}: ${state} — ${summary}`),
        "", "## Sensitivity analyses required for a real study", "", ...method.sensitivity_analyses.map((item) => `- ${item}`),
        "", "## Interpretation boundary", "", ...warnings.map((item) => `- ${item}`),
      ].join("\n");
      return {
        schema_version: "1.0.0",
        scenario,
        evidence_level: "synthetic_execution",
        study_family: "association",
        outcome_structure: outcomeStructure,
        method,
        runtime: { language: "r", version: output.get("r_version") ?? "unknown" },
        sample,
        estimate,
        diagnostics,
        publication_outputs: { figures: [{ id: `${scenario}_estimate`, title: `Synthetic validation estimate: ${scenario.replaceAll("_", " ")}`, mime_type: "image/svg+xml", content: figure }] },
        report_markdown: report,
        warnings,
      };
    } catch (error) {
      if (error instanceof SyntheticMethodValidationError) throw error;
      throw new SyntheticMethodValidationError("VALIDATION_OUTPUT_INVALID", "The synthetic method validation output is invalid.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
