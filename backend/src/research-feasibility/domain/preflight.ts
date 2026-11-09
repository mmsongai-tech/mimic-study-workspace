import type { ConfirmedStudySpec } from "../../research-design/design-session.js";

export interface DataSourceDescriptor {
  id: string;
  version: string;
  available_concepts: string[];
  data_mode: "synthetic" | "approved_safety_database";
}

export interface PreflightResult {
  status: "supported" | "unsupported";
  confirmed_study_integrity_id: string;
  capability_id?: string;
  data_source: { id: string; version: string; data_mode: DataSourceDescriptor["data_mode"] };
  missing_requirements: string[];
  warnings: string[];
  evidence_class: "catalog_match";
}

export interface ResearchCapability {
  id: string;
  intent_family: "association" | "prediction" | "treatment_effect";
  analysis_family: "association" | "binary_prediction" | "propensity_weighted_treatment_effect";
  exposure_concepts: string[];
  outcome_concepts: string[];
  required_data_concepts: string[];
  unsupported_summary_measure_terms: string[];
}

export type PreflightInput = {
  study: ConfirmedStudySpec;
  data_source: DataSourceDescriptor;
};
