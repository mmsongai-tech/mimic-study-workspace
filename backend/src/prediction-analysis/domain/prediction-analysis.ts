import type { ConfirmedStudySpec } from "../../research-design/design-session.js";
import type { PreflightResult } from "../../research-feasibility/domain/preflight.js";

export interface VentilationPredictionRecord {
  synthetic_subject_id: string;
  age_years: number;
  respiratory_rate: number;
  spo2_fio2_ratio: number;
  gcs: number;
  invasive_ventilation_24h: boolean;
}

export interface PredictionInput {
  records: VentilationPredictionRecord[];
  provenance: { data_source_id: string; data_source_version: string; data_mode: "synthetic" | "approved_safety_database" | "local_mimic_archive"; retrieved_at: string };
}

export interface PredictionAnalysisResult {
  capability_id: "prediction.invasive_ventilation_24h.v1";
  analysis_kind: "binary_prediction";
  study_integrity_id: string;
  counts: { total: number; development: number; validation: number; validation_events: number };
  estimates: { auroc: number; brier_score: number; calibration_intercept: number; calibration_slope: number; sensitivity: number; specificity: number; probability_threshold: number };
  diagnostics: { complete_cases: number; missing_records: number; model_converged: boolean; events_per_parameter: number };
  method: { id: "logistic_prediction_internal_validation"; version: "1.0.0"; validation: "deterministic_70_30_split"; threshold_selection: "development_youden" };
  runtime: { language: "r"; version: string };
  publication_outputs: { figures: Array<{ id: string; title: string; mime_type: "image/svg+xml"; content: string }>; tables: Array<{ id: string; title: string; columns: string[]; rows: string[][] }> };
  provenance: PredictionInput["provenance"];
  warnings: string[];
}

export interface PredictionExecutionRequest { study: ConfirmedStudySpec; preflight: PreflightResult }
export interface PredictionGateway { load(): Promise<PredictionInput> }
export interface PredictionStatisticalExecutor { execute(input: PredictionInput, studyIntegrityId: string): Promise<PredictionAnalysisResult> }
export class PredictionAnalysisError extends Error { constructor(public readonly code:"ANALYSIS_UNSUPPORTED"|"ANALYSIS_INPUT_INVALID"|"ANALYSIS_DATA_UNAVAILABLE"|"ANALYSIS_EXECUTION_FAILED",message:string){super(message);this.name="PredictionAnalysisError";} }
