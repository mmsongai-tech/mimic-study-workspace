import type { ResearchAnalysisPlanService } from "../analysis-planning/index.js";
import {
  GeneratedAnalysisService,
  GuardedGeneratedAnalysisWorkflow,
  OpenAiCompatibleGeneratedAnalysisPlanner,
} from "../generated-analysis/index.js";
import {
  GuardedResearchWorkflowService,
  type GuardedRunEvidenceRepository,
} from "../research-workflow/index.js";
import type { BackendRuntimeConfig } from "./runtime-config.js";
import type { ProductPromptRegistry } from "./product-prompt-registry.js";

export interface GuardedPlannerSettings {
  base_url: string;
  api_key?: string;
  model: string;
  models?: string[];
  /** Sampling temperature for mapping calls; set 0 for local models so mappings are reproducible. */
  temperature?: number;
}

export const createConfiguredGuardedResearchWorkflow = async (input: {
  config: BackendRuntimeConfig;
  prompts: ProductPromptRegistry;
  analysisPlans: ResearchAnalysisPlanService;
  runs: GuardedRunEvidenceRepository;
  planner: GuardedPlannerSettings;
}): Promise<GuardedResearchWorkflowService> => {
  if (!input.config.generated_analysis.enabled) {
    throw new Error("Controlled generated analysis is disabled by runtime configuration.");
  }
  if (!input.planner.api_key) throw new Error("Controlled generated analysis requires a Router credential.");
  const prompt = await input.prompts.load({ id: "generated-analysis", version: "0.1.0" });
  const generatedAnalysis = new GuardedGeneratedAnalysisWorkflow({
    planner: new OpenAiCompatibleGeneratedAnalysisPlanner({
      ...input.planner,
      api_key: input.planner.api_key,
      system_prompt: prompt.body,
      timeout_ms: input.config.research_design.model.timeout_ms,
      max_output_tokens: input.config.research_design.model.max_output_tokens,
    }),
    executor: new GeneratedAnalysisService({
      ...input.config.generated_analysis,
      allowed_python_packages: [...input.config.generated_analysis.allowed_python_packages],
      allowed_r_packages: [...input.config.generated_analysis.allowed_r_packages],
    }),
  });
  return new GuardedResearchWorkflowService({
    analysisPlans: input.analysisPlans,
    generatedAnalysis,
    runs: input.runs,
  });
};
