import { createHash } from "node:crypto";
import { executeAggregateBinaryAssociation } from "../association-analysis/aggregate-binary-association.js";
import type { AnalysisInputManifest, LocalMimicRowSource } from "./local-analysis-inputs.js";
import { LocalAnalysisRunner, type LocalAnalysisFamily, type LocalAnalysisRunResult } from "./local-analysis-runner.js";

export interface ValidationScenario { id: string; label: string; manifest: AnalysisInputManifest; }
export interface ValidationScenarioResult { id: string; label: string; status: "passed" | "blocked"; run?: LocalAnalysisRunResult; blocking_reason?: string; }
export interface ValidationSuiteResult { schema_version: "1.0.0"; family: LocalAnalysisFamily; scenarios: ValidationScenarioResult[]; stability: { repeated_baseline_equal: boolean }; }

export const runAnalysisValidationSuite = async (input: { family: LocalAnalysisFamily; baseline: ValidationScenario; sensitivity: ValidationScenario[]; source: (scenario: ValidationScenario) => LocalMimicRowSource; runner?: LocalAnalysisRunner }): Promise<ValidationSuiteResult> => {
  const runner = input.runner ?? new LocalAnalysisRunner(); const scenarios = [input.baseline, ...input.sensitivity]; const results: ValidationScenarioResult[] = [];
  for (const scenario of scenarios) { try { results.push({ id: scenario.id, label: scenario.label, status: "passed", run: await runner.run(input.family, input.source(scenario), scenario.manifest) }); } catch (error) { results.push({ id: scenario.id, label: scenario.label, status: "blocked", blocking_reason: error instanceof Error ? error.message : "Analysis scenario was blocked." }); } }
  let repeated_baseline_equal = false;
  try { const first = await runner.run(input.family, input.source(input.baseline), input.baseline.manifest); const second = await runner.run(input.family, input.source(input.baseline), input.baseline.manifest); repeated_baseline_equal = JSON.stringify(first.result) === JSON.stringify(second.result) && JSON.stringify(first.quality) === JSON.stringify(second.quality); } catch { repeated_baseline_equal = false; }
  return { schema_version: "1.0.0", family: input.family, scenarios: results, stability: { repeated_baseline_equal } };
};

export const createReproducibleAnalysisReport = (input: { study: unknown; manifest: unknown; method: unknown; data_provenance: unknown; validation: ValidationSuiteResult }): Record<string, unknown> => {
  const body = { schema_version: "1.0.0", study: input.study, manifest: input.manifest, method: input.method, data_provenance: input.data_provenance, validation: input.validation };
  return { ...body, report_integrity_id: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}` };
};

/** Validates a privacy-preserving full-data aggregate profile without reconstructing patient rows. */
export const validateAggregateBinaryProfile = (input: {
  label: string;
  counts: { exposed_events: number; exposed_non_events: number; unexposed_events: number; unexposed_non_events: number };
}): ValidationSuiteResult => {
  const first = executeAggregateBinaryAssociation(input.counts);
  const second = executeAggregateBinaryAssociation(input.counts);
  const total = Object.values(input.counts).reduce((sum, value) => sum + value, 0);
  return {
    schema_version: "1.0.0",
    family: "binary_association",
    scenarios: [{
      id: "full-local-profile",
      label: input.label,
      status: "passed",
      run: {
        family: "binary_association",
        quality: { rows_seen: total, complete_rows: total, excluded_rows: 0, exclusion_reasons: {}, strata_counts: {} },
        result: first,
      },
    }],
    stability: { repeated_baseline_equal: JSON.stringify(first) === JSON.stringify(second) },
  };
};
