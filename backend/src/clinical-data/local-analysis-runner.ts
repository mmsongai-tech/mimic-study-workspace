import { executeAggregateBinaryAssociation } from "../association-analysis/aggregate-binary-association.js";
import { executeAggregateContinuousAssociation } from "../association-analysis/aggregate-continuous-association.js";
import type { RCoxSurvivalExecutor } from "../association-analysis/cox-survival-executor.js";
import type { PredictionAnalysisResult, PredictionStatisticalExecutor } from "../prediction-analysis/domain/prediction-analysis.js";
import type { TreatmentEffectAnalysisResult, TreatmentEffectStatisticalExecutor } from "../treatment-effect-analysis/domain/treatment-effect-analysis.js";
import { buildCoxRecords, buildContinuousGroups, buildPredictionRecords, buildTreatmentRecords, collectManifestRows, type AnalysisInputManifest, type CohortQualitySummary, type LocalMimicRowSource } from "./local-analysis-inputs.js";
import { buildLocalBinaryCohort } from "./local-cohort-builder.js";

export type LocalAnalysisFamily = "binary_association" | "continuous_association" | "time_to_event_association" | "binary_prediction" | "binary_treatment_effect";
export interface LocalAnalysisRunnerOptions { cox?: RCoxSurvivalExecutor; prediction?: PredictionStatisticalExecutor; treatment_effect?: TreatmentEffectStatisticalExecutor; provenance?: { data_source_id: string; data_source_version: string; data_mode: "local_mimic_archive" }; study_integrity_id?: string; }
export interface LocalAnalysisRunResult { family: LocalAnalysisFamily; quality: CohortQualitySummary; result: unknown; }

export class LocalAnalysisRunner {
  constructor(private readonly options: LocalAnalysisRunnerOptions = {}) {}

  async run(family: LocalAnalysisFamily, source: LocalMimicRowSource, manifest: AnalysisInputManifest): Promise<LocalAnalysisRunResult> {
    const provenance = this.options.provenance ?? { data_source_id: "local-mimic", data_source_version: "unversioned", data_mode: "local_mimic_archive" as const };
    if (family === "binary_association") { const cohort = await this.collectBinary(source, manifest); return { family, quality: cohort.quality, result: executeAggregateBinaryAssociation(cohort.counts) }; }
    if (family === "continuous_association") { const input = await buildContinuousGroups(source, manifest); return { family, quality: input.quality, result: executeAggregateContinuousAssociation(input.groups) }; }
    if (family === "time_to_event_association") { if (!this.options.cox) throw new Error("No Cox executor is registered for this manifest."); const input = await buildCoxRecords(source, manifest); return { family, quality: input.quality, result: await this.options.cox.execute(input.records) }; }
    if (family === "binary_prediction") { if (!this.options.prediction) throw new Error("No prediction executor is registered for this manifest."); const input = await buildPredictionRecords(source, manifest); if (!input.records.length) throw new Error("The prediction manifest produced no complete records."); return { family, quality: input.quality, result: await this.options.prediction.execute({ records: input.records, provenance: { ...provenance, retrieved_at: new Date().toISOString() } }, this.options.study_integrity_id ?? "local-study") }; }
    if (!this.options.treatment_effect) throw new Error("No treatment-effect executor is registered for this manifest."); const input = await buildTreatmentRecords(source, manifest); if (!input.records.length) throw new Error("The treatment manifest produced no complete records."); return { family, quality: input.quality, result: await this.options.treatment_effect.execute({ records: input.records, provenance: { ...provenance, retrieved_at: new Date().toISOString() } }, this.options.study_integrity_id ?? "local-study") };
  }

  private async collectBinary(source: LocalMimicRowSource, manifest: AnalysisInputManifest): Promise<{ counts: { exposed_events: number; exposed_non_events: number; unexposed_events: number; unexposed_non_events: number }; quality: CohortQualitySummary }> {
    const collected = await collectManifestRows(source, manifest);
    const result = buildLocalBinaryCohort(collected.rows, { exposure: manifest.exposure, outcome: manifest.outcome, exposure_values: [true, 1, "1", "true"], event_values: [true, 1, "1", "true"] });
    return { counts: result.counts, quality: { ...collected.quality, complete_rows: collected.rows.length - result.rows_excluded, excluded_rows: collected.quality.excluded_rows + result.rows_excluded, exclusion_reasons: { ...collected.quality.exclusion_reasons, ...result.exclusion_reasons } } };
  }
}
