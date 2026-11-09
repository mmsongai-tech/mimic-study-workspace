import { createHash } from "node:crypto";

export interface ModelRequestMetric {
  started_at: string;
  provider: string;
  model: string | null;
  request_sha256: string;
  request_bytes: number;
  message_count: number;
  phase: "proposal" | "repair";
  latency_ms: number;
  http_status: number | null;
  failure: "timeout" | "transport" | "http" | "invalid_envelope" | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  finish_reason: string | null;
  cost: null;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Records allowlisted transport measurements only; never records messages, headers or responses. */
export const createMeteredModelFetch = (options: {
  fetch: typeof fetch;
  provider: string;
  record: (metric: ModelRequestMetric) => void;
}): typeof fetch => async (input, init) => {
  const started = Date.now();
  const body = typeof init?.body === "string" ? init.body : "";
  let request: { model?: unknown; messages?: unknown[] } = {};
  try { request = JSON.parse(body); } catch { /* A malformed request is still measured. */ }
  const metric: ModelRequestMetric = {
    started_at: new Date(started).toISOString(), provider: options.provider,
    model: typeof request?.model === "string" && /^[\w./:-]{1,160}$/u.test(request.model) ? request.model : null,
    request_sha256: createHash("sha256").update(body).digest("hex"),
    request_bytes: Buffer.byteLength(body),
    message_count: Array.isArray(request?.messages) ? request.messages.length : 0,
    phase: Array.isArray(request?.messages) && request.messages.length > 2 ? "repair" : "proposal",
    latency_ms: 0, http_status: null, failure: null,
    input_tokens: null, output_tokens: null, cached_input_tokens: null, reasoning_tokens: null,
    finish_reason: null, cost: null,
  };
  try {
    const response = await options.fetch(input, init);
    metric.http_status = response.status;
    if (!response.ok) metric.failure = "http";
    try {
      const payload = await response.clone().json() as {
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown;
          prompt_tokens_details?: { cached_tokens?: unknown };
          completion_tokens_details?: { reasoning_tokens?: unknown } };
        choices?: Array<{ finish_reason?: unknown }>;
      } | null;
      metric.input_tokens = count(payload?.usage?.prompt_tokens);
      metric.output_tokens = count(payload?.usage?.completion_tokens);
      metric.cached_input_tokens = count(payload?.usage?.prompt_tokens_details?.cached_tokens);
      metric.reasoning_tokens = count(payload?.usage?.completion_tokens_details?.reasoning_tokens);
      const finish = payload?.choices?.[0]?.finish_reason;
      if (typeof finish === "string" && ["stop", "length", "content_filter", "tool_calls"].includes(finish)) metric.finish_reason = finish;
    } catch { if (response.ok) metric.failure = "invalid_envelope"; }
    return response;
  } catch (error) {
    metric.failure = error instanceof Error && error.name === "AbortError" ? "timeout" : "transport";
    throw error;
  } finally {
    metric.latency_ms = Date.now() - started;
    options.record(metric);
  }
};
