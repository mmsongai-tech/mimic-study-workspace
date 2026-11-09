import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ResearchDesignModel } from "../research-design/research-design-model.js";
import { createResearchDesignService } from "../research-design/index.js";
import type { DesignSessionRepository } from "../research-design/design-session-repository.js";
import type { ResearchDesignService } from "../research-design/research-design-service.js";
import type { ProductPromptAsset, ProductPromptRegistry } from "./product-prompt-registry.js";
import type { BackendRuntimeConfig } from "./runtime-config.js";
import type { StructuredProviderAttempt } from "./retrying-research-design-model.js";

export interface ResearchDesignModelSettings {
  profile: string;
  timeout_ms: number;
  prompt: ProductPromptAsset;
  retry_max_attempts: number;
  retry_backoff_ms: number;
  onAttempt?: (attempt: StructuredProviderAttempt) => void;
}

export type ResearchDesignModelFactory = (
  settings: ResearchDesignModelSettings,
) => ResearchDesignModel;

export const createConfiguredResearchDesignService = async (dependencies: {
  config: BackendRuntimeConfig;
  prompts: ProductPromptRegistry;
  modelFactory: ResearchDesignModelFactory;
  sessions: DesignSessionRepository;
  modelAudit?: {
    append(record: unknown[]): void;
  };
  now?: () => Date;
}): Promise<ResearchDesignService> => {
  const settings = dependencies.config.research_design;
  const prompt = await dependencies.prompts.load(settings.prompt);
  const schemaText = readFileSync(new URL("../../../contracts/research-design/proposal.schema.json", import.meta.url), "utf8");
  const promptDigest = `sha256:${createHash("sha256").update(prompt.body).digest("hex")}`;
  const schemaDigest = `sha256:${createHash("sha256").update(schemaText).digest("hex")}`;
  let latestAttempts: StructuredProviderAttempt[] = [];

  const model = dependencies.modelFactory({
    profile: settings.model.profile,
    timeout_ms: settings.model.timeout_ms,
    retry_max_attempts: settings.model.retry_max_attempts,
    retry_backoff_ms: settings.model.retry_backoff_ms,
    prompt,
    onAttempt: (attempt) => {
      if (!dependencies.modelAudit) return;
      latestAttempts = [...latestAttempts, attempt];
    },
  });

  const appendAuditRecord = (validation: {
    json_parse: "pass" | "fail" | "not_run";
    schema_validation: "pass" | "fail" | "not_run";
    business_validation: "pass" | "fail" | "not_run";
    failure_class?: string;
  }) => {
    if (!dependencies.modelAudit) return;
    const attempts = [...latestAttempts];
    latestAttempts = [];
    const totalLatencyMs = attempts.reduce((sum, current) => sum + current.latency_ms, 0);
    const representativeAttempt = attempts.find(({ outcome }) => outcome === "succeeded") ?? attempts.at(-1);
    if (!representativeAttempt) return;
    const failureClass = validation.failure_class ?? (representativeAttempt.outcome === "failed" ? representativeAttempt.failure_class : undefined);
    try {
      dependencies.modelAudit.append([{
        stage: "design_proposal",
        provider: representativeAttempt.provider,
        model: representativeAttempt.model,
        prompt: { id: prompt.id, version: prompt.version, integrity_id: promptDigest },
        schema: { id: "research-design-proposal", version: "1.0.0", integrity_id: schemaDigest },
        json_parse: validation.json_parse,
        schema_validation: validation.schema_validation,
        business_validation: validation.business_validation,
        repair_attempts: Math.max(0, attempts.length - 1),
        latency_ms: totalLatencyMs,
        failure_class: failureClass,
        attempts: attempts.map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          order: entry.order,
          latency_ms: entry.latency_ms,
          outcome: entry.outcome,
          failure_class: entry.failure_class,
        })),
      }]);
    } catch {
      // best effort to keep audit best-effort and avoid impacting research requests.
    }
  };

  return createResearchDesignService(
    model,
    dependencies.sessions,
    {
      ...(dependencies.now ? { now: dependencies.now } : {}),
      onProposalValidation: appendAuditRecord,
      requestClaimTtlMs: settings.idempotency.request_claim_ttl_ms,
      policy: {
        maxRequestChars: settings.limits.max_request_chars,
        maxAnswers: settings.limits.max_answers,
        maxPatchOperations: settings.limits.max_patch_operations,
        maxRevisions: settings.retention.max_revisions,
        supportedStudySpecVersions: settings.supported_study_spec_versions,
      },
    },
  );
};
