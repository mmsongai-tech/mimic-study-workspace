import type { OutcomeStructure, ResearchIntent } from "../../research-design/index.js";
import type { StatisticalDiagnosticAssessment, StatisticalMethodProfile } from "../../analysis-planning/index.js";

export type SyntheticValidationScenario =
  | "continuous_association"
  | "count_association"
  | "time_to_event_association"
  | "repeated_measure_association"
  | "competing_risk_association";

export interface SyntheticMethodValidationResult {
  schema_version: "1.0.0";
  scenario: SyntheticValidationScenario;
  evidence_level: "synthetic_execution";
  study_family: ResearchIntent;
  outcome_structure: OutcomeStructure;
  method: StatisticalMethodProfile;
  runtime: { language: "r"; version: string };
  sample: { observations: number; study_units: number; events?: number; competing_events?: number; repeated_observations?: number };
  estimate: { term: string; value: number; confidence_interval_95: [number, number]; p_value: number };
  diagnostics: StatisticalDiagnosticAssessment;
  publication_outputs: { figures: Array<{ id: string; title: string; mime_type: "image/svg+xml"; content: string }> };
  report_markdown: string;
  warnings: string[];
}

export class SyntheticMethodValidationError extends Error {
  constructor(
    public readonly code: "VALIDATION_SCENARIO_UNSUPPORTED" | "VALIDATION_RUNTIME_UNAVAILABLE" | "VALIDATION_EXECUTION_FAILED" | "VALIDATION_OUTPUT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SyntheticMethodValidationError";
  }
}
