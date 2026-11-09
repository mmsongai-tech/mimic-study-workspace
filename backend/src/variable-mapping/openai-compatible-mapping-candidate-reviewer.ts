import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { nodeHttp1Fetch } from "../runtime/node-http1-fetch.js";
import type { MappingCandidateEvidenceReview, MappingCandidateReviewResult } from "./variable-mapping.js";
import { VariableMappingError } from "./variable-mapping.js";
import { mappingCandidateEvidenceDigest, type MappingCandidateReviewer, type MappingCandidateReviewInput } from "./mapping-candidate-review.js";
import { parseModelJsonObject } from "../model-output/index.js";

const schema = JSON.parse(readFileSync(new URL("../../../contracts/variable-mapping/mapping-evidence-review.schema.json", import.meta.url), "utf8")) as object;
const reviewId = (value: unknown): string => `mapping-review:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
const normalizeReviewShape = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  const review = Object.keys(envelope).length === 1 && envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : envelope;
  // Small models repeat list items; duplicates carry no meaning, so they are removed instead of failing the review.
  const unique = (field: unknown): unknown => Array.isArray(field) ? [...new Set(field)] : field;
  const explanation = typeof review.explanation === "string" ? review.explanation.slice(0, 600) : review.explanation;
  return { ...review, ranked_candidate_ids: unique(review.ranked_candidate_ids), ...("reason_codes" in review ? { reason_codes: unique(review.reason_codes) } : {}), ...("selected_evidence_keys" in review ? { selected_evidence_keys: unique(review.selected_evidence_keys) } : {}), explanation };
};

/** Calls an OpenAI-compatible strict-schema endpoint and attaches non-model provenance. */
export class OpenAiCompatibleMappingCandidateReviewer implements MappingCandidateReviewer {
  private readonly validate: ValidateFunction<MappingCandidateReviewResult>;

  constructor(private readonly options: {
    base_url: string;
    api_key?: string;
    model: string;
    system_prompt: string;
    timeout_ms: number;
    max_output_tokens: number;
    fetch?: typeof fetch;
    now?: () => string;
    /** Sent only when set; local models need 0 for reproducible reviews. */
    temperature?: number;
  }) {
    this.validate = new Ajv2020({ strict: true, allErrors: true }).compile<MappingCandidateReviewResult>(schema);
  }

  async review(input: MappingCandidateReviewInput): Promise<MappingCandidateEvidenceReview> {
    if (!input.candidates.length) throw new VariableMappingError("MAPPING_INVALID", "No verified dictionary evidence is available for automated review.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeout_ms);
    let response: Response;
    try {
      const request = (responseFormat: { type: "json_object" } | { type: "json_schema"; json_schema: { name: string; strict: true; schema: object } }) =>
        (this.options.fetch ?? nodeHttp1Fetch)(`${this.options.base_url.replace(/\/$/u, "")}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: { ...(this.options.api_key ? { authorization: `Bearer ${this.options.api_key}` } : {}), "content-type": "application/json" },
          body: JSON.stringify({
          model: this.options.model,
          ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
          max_tokens: Math.min(this.options.max_output_tokens, 1_500),
          response_format: responseFormat,
          messages: [
            { role: "system", content: this.options.system_prompt },
            { role: "user", content: JSON.stringify({ ...input, output_schema: schema }) },
          ],
          }),
        });
      response = await request({ type: "json_schema", json_schema: { name: "mapping_evidence_review", strict: true, schema } });
      if ([400, 404, 422].includes(response.status)) response = await request({ type: "json_object" });
    } catch {
      throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "Automated mapping evidence review is unavailable.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "Automated mapping evidence review was rejected.");
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "Automated mapping evidence review returned invalid JSON."); }
    const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    const result = normalizeReviewShape(parseModelJsonObject(content));
    if (result === undefined) throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "Automated mapping evidence review returned malformed content.");
    if (!this.validate(result)) {
      const safeIssues = (this.validate.errors ?? []).slice(0, 8).map(({ instancePath, keyword }) => `${instancePath || "/"}:${keyword}`).join(", ");
      throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", `Automated mapping evidence review failed its output contract${safeIssues ? ` (${safeIssues})` : ""}.`);
    }
    const reviewedAt = this.options.now?.() ?? new Date().toISOString();
    const evidenceSha256 = mappingCandidateEvidenceDigest(input);
    const provenance = {
      reviewer_kind: "openai_compatible_model" as const,
      provider: "openai_compatible" as const,
      model: this.options.model,
      prompt: { id: "mapping-evidence-review" as const, version: "1.1.1" as const },
      reviewed_at: reviewedAt,
      authorization_basis: "runtime_configured_automated_review" as const,
      clinical_confirmation: false as const,
      evidence_sha256: evidenceSha256,
    };
    return { ...result, ...provenance, review_id: reviewId({ result, ...provenance }) };
  }
}
