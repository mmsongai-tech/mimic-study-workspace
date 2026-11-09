import type { ConfirmedStudySpec } from "../../research-design/design-session.js";
import type { PreflightResult } from "../../research-feasibility/domain/preflight.js";

export interface LactateMortalityRecord {
  synthetic_subject_id: string;
  max_lactate_first_6h: number;
  in_hospital_death: boolean;
  age_years?: number;
  sex?: "female" | "male";
}

export interface AssociationInput {
  records: LactateMortalityRecord[];
  provenance: {
    data_source_id: string;
    data_source_version: string;
    data_mode: "synthetic" | "approved_safety_database";
    retrieved_at: string;
    cohort_audit?: {
      eligible_first_admissions: number;
      missing_lactate: number;
      excluded_measurements: number;
    };
  };
}

export interface AssociationAnalysisResult {
  capability_id: "association.lactate.in_hospital_mortality.v1";
  study_integrity_id: string;
  threshold_mmol_l: number;
  counts: {
    total: number;
    exposed: number;
    unexposed: number;
    exposed_events: number;
    unexposed_events: number;
  };
  estimates: {
    exposed_risk: number;
    unexposed_risk: number;
    risk_difference: number;
    odds_ratio: number;
    odds_ratio_ci_95: [number, number];
  };
  adjusted_estimates?: {
    exposure_odds_ratio: number;
    exposure_odds_ratio_ci_95: [number, number];
    p_value: number;
    covariates: string[];
  };
  sensitivity_analyses?: {
    threshold_results: Array<{
      threshold_mmol_l: number;
      exposed: number;
      unexposed: number;
      odds_ratio: number;
      odds_ratio_ci_95: [number, number];
    }>;
    continuous_lactate?: {
      odds_ratio_per_mmol_l: number;
      odds_ratio_ci_95: [number, number];
      p_value: number;
      covariates: string[];
    };
  };
  diagnostics?: {
    complete_cases: number;
    missing_records: number;
    total_events: number;
    events_per_parameter: number;
    adjusted_model_status: "completed" | "not_estimable";
    adjusted_model_reason?: string;
    model_converged?: boolean;
    maximum_vif?: number;
    confidence_interval_width_ratio?: number;
    sparse_data_warning?: boolean;
    source_eligible_records?: number;
    source_missing_exposure?: number;
    excluded_source_measurements?: number;
  };
  method: {
    id: "crude_binary_association";
    version: "1.0.0";
    zero_cell_correction: "haldane_anscombe_if_needed";
  };
  runtime?: {
    language: "typescript" | "r" | "python";
    version: string;
  };
  publication_outputs?: {
    figures: Array<{
      id: string;
      title: string;
      mime_type: "image/svg+xml";
      content: string;
    }>;
    tables?: Array<{
      id: string;
      title: string;
      columns: string[];
      rows: string[][];
    }>;
  };
  provenance: AssociationInput["provenance"];
  warnings: string[];
}

export interface AssociationExecutionRequest {
  study: ConfirmedStudySpec;
  preflight: PreflightResult;
  threshold_mmol_l: number;
}

export class AssociationAnalysisError extends Error {
  constructor(
    public readonly code:
      | "ANALYSIS_UNSUPPORTED"
      | "ANALYSIS_INPUT_INVALID"
      | "ANALYSIS_DATA_UNAVAILABLE"
      | "ANALYSIS_EXECUTION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "AssociationAnalysisError";
  }
}

export interface AssociationStatisticalExecutor {
  execute(
    input: AssociationInput,
    studyIntegrityId: string,
    threshold: number,
  ): Promise<AssociationAnalysisResult>;
}
