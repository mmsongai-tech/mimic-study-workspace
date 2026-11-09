import type { StructuredProviderAttempt, StructuredResearchDesignProvider } from "./retrying-research-design-model.js";
import { StructuredProviderError } from "./retrying-research-design-model.js";

const retryKey = (input: Parameters<StructuredResearchDesignProvider["generateProposal"]>[0]): string => {
  const copy = structuredClone(input.model_input) as { request?: { allow_openai_fallback?: boolean; client_request_id?: string } };
  if (copy.request) {
    delete copy.request.allow_openai_fallback;
    delete copy.request.client_request_id;
  }
  return JSON.stringify(copy);
};

const isAuthorized = (input: Parameters<StructuredResearchDesignProvider["generateProposal"]>[0]): boolean =>
  (input.model_input as { request?: { allow_openai_fallback?: boolean } }).request?.allow_openai_fallback === true;

/** Requires a fresh primary failure before accepting one request-scoped paid fallback authorization. */
export class FallbackStructuredProvider implements StructuredResearchDesignProvider {
  private readonly pending = new Map<string, number>();
  constructor(
    private readonly primary: StructuredResearchDesignProvider,
    private readonly fallback: { provider: StructuredResearchDesignProvider; model: string },
    private readonly onFallback?: (model: string) => void,
    private onAttempt?: (attempt: StructuredProviderAttempt) => void,
    private readonly now: () => number = Date.now,
  ) {}
  async generateProposal(input: Parameters<StructuredResearchDesignProvider["generateProposal"]>[0]): Promise<unknown> {
    const key = retryKey(input);
    const pendingUntil = this.pending.get(key) ?? 0;
    if (isAuthorized(input) && pendingUntil > this.now()) {
      this.pending.delete(key);
      this.onFallback?.(this.fallback.model);
      const started = Date.now();
      try {
        const proposal = await this.fallback.provider.generateProposal({ ...input, profile: this.fallback.model });
        this.onAttempt?.({ provider: "openai", model: this.fallback.model, order: 1, latency_ms: Date.now() - started, outcome: "succeeded" });
        return proposal;
      } catch (error) {
        if (error instanceof StructuredProviderError) {
          this.onAttempt?.({ provider: "openai", model: this.fallback.model, order: 1, latency_ms: Date.now() - started, outcome: "failed", failure_class: error.code });
        }
        throw error;
      }
    }
    try {
      return await this.primary.generateProposal(input);
    } catch (error) {
      if (error instanceof StructuredProviderError && error.code === "PROVIDER_AUTHENTICATION_FAILED") throw error;
      this.pending.set(key, this.now() + 5 * 60_000);
      throw new StructuredProviderError("OpenAI fallback requires request-scoped authorization.", false, "PROVIDER_FALLBACK_AUTHORIZATION_REQUIRED", "router", this.fallback.model);
    }
  }

  setAttemptHandler(handler?: (attempt: StructuredProviderAttempt) => void): void {
    this.onAttempt = handler;
    this.primary.setAttemptHandler?.(handler);
    this.fallback.provider.setAttemptHandler?.(handler);
  }
}
