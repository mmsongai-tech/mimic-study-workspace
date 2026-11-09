import type { OutcomeStructure, ResearchIntent, StudySpec } from "../research-design/study-spec.js";
import type { MimicMappingResult } from "../mimic-concept-mapping/domain/mimic-concept.js";
import type { ClinicalStudyConceptAssessment } from "../clinical-concept-catalog/index.js";

export interface StatisticalMethodProfile {
  method_id: string;
  method_version: string;
  study_family: ResearchIntent;
  outcome_structure: OutcomeStructure;
  primary_method: string;
  rationale: string;
  alternative_methods: string[];
  required_conditions: string[];
  required_diagnostics: string[];
  sensitivity_analyses: string[];
  blocking_diagnostic_codes: string[];
  minimum_report_sections: string[];
}

export type StatisticalDiagnosticState = "pass" | "warning" | "fail" | "not_evaluated";

export interface StatisticalDiagnosticObservation {
  code: string;
  state: StatisticalDiagnosticState;
  summary: string;
}

export interface StatisticalDiagnosticAssessment {
  decision: "reportable" | "reportable_with_warnings" | "blocked";
  blocking_reasons: string[];
  warnings: string[];
  observations: StatisticalDiagnosticObservation[];
}

export interface AnalysisPlan {
  schema_version: "1.0.0";
  status: "ready_for_confirmation" | "blocked";
  execution_mode: "registered" | "guarded_generated" | "none";
  registered_capability_id?: string;
  study_spec: StudySpec;
  mapping: MimicMappingResult;
  field_manifest?: Array<{ name: string; type: "number" | "integer" | "boolean" | "category"; role: string }>;
  clinical_concepts: ClinicalStudyConceptAssessment;
  method: StatisticalMethodProfile;
  blocking_requirements: string[];
  warnings: string[];
  objective_plans?: Array<{ objective_id: string; outcome: string; status: "ready_for_confirmation" | "blocked"; method?: StatisticalMethodProfile; blocking_requirements: string[] }>;
}
