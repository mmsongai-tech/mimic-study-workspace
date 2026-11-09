import type { ConfirmedStudySpec } from "../../research-design/design-session.js";
import type { PreflightResult } from "../../research-feasibility/domain/preflight.js";

export interface VasopressorTreatmentRecord {
  synthetic_subject_id: string;
  early_vasopressor: boolean;
  in_hospital_death: boolean;
  age_years: number;
  sofa_score: number;
  baseline_lactate: number;
  sex: "female" | "male";
}

export interface TreatmentEffectInput {
  records: VasopressorTreatmentRecord[];
  provenance: { data_source_id: string; data_source_version: string; data_mode: "synthetic" | "approved_safety_database" | "local_mimic_archive"; retrieved_at: string };
}

export interface TreatmentEffectAnalysisResult {
  capability_id: "treatment_effect.early_vasopressor.in_hospital_mortality.v1";
  analysis_kind: "propensity_weighted_treatment_effect";
  study_integrity_id: string;
  counts: { total: number; treated: number; untreated: number; treated_events: number; untreated_events: number };
  estimates: { weighted_treated_risk: number; weighted_untreated_risk: number; risk_difference: number; risk_ratio: number; risk_difference_ci_95: [number, number] };
  diagnostics: { complete_cases: number; missing_records: number; propensity_model_converged: boolean; maximum_smd_before: number; maximum_smd_after: number; effective_sample_size: number; extreme_weight_fraction: number; bootstrap_replicates: number };
  method: { id: "iptw_average_treatment_effect"; version: "1.0.0"; weight_strategy: "stabilized_truncated_1_99"; uncertainty: "percentile_bootstrap" };
  runtime: { language: "r"; version: string };
  publication_outputs: { figures: Array<{ id: string; title: string; mime_type: "image/svg+xml"; content: string }>; tables: Array<{ id: string; title: string; columns: string[]; rows: string[][] }> };
  provenance: TreatmentEffectInput["provenance"];
  warnings: string[];
}

export interface TreatmentEffectExecutionRequest { study: ConfirmedStudySpec; preflight: PreflightResult }
export interface TreatmentEffectGateway { load(): Promise<TreatmentEffectInput> }
export interface TreatmentEffectStatisticalExecutor { execute(input: TreatmentEffectInput, studyIntegrityId: string): Promise<TreatmentEffectAnalysisResult> }
export class TreatmentEffectAnalysisError extends Error { constructor(public readonly code:"ANALYSIS_UNSUPPORTED"|"ANALYSIS_INPUT_INVALID"|"ANALYSIS_DATA_UNAVAILABLE"|"ANALYSIS_EXECUTION_FAILED",message:string){super(message);this.name="TreatmentEffectAnalysisError";} }
