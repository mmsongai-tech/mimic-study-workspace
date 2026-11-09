import type { AnalysisPlan } from "../../analysis-planning/analysis-plan.js";
import type { GeneratedAnalysisPlanner } from "../clients/generated-analysis-planner.js";
import type { GeneratedAnalysisResult } from "../domain/generated-analysis.js";
import { GeneratedAnalysisError } from "../domain/generated-analysis.js";

export interface GeneratedAnalysisExecutor {
  execute(plan: Awaited<ReturnType<GeneratedAnalysisPlanner["propose"]>>, controlledInput: unknown): Promise<GeneratedAnalysisResult>;
}

export class GuardedGeneratedAnalysisWorkflow {
  constructor(private readonly dependencies: {
    planner: GeneratedAnalysisPlanner;
    executor: GeneratedAnalysisExecutor;
  }) {}

  async execute(input: {
    analysis_plan: AnalysisPlan;
    field_manifest: Array<{ name: string; type: "number" | "integer" | "boolean" | "category"; role: string }>;
    controlled_input: unknown;
    language: "python" | "r";
    allowed_packages: string[];
    allowed_result_keys: string[];
  }): Promise<GeneratedAnalysisResult> {
    if (input.analysis_plan.status !== "ready_for_confirmation" || input.analysis_plan.execution_mode !== "guarded_generated") {
      throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "The analysis plan is not approved for guarded generated execution.");
    }
    if (!input.field_manifest.length) {
      throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "A verified field manifest is required.");
    }
    if (!input.allowed_result_keys.length) {
      throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "A pre-approved aggregate result contract is required.");
    }
    const generated = await this.dependencies.planner.propose({
      analysis_plan: input.analysis_plan,
      field_manifest: input.field_manifest,
      allowed_language: input.language,
      allowed_packages: input.allowed_packages,
    });
    if (generated.study_family !== input.analysis_plan.method.study_family || generated.language !== input.language) {
      throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "The generated plan changed the approved study family or language.");
    }
    const unapprovedRequiredKeys = generated.required_result_keys.filter((key) => !input.allowed_result_keys.includes(key));
    if (unapprovedRequiredKeys.length) {
      throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "The generated plan expanded the approved aggregate result contract.", unapprovedRequiredKeys);
    }
    const result = await this.dependencies.executor.execute(generated, input.controlled_input);
    const unapprovedOutputKeys = Object.keys(result.aggregate_result).filter((key) => !input.allowed_result_keys.includes(key));
    if (unapprovedOutputKeys.length) {
      throw new GeneratedAnalysisError("GENERATED_OUTPUT_INVALID", "The generated result expanded the approved aggregate result contract.", unapprovedOutputKeys);
    }
    return result;
  }
}
