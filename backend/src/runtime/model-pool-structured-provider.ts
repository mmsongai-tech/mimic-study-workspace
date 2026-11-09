import type { StructuredProviderAttempt, StructuredResearchDesignProvider } from "./retrying-research-design-model.js";
import { StructuredProviderError } from "./retrying-research-design-model.js";

export interface ModelPoolAttempt extends StructuredProviderAttempt {
  failure_code?: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_AUTHENTICATION_FAILED" | "PROVIDER_RATE_LIMITED" | "PROVIDER_TIMEOUT" | "PROVIDER_REQUEST_REJECTED" | "PROVIDER_RESPONSE_INVALID" | "PROVIDER_RESPONSE_TRUNCATED" | "PROVIDER_FALLBACK_AUTHORIZATION_REQUIRED" | "PROVIDER_PREFLIGHT_FAILED" | "PROVIDER_UNAVAILABLE";
}

export interface ModelAvailabilityProbe {
  check(model: string, timeout_ms?: number): Promise<void>;
}

/** Tries an ordered, deduplicated model pool without escalating outside the configured list. */
export class ModelPoolStructuredProvider implements StructuredResearchDesignProvider {
  private attemptHandler: ((attempt: ModelPoolAttempt) => void) | undefined;
  private preferredModel: string | undefined;

  constructor(
    private readonly provider: StructuredResearchDesignProvider,
    private readonly models: string[],
    private readonly onAttempts?: (attempts: ModelPoolAttempt[]) => void,
    onAttempt?: (attempt: ModelPoolAttempt) => void,
    private readonly providerName: StructuredProviderAttempt["provider"] = "router",
    private readonly modelProbe?: ModelAvailabilityProbe,
  ) {
    this.attemptHandler = onAttempt;
    if (!this.orderedModels().length) throw new Error("At least one Router model is required.");
  }

  setAttemptHandler(handler: ((attempt: StructuredProviderAttempt) => void) | undefined): void {
    this.attemptHandler = handler ? (attempt) => handler(attempt) : undefined;
  }

  async generateProposal(input: Parameters<StructuredResearchDesignProvider["generateProposal"]>[0]): Promise<unknown> {
    const attempts: ModelPoolAttempt[] = [];
    const failures: StructuredProviderError[] = [];
    const ordered = this.orderedModels();
    const deadline = Date.now() + input.timeout_ms;
    const probeResults: Array<{ model: string; order: number; latency_ms: number; error?: StructuredProviderError }> = this.modelProbe
      ? await Promise.all(ordered.map(async (model, index) => {
          const started = Date.now();
          try {
            await this.modelProbe?.check(model, input.timeout_ms);
            return { model, order: index + 1, latency_ms: Date.now() - started };
          } catch (error) {
            if (!(error instanceof StructuredProviderError)) throw error;
            return { model, order: index + 1, latency_ms: Date.now() - started, error };
          }
        }))
      : ordered.map((model, index) => ({ model, order: index + 1, latency_ms: 0 }));
    const hardProbeFailures = new Set([
      "PROVIDER_AUTHENTICATION_FAILED",
      "PROVIDER_RATE_LIMITED",
      "PROVIDER_REQUEST_REJECTED",
    ]);
    const available = [
      ...probeResults.filter((result) => !result.error),
      ...probeResults.filter((result) => result.error && !hardProbeFailures.has(result.error.code)),
    ];
    for (const result of probeResults) {
      if (!result.error || !hardProbeFailures.has(result.error.code)) continue;
      failures.push(result.error);
      attempts.push({
        provider: this.providerName,
        model: result.model,
        order: result.order,
        latency_ms: result.latency_ms,
        outcome: "failed",
        failure_code: result.error.code,
        failure_class: result.error.code,
      });
    }
    const emitAttempts = (): void => {
      attempts.sort((left, right) => left.order - right.order);
      for (const attempt of attempts) this.attemptHandler?.(attempt);
      this.onAttempts?.(attempts);
    };
    for (let index = 0; index < available.length; index += 1) {
      const candidate = available[index];
      const model = candidate?.model ?? "";
      const started = Date.now();
      try {
        const modelsRemaining = available.length - index;
        const remainingBudget = deadline - Date.now();
        const remainingCandidates = available.slice(index);
        const passedProbeCount = remainingCandidates.filter((result) => !result.error).length;
        const inconclusiveProbeCount = remainingCandidates.length - passedProbeCount;
        const rescueBudgetPerModel = inconclusiveProbeCount > 0
          ? Math.min(5_000, Math.floor(remainingBudget / (inconclusiveProbeCount + passedProbeCount * 2)))
          : 0;
        const formalBudget = !candidate?.error && passedProbeCount > 0
          ? Math.floor((remainingBudget - rescueBudgetPerModel * inconclusiveProbeCount) / passedProbeCount)
          : Math.floor(remainingBudget / modelsRemaining);
        if (formalBudget < 250) {
          throw new StructuredProviderError("The Router model pool exhausted its request budget.", true, "PROVIDER_TIMEOUT", this.providerName);
        }
        const proposal = await this.provider.generateProposal({ ...input, profile: model, timeout_ms: formalBudget });
        // Prefer a model that completed the formal provider contract, not just a probe.
        this.preferredModel = model;
        const attempt: ModelPoolAttempt = {
          provider: this.providerName,
          model,
          order: candidate?.order ?? index + 1,
          latency_ms: (candidate?.latency_ms ?? 0) + Date.now() - started,
          outcome: "succeeded",
        };
        attempts.push(attempt);
        emitAttempts();
        return proposal;
      } catch (error) {
        if (!(error instanceof StructuredProviderError)) throw error;
        if (this.preferredModel === model) this.preferredModel = undefined;
        failures.push(error);
        const attempt: ModelPoolAttempt = {
          provider: this.providerName,
          model,
          order: candidate?.order ?? index + 1,
          latency_ms: (candidate?.latency_ms ?? 0) + Date.now() - started,
          outcome: "failed",
          failure_code: error.code,
          failure_class: error.safeResponseDetail ? `${error.code}:${error.safeResponseDetail}` : error.code,
        };
        attempts.push(attempt);
      }
    }
    emitAttempts();
    const aggregateCode = failures.some(({ code }) => code === "PROVIDER_RESPONSE_TRUNCATED")
      ? "PROVIDER_RESPONSE_TRUNCATED"
      : failures.some(({ code }) => code === "PROVIDER_RESPONSE_INVALID")
        ? "PROVIDER_RESPONSE_INVALID"
        : failures.every(({ code }) => code === "PROVIDER_AUTHENTICATION_FAILED")
          ? "PROVIDER_AUTHENTICATION_FAILED"
          : failures.at(-1)?.code ?? "PROVIDER_UNAVAILABLE";
    throw new StructuredProviderError(
      "The configured Router model pool did not produce a usable response.",
      failures.length > 0 && failures.every(({ transient }) => transient),
      aggregateCode,
      this.providerName,
    );
  }

  private orderedModels(): string[] {
    const models = [...new Set(this.models.map((model) => model.trim()).filter(Boolean))];
    return this.preferredModel && models.includes(this.preferredModel)
      ? [this.preferredModel, ...models.filter((model) => model !== this.preferredModel)]
      : models;
  }
}
