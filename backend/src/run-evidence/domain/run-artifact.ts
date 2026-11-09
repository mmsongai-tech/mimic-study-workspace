import type { AssociationAnalysisResult } from "../../association-analysis/domain/association-analysis.js";
import type { PredictionAnalysisResult } from "../../prediction-analysis/domain/prediction-analysis.js";
import type { TreatmentEffectAnalysisResult } from "../../treatment-effect-analysis/domain/treatment-effect-analysis.js";
import type { ConfirmedStudySpec } from "../../research-design/design-session.js";
import type { PreflightResult } from "../../research-feasibility/domain/preflight.js";
import type { StatisticalDiagnosticAssessment, StatisticalMethodProfile } from "../../analysis-planning/index.js";

export interface RunArtifact {
  schema_version: "1.0.0";
  run_id: string;
  created_at: string;
  evidence_level: "synthetic_execution" | "approved_safety_database_execution";
  study: ConfirmedStudySpec;
  preflight: PreflightResult;
  analysis: AssociationAnalysisResult | PredictionAnalysisResult | TreatmentEffectAnalysisResult;
  statistical_review?: {
    method: StatisticalMethodProfile;
    diagnostics: StatisticalDiagnosticAssessment;
    interpretation_status: "allowed" | "allowed_with_warnings" | "blocked";
  };
  integrity_id: string;
}

export interface RunEvidenceBundle {
  artifact: RunArtifact;
  report_markdown: string;
  report_rtf?: string;
}

export class RunEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunEvidenceError";
  }
}
