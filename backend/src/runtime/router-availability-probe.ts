import type { StructuredResearchDesignProvider } from "./retrying-research-design-model.js";
import { StructuredProviderError } from "./retrying-research-design-model.js";
import { nodeHttp1Fetch } from "./node-http1-fetch.js";

type FetchLike = typeof fetch;

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

const responseText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  return content.find((item): item is { type: "text"; text: string } =>
    Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string" && (item as { text: string }).text.trim()))?.text;
};

/** Performs a fast, payload-free Router check immediately before a model request. */
export class RouterAvailabilityProbe {
  constructor(private readonly options: {
    base_url: string;
    api_key: string;
    timeout_ms?: number;
    fetch?: FetchLike;
  }) {}

  async check(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(250, this.options.timeout_ms ?? 1500));
    try {
      const response = await (this.options.fetch ?? nodeHttp1Fetch)(`${this.options.base_url.replace(/\/$/u, "")}/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.options.api_key}` },
        signal: controller.signal,
      });
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new StructuredProviderError("The Router availability check rejected the credential.", false, "PROVIDER_AUTHENTICATION_FAILED", "router");
      }
      if (!response.ok) {
        throw new StructuredProviderError("The Router availability check did not pass.", response.status === 408 || response.status === 429 || response.status >= 500, response.status === 408 ? "PROVIDER_TIMEOUT" : "PROVIDER_PREFLIGHT_FAILED", "router");
      }
    } catch (error) {
      if (error instanceof StructuredProviderError) throw error;
      throw new StructuredProviderError(
        error instanceof Error && error.name === "AbortError" ? "The Router availability check timed out." : "The Router availability check is unavailable.",
        true,
        error instanceof Error && error.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_PREFLIGHT_FAILED",
        "router",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Verifies one Router model with a tiny, content-free completion before sending research context. */
export class RouterModelAvailabilityProbe {
  constructor(private readonly options: {
    base_url: string;
    api_key: string;
    timeout_ms?: number;
    fetch?: FetchLike;
  }) {}

  async check(model: string, timeout_ms?: number): Promise<void> {
    const controller = new AbortController();
    const configuredTimeout = Math.max(250, this.options.timeout_ms ?? 5_000);
    const timer = setTimeout(() => controller.abort(), Math.max(250, Math.min(configuredTimeout, timeout_ms ?? configuredTimeout)));
    try {
      const response = await (this.options.fetch ?? nodeHttp1Fetch)(`${this.options.base_url.replace(/\/$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.api_key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with OK." }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403
          ? "PROVIDER_AUTHENTICATION_FAILED"
          : response.status === 408
            ? "PROVIDER_TIMEOUT"
            : response.status === 429
              ? "PROVIDER_RATE_LIMITED"
              : response.status >= 500
                ? "PROVIDER_UNAVAILABLE"
                : "PROVIDER_REQUEST_REJECTED";
        throw new StructuredProviderError(
          "The Router model availability check did not pass.",
          response.status === 408 || response.status === 429 || response.status >= 500,
          code,
          "router",
        );
      }
      const payload = await response.json().catch(() => undefined) as { choices?: Array<{ message?: { content?: unknown } }> } | undefined;
      if (!responseText(payload?.choices?.[0]?.message?.content)) {
        throw new StructuredProviderError(
          "The Router model availability check returned no usable completion.",
          false,
          "PROVIDER_RESPONSE_INVALID",
          "router",
        );
      }
    } catch (error) {
      if (error instanceof StructuredProviderError) throw error;
      throw new StructuredProviderError(
        isAbortError(error)
          ? "The Router model availability check timed out."
          : "The Router model availability check is unavailable.",
        true,
        isAbortError(error) ? "PROVIDER_TIMEOUT" : "PROVIDER_PREFLIGHT_FAILED",
        "router",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class PreflightStructuredProvider implements StructuredResearchDesignProvider {
  constructor(
    private readonly provider: StructuredResearchDesignProvider,
    private readonly probe: RouterAvailabilityProbe,
  ) {}

  setAttemptHandler(handler?: Parameters<NonNullable<StructuredResearchDesignProvider["setAttemptHandler"]>>[0]): void {
    this.provider.setAttemptHandler?.(handler);
  }

  async generateProposal(input: Parameters<StructuredResearchDesignProvider["generateProposal"]>[0]): Promise<unknown> {
    await this.probe.check();
    return this.provider.generateProposal(input);
  }
}
