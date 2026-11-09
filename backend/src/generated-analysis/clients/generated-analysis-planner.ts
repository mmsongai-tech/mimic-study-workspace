import type { AnalysisPlan } from "../../analysis-planning/analysis-plan.js";
import type { GeneratedAnalysisPlan } from "../domain/generated-analysis.js";

export interface GeneratedAnalysisPlanner {
  propose(input: {
    analysis_plan: AnalysisPlan;
    field_manifest: Array<{ name: string; type: "number" | "integer" | "boolean" | "category"; role: string }>;
    allowed_language: "python" | "r";
    allowed_packages: string[];
  }): Promise<GeneratedAnalysisPlan>;
}

