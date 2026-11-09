import { ResearchDesignModelError, type ResearchDesignModel } from "../research-design/research-design-model.js";
import type { ResearchDesignModelSettings } from "./research-design-runtime.js";

export interface StructuredProviderAttempt {
  provider: string;
  model: string;
  order: number;
  latency_ms: number;
  outcome: "failed" | "succeeded";
  failure_class?: string;
}

export type StructuredProviderFailureCode =
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_REQUEST_REJECTED"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_RESPONSE_TRUNCATED"
  | "PROVIDER_FALLBACK_AUTHORIZATION_REQUIRED"
  | "PROVIDER_PREFLIGHT_FAILED"
  | "PROVIDER_UNAVAILABLE";

export interface StructuredResearchDesignProvider {
  generateProposal(input: {
    system_prompt: string;
    model_input: Parameters<ResearchDesignModel["propose"]>[0];
    profile: string;
    timeout_ms: number;
  }): Promise<unknown>;
  setAttemptHandler?(handler?: (attempt: StructuredProviderAttempt) => void): void;
}

export class StructuredProviderError extends Error {
  safeResponseDetail?: string;
  constructor(
    message: string,
    public readonly transient: boolean,
    public readonly code: StructuredProviderFailureCode = "PROVIDER_UNAVAILABLE",
    public readonly provider: string = "router",
    public readonly fallback_model?: string,
  ) {
    super(message);
    this.name = "StructuredProviderError";
  }
}

export const createRetryingResearchDesignModel = (
  provider: StructuredResearchDesignProvider,
  settings: ResearchDesignModelSettings,
  retry: {
    max_attempts: number;
    backoff_ms: number;
    sleep?: (milliseconds: number) => Promise<void>;
    onAttempt?: (attempt: StructuredProviderAttempt) => void;
  },
): ResearchDesignModel => {
  const sleep = retry.sleep ?? ((milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts: StructuredProviderAttempt[] = [];
  provider.setAttemptHandler?.((attempt) => { attempts.push(attempt); retry.onAttempt?.(attempt); });

  return {
    async propose(input) {
      attempts.length = 0;
      let lastError: unknown;
      for (let attempt = 1; attempt <= retry.max_attempts; attempt += 1) {
        try {
          return await provider.generateProposal({
            system_prompt: settings.prompt.body,
            model_input: input,
            profile: settings.profile,
            timeout_ms: settings.timeout_ms,
          });
        } catch (error) {
          lastError = error;
          if (!(error instanceof StructuredProviderError)) throw new ResearchDesignModelError("MODEL_UNAVAILABLE");
          if (error.code === "PROVIDER_AUTHENTICATION_FAILED" && error.provider === "openai") {
            throw new ResearchDesignModelError("MODEL_OPENAI_AUTHENTICATION_FAILED", error.fallback_model, [...attempts]);
          }
          if (!error.transient) throw new ResearchDesignModelError(error.code === "PROVIDER_AUTHENTICATION_FAILED" ? "MODEL_AUTHENTICATION_FAILED" : error.code === "PROVIDER_RESPONSE_INVALID" || error.code === "PROVIDER_RESPONSE_TRUNCATED" ? "MODEL_RESPONSE_INVALID" : error.code === "PROVIDER_RATE_LIMITED" ? "MODEL_RATE_LIMITED" : error.code === "PROVIDER_TIMEOUT" ? "MODEL_TIMEOUT" : error.code === "PROVIDER_FALLBACK_AUTHORIZATION_REQUIRED" ? "MODEL_FALLBACK_AUTHORIZATION_REQUIRED" : "MODEL_UNAVAILABLE", error.fallback_model, [...attempts]);
          if (attempt < retry.max_attempts) await sleep(retry.backoff_ms * attempt);
        }
      }
      if (lastError instanceof StructuredProviderError) {
        if (lastError.code === "PROVIDER_AUTHENTICATION_FAILED" && lastError.provider === "openai") {
          throw new ResearchDesignModelError("MODEL_OPENAI_AUTHENTICATION_FAILED");
        }
          throw new ResearchDesignModelError(lastError.code === "PROVIDER_TIMEOUT" ? "MODEL_TIMEOUT" : lastError.code === "PROVIDER_RATE_LIMITED" ? "MODEL_RATE_LIMITED" : lastError.code === "PROVIDER_RESPONSE_INVALID" || lastError.code === "PROVIDER_RESPONSE_TRUNCATED" ? "MODEL_RESPONSE_INVALID" : lastError.code === "PROVIDER_AUTHENTICATION_FAILED" ? "MODEL_AUTHENTICATION_FAILED" : "MODEL_UNAVAILABLE", lastError.fallback_model, [...attempts]);
      }
      throw new ResearchDesignModelError("MODEL_UNAVAILABLE");
    },
  };
};

export const createRetryingResearchDesignModelFactory = (
  provider: StructuredResearchDesignProvider,
  sleep?: (milliseconds: number) => Promise<void>,
) => (settings: ResearchDesignModelSettings): ResearchDesignModel =>
  createRetryingResearchDesignModel(provider, settings, {
    max_attempts: settings.retry_max_attempts,
    backoff_ms: settings.retry_backoff_ms,
    ...(settings.onAttempt ? { onAttempt: settings.onAttempt } : {}),
    ...(sleep ? { sleep } : {}),
  });
