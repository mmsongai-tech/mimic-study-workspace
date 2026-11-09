import { nodeHttp1Fetch } from "../runtime/node-http1-fetch.js";
import { VariableMappingError } from "./variable-mapping.js";
import type { TextEmbeddingClient } from "./dictionary-embedding-search.js";

/**
 * Embeddings from an OpenAI-compatible `/embeddings` endpoint (Ollama serves one at http://127.0.0.1:11434/v1). Texts are sent in
 * batches; every returned vector is scaled to unit length so a dot product is the cosine similarity. Only the texts are sent.
 */
export class OpenAiCompatibleTextEmbeddingClient implements TextEmbeddingClient {
  readonly model: string;
  constructor(private readonly options: { base_url: string; model: string; timeout_ms: number; api_key?: string; batch_size?: number; retries?: number; retry_delay_ms?: number; fetch?: typeof fetch }) {
    this.model = options.model;
  }

  private async request(texts: string[]): Promise<Float32Array[]> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.options.timeout_ms);
    let response: Response;
    try {
      response = await (this.options.fetch ?? nodeHttp1Fetch)(`${this.options.base_url.replace(/\/$/u, "")}/embeddings`, {
        method: "POST", signal: controller.signal,
        headers: { ...(this.options.api_key ? { authorization: `Bearer ${this.options.api_key}` } : {}), "content-type": "application/json" },
        body: JSON.stringify({ model: this.options.model, input: texts }),
      });
    } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The embedding request failed before a response was received."); }
    finally { clearTimeout(timer); }
    if (!response.ok) throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", `The embedding request was rejected with HTTP ${response.status}.`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The embedding service returned invalid JSON."); }
    const data = (payload as { data?: Array<{ index?: unknown; embedding?: unknown }> }).data;
    if (!Array.isArray(data) || data.length !== texts.length) throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The embedding service returned the wrong number of vectors.");
    const ordered = [...data].sort((a, b) => (typeof a.index === "number" ? a.index : 0) - (typeof b.index === "number" ? b.index : 0));
    return ordered.map(({ embedding }) => {
      if (!Array.isArray(embedding) || !embedding.length || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The embedding service returned an invalid vector.");
      }
      const vector = Float32Array.from(embedding as number[]);
      const norm = Math.hypot(...vector);
      if (!(norm > 0)) throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The embedding service returned a zero vector.");
      for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! / norm;
      return vector;
    });
  }

  /** A local server can drop a request under load (Ollama resets its tokenizer connection); a failed batch is tried again a few times. */
  private async requestWithRetry(texts: string[]): Promise<Float32Array[]> {
    const retries = Math.max(0, this.options.retries ?? 2);
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.request(texts); }
      catch (error) {
        if (attempt >= retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, (this.options.retry_delay_ms ?? 250) * (attempt + 1)));
      }
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const size = Math.max(1, this.options.batch_size ?? 64);
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += size) vectors.push(...await this.requestWithRetry(texts.slice(start, start + size)));
    return vectors;
  }
}
