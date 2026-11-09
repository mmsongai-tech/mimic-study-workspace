import { createResearchDesignTemplateRegistry, normalizeResearchDesignProposal, validateResearchDesignProposal } from "../research-design/index.js";
import type { ResearchDesignProposal } from "../research-design/model-proposal.js";
import type { StructuredResearchDesignProvider } from "./retrying-research-design-model.js";

export interface RouterSmokeResult {
  status: "passed";
  model: string;
  recommended_intent: string;
  readiness: string;
}

export const runRouterSyntheticSmoke = async (input: {
  provider: StructuredResearchDesignProvider;
  systemPrompt: string;
  model: string;
  timeoutMs: number;
}): Promise<RouterSmokeResult> => {
  const templates = createResearchDesignTemplateRegistry();
  const proposal = normalizeResearchDesignProposal(await input.provider.generateProposal({
    system_prompt: input.systemPrompt,
    profile: input.model,
    timeout_ms: input.timeoutMs,
    model_input: {
      request: {
        client_request_id: "router-synthetic-smoke-1",
        message: "Study the association between early ICU lactate and in-hospital mortality using synthetic data.",
      },
      current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
      template_context: { templates: templates.list() },
    },
  }));
  const errors = validateResearchDesignProposal(proposal);
  if (errors.length > 0) {
    throw new Error(`Router synthetic smoke returned an invalid research-design proposal: ${errors.join("; ")}`);
  }
  const typed = proposal as ResearchDesignProposal;
  return {
    status: "passed",
    model: input.model,
    recommended_intent: typed.intent_assessment.recommended_intent,
    readiness: typed.readiness,
  };
};
