export type ClinicalConceptCategory =
  | "demographic"
  | "encounter"
  | "vital_sign"
  | "laboratory"
  | "medication"
  | "intervention"
  | "diagnosis"
  | "score"
  | "outcome";

export type ClinicalValueType = "binary" | "categorical" | "continuous" | "count" | "date_time" | "duration";
export type ClinicalMeasurementMultiplicity = "single" | "repeatable" | "event" | "interval";
export type ClinicalConceptResolutionStatus = "resolved" | "ambiguous" | "unresolved";

export interface ClinicalConceptDefinition {
  id: string;
  label: string;
  localized_labels: Record<string, string>;
  synonyms: string[];
  category: ClinicalConceptCategory;
  value_type: ClinicalValueType;
  canonical_unit?: string;
  compatible_units?: string[];
  measurement_multiplicity: ClinicalMeasurementMultiplicity;
  supported_aggregations: Array<"first" | "last" | "minimum" | "maximum" | "mean" | "median" | "sum" | "standard_deviation" | "any" | "count">;
  temporal_requirements: string[];
  missingness_notes: string[];
  plausibility_rule?: string;
  source_requirements: string[];
  mapping_status: "concept_defined" | "source_mapping_required";
  definition_version: string;
}

export interface ClinicalConceptRequest {
  role: "population" | "index_time" | "exposure" | "predictor" | "outcome" | "covariate";
  text: string;
}

export interface ClinicalConceptResolution {
  request: ClinicalConceptRequest;
  status: ClinicalConceptResolutionStatus;
  concept?: ClinicalConceptDefinition;
  candidate_concept_ids: string[];
  requirements: string[];
  warnings: string[];
}

export interface ClinicalStudyConceptAssessment {
  status: "ready_for_source_mapping" | "needs_clarification";
  resolutions: ClinicalConceptResolution[];
  blocking_requirements: string[];
}
