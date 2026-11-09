import { createHash } from "node:crypto";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parseModelJsonObject } from "./model-json-content.js";

type FetchLike = typeof fetch;

export interface StructuredChatPrompt { id: string; version: string; body: string }
export interface StructuredChatSchema { id: string; version: string; json: object }

export interface StructuredChatRequest<T> {
  stage: string;
  prompt: StructuredChatPrompt;
  schema: StructuredChatSchema;
  input: unknown;
  max_output_tokens: number;
  /** Repairs optional fields before validation; must never invent required meaning. */
  sanitize?: (value: unknown) => unknown;
  /** Returns human-readable rule violations the schema cannot express. */
  validate_business?: (value: T) => string[];
}

export interface StructuredChatAudit {
  stage: string;
  provider: string;
  model: string;
  prompt: { id: string; version: string; integrity_id: string };
  schema: { id: string; version: string; integrity_id: string };
  json_parse: "pass" | "fail" | "not_run";
  schema_validation: "pass" | "fail" | "not_run";
  business_validation: "pass" | "fail" | "not_run";
  repair_attempts: number;
  latency_ms: number;
  structured_output_mode: "json_schema" | "json_object";
  failure_class?: string;
  output_integrity_id?: string;
}

export class StructuredChatError extends Error {
  constructor(readonly code: "MODEL_UNAVAILABLE" | "MODEL_RESPONSE_INVALID", message: string, readonly audit: StructuredChatAudit) { super(message); }
}

/**
 * True when the model endpoint never gave a usable answer: unreachable, timed out, or an HTTP error status (for example a
 * model that is not installed). False for a reply that arrived but failed validation, and for an unknown class.
 */
export const modelNotResponding = (failureClass: string | undefined): boolean =>
  failureClass === "MODEL_UNREACHABLE" || failureClass === "MODEL_TIMEOUT" || (failureClass?.startsWith("PROVIDER_HTTP_") ?? false);

const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const describeErrors = (errors: ErrorObject[] | null | undefined): string[] =>
  (errors ?? []).slice(0, 8).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);

/**
 * One structured call to an OpenAI-compatible chat endpoint (local Ollama or a hosted provider):
 * grammar-constrained JSON schema output, tolerant parsing, optional sanitation, strict validation,
 * and at most one repair turn that shows the model its own rule violations. Prompts and outputs are
 * never placed in the audit record; only hashes and check states are.
 */
export class OpenAiCompatibleStructuredChatClient {
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly options: { provider: string; base_url: string; api_key?: string; model: string; timeout_ms: number; max_repairs?: number; fetch?: FetchLike }) {}

  get model(): string { return this.options.model; }

  async call<T>(request: StructuredChatRequest<T>): Promise<{ value: T; audit: StructuredChatAudit }> {
    const started = Date.now();
    const validate = this.validator(request.schema);
    const audit: StructuredChatAudit = {
      stage: request.stage, provider: this.options.provider, model: this.options.model,
      prompt: { id: request.prompt.id, version: request.prompt.version, integrity_id: sha256(request.prompt.body) },
      schema: { id: request.schema.id, version: request.schema.version, integrity_id: sha256(JSON.stringify(request.schema.json)) },
      json_parse: "not_run", schema_validation: "not_run", business_validation: "not_run", repair_attempts: 0, latency_ms: 0,
      structured_output_mode: "json_schema",
    };
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: request.prompt.body },
      { role: "user", content: JSON.stringify(request.input) },
    ];
    const maxRepairs = this.options.max_repairs ?? 1;
    for (let attempt = 0; ; attempt += 1) {
      const content = await this.complete(messages, request, audit);
      const parsed = parseModelJsonObject(content);
      audit.json_parse = parsed === undefined ? "fail" : "pass";
      let problems: string[];
      let value: unknown;
      if (parsed === undefined) problems = ["The reply was not one JSON object."];
      else {
        value = request.sanitize ? request.sanitize(parsed) : parsed;
        audit.schema_validation = validate(value) ? "pass" : "fail";
        problems = audit.schema_validation === "fail" ? describeErrors(validate.errors) : [];
        if (!problems.length && request.validate_business) {
          problems = request.validate_business(value as T);
          audit.business_validation = problems.length ? "fail" : "pass";
        }
      }
      if (!problems.length) {
        audit.latency_ms = Date.now() - started;
        audit.output_integrity_id = sha256(JSON.stringify(value));
        return { value: value as T, audit };
      }
      if (attempt >= maxRepairs) {
        audit.latency_ms = Date.now() - started;
        audit.failure_class = audit.json_parse === "fail" ? "JSON_PARSE_FAILED" : audit.schema_validation === "fail" ? "SCHEMA_VALIDATION_FAILED" : "BUSINESS_VALIDATION_FAILED";
        throw new StructuredChatError("MODEL_RESPONSE_INVALID", `The ${request.stage} model reply failed validation.`, audit);
      }
      audit.repair_attempts += 1;
      messages.push({ role: "assistant", content }, { role: "user", content: `Your JSON broke these rules:\n- ${problems.join("\n- ")}\nReturn the corrected JSON object only.` });
    }
  }

  private validator(schema: StructuredChatSchema): ValidateFunction {
    const key = `${schema.id}@${schema.version}`;
    let validate = this.validators.get(key);
    if (!validate) {
      validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema.json);
      this.validators.set(key, validate);
    }
    return validate;
  }

  private async complete(messages: Array<{ role: string; content: string }>, request: Pick<StructuredChatRequest<unknown>, "stage" | "schema" | "max_output_tokens">, audit: StructuredChatAudit): Promise<string> {
    const send = async (responseFormat: Record<string, unknown>): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeout_ms);
      try {
        return await (this.options.fetch ?? fetch)(`${this.options.base_url.replace(/\/$/u, "")}/chat/completions`, {
          method: "POST", signal: controller.signal,
          headers: { ...(this.options.api_key ? { authorization: `Bearer ${this.options.api_key}` } : {}), "content-type": "application/json" },
          body: JSON.stringify({ model: this.options.model, temperature: 0, max_tokens: request.max_output_tokens, response_format: responseFormat, messages }),
        });
      } catch (error) {
        audit.failure_class = error instanceof Error && error.name === "AbortError" ? "MODEL_TIMEOUT" : "MODEL_UNREACHABLE";
        audit.latency_ms = 0;
        throw new StructuredChatError("MODEL_UNAVAILABLE", `The ${request.stage} model could not be reached.`, audit);
      } finally { clearTimeout(timer); }
    };
    let response = await send({ type: "json_schema", json_schema: { name: request.schema.id.replaceAll(/[^a-zA-Z0-9_-]/gu, "_"), strict: true, schema: request.schema.json } });
    if ([400, 404, 415, 422].includes(response.status)) {
      audit.structured_output_mode = "json_object";
      response = await send({ type: "json_object" });
    }
    if (!response.ok) {
      audit.failure_class = `PROVIDER_HTTP_${response.status}`;
      throw new StructuredChatError("MODEL_UNAVAILABLE", `The ${request.stage} model returned HTTP ${response.status}.`, audit);
    }
    const payload = await response.json().catch(() => undefined) as { choices?: Array<{ message?: { content?: unknown } }> } | undefined;
    const content = payload?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }
}
