export interface MimicIvFieldCandidate {
  module: "hosp" | "icu" | "derived";
  table: string;
  columns: string[];
  dictionary_table?: "d_items" | "d_labitems" | "d_icd_diagnoses" | "d_icd_procedures" | "prescriptions_drug";
}

export interface MimicConceptCatalog { list(): MimicConceptDefinition[]; }

export interface MimicConceptDefinition {
  id: string;
  label: string;
  synonyms: string[];
  field_candidates: MimicIvFieldCandidate[];
  requires_dictionary_resolution: boolean;
}

export interface RequestedStudyConcept {
  role: "population" | "index_time" | "exposure" | "predictor" | "outcome" | "covariate";
  text: string;
}

export interface MimicConceptMatch {
  requested: RequestedStudyConcept;
  status: "mapped" | "requires_dictionary_resolution" | "unmapped";
  concept_id?: string;
  label?: string;
  field_candidates: MimicIvFieldCandidate[];
  warnings: string[];
}

export interface MimicMappingResult {
  schema_version: "1.0.0";
  data_model: "MIMIC-IV";
  matches: MimicConceptMatch[];
  blocking_requirements: string[];
}
