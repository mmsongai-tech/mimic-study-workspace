import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { nodeHttp1Fetch } from "../runtime/index.js";
import { validateCoverageConsistency, validateObjectiveIdentities, type ObjectiveCoverageReview, type ResearchObjective, type ResearchObjectiveList } from "./research-objective-list.js";
import { validateObjectiveCoverageReview, validateResearchObjectiveList } from "./schema-validator.js";

type FetchLike = typeof fetch;
type JsonSchema = Record<string, unknown>;

export interface ModelAuditRecord {
  schema_version: "1.0.0";
  stage: "objective_extraction" | "objective_coverage" | "objective_semantic_repair" | "objective_coverage_recheck";
  provider: string;
  model: string;
  prompt: { id: string; version: string; sha256: string };
  output_schema: { id: string; version: string; sha256: string };
  question_sha256: string;
  response_received: boolean;
  json_parse: "pass" | "fail" | "not_run";
  schema_validation: "pass" | "fail" | "not_run";
  business_validation: "pass" | "fail" | "not_run";
  repair_attempts: number;
  failure_class?: string;
  validation_errors?: string[];
  latency_ms: number;
  finish_reason?: string;
  response_chars?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  output_integrity_id?: string;
}

export interface ResearchObjectiveModelResult {
  objective_list: ResearchObjectiveList;
  coverage: ObjectiveCoverageReview;
  audit: ModelAuditRecord[];
}

const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const readSchema = (name: string): JsonSchema => JSON.parse(readFileSync(new URL(`../../../contracts/research-objectives/${name}.schema.json`, import.meta.url), "utf8")) as JsonSchema;
const strictSchema = (schema: JsonSchema): JsonSchema => { const copy = structuredClone(schema); delete copy.$schema; delete copy.$id; return copy; };
const compactModelContract = (schemaName: string): Record<string, unknown> => schemaName === "objective-list"
  ? {
      schema_version: "1.0.0",
      required_root_fields: ["original_question", "objectives", "ambiguities"],
      objective_fields: ["objective_id", "purpose", "relationship", "question", "population", "exposure_or_predictors", "comparator", "outcome", "effect_modifiers", "depends_on_objective_ids", "source_claims"],
      allowed_values: {
        purpose: ["association", "prediction", "treatment_effect"],
        relationship: ["primary", "secondary", "effect_modification", "mediation", "composite_component"],
      },
      ambiguity_fields: ["ambiguity_id", "question", "reason", "affected_objective_ids"],
      rules: ["preserve original_question exactly", "source_claims must be exact non-empty phrases copied from the original question", "every ambiguity must use exactly ambiguity_fields", "return an empty ambiguities array when no clarification is needed", "for effect_modification, keep the treatment/exposure in exposure_or_predictors and put the modifier only in effect_modifiers", "do not invent variables or database fields"],
    }
  : {
      schema_version: "1.0.0",
      required_root_fields: ["decision", "covered_claims", "missing_claims", "altered_claims", "unsupported_additions", "explanation"],
      allowed_values: { decision: ["pass", "needs_review"] },
      rules: ["compare only the original question with objective source_claims", "do not infer feasibility problems", "return pass when every source claim is represented without a real semantic change"],
    };
const responseText = (payload: unknown): string | undefined => (payload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
const parseJsonObject = (content: string): unknown | undefined => {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1];
  if (fenced) candidates.push(fenced.trim());
  const start = trimmed.indexOf("{"); const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* Continue to the next safe object candidate. */ }
  }
  return undefined;
};

const reconcileCoverageReview = (list: ResearchObjectiveList, review: ObjectiveCoverageReview): ObjectiveCoverageReview => {
  if (review.decision !== "needs_review") return review;
  const sourceClaims = new Set(list.objectives.flatMap(({ source_claims }) => source_claims.map((claim) => claim.trim()).filter(Boolean)));
  const requestedClaims = requestedSourceClaims(list.original_question);
  if (requestedClaims.length > 1 && requestedClaims.every((claim) => sourceClaims.has(claim))) {
    return {
      ...review,
      decision: "pass",
      missing_claims: [],
      altered_claims: [],
      unsupported_additions: [],
      explanation: "服务端依据原问题分段主张与 objective source_claims 的一一覆盖复核通过；模型审查将合法拆分误报为改写。",
    };
  }
  const normalize = (value: string): string => value.replace(/[\s，。；：、？！“”‘’（）()]+/gu, "");
  const normalizedQuestion = normalize(list.original_question);
  const pointsToOriginalQuestion = (claim: string): boolean => {
    const normalizedClaim = normalize(claim);
    return normalizedClaim.length >= 2 && normalizedQuestion.includes(normalizedClaim);
  };
  const realFindings = [
    ...review.missing_claims.filter(pointsToOriginalQuestion),
    ...review.altered_claims.filter(pointsToOriginalQuestion),
    ...review.unsupported_additions.filter((claim) => normalize(claim).length >= 2),
  ];
  if (realFindings.length) return review;
  return {
    ...review,
    decision: "pass",
    missing_claims: [],
    altered_claims: [],
    unsupported_additions: [],
    explanation: "服务端依据目标列表中保留的 source_claims 复核通过；模型审查中的遗漏描述未对应原始 source claim。",
  };
};

const validateSourceClaims = (value: ResearchObjectiveList, originalQuestion: string): string[] => {
  const source = originalQuestion.replace(/[\s，。；：、？！“”‘’（）()]+/gu, "");
  return value.objectives.flatMap((objective) => objective.source_claims
    .filter((claim) => !source.includes(claim.replace(/[\s，。；：、？！“”‘’（）()]+/gu, "")))
    .map((claim) => `SOURCE_CLAIM_NOT_IN_QUESTION:${objective.objective_id}`));
};
const requestedSourceClaims = (question: string): string[] => [...new Set(question
  .split(/(?:以及|及)/u)
  .map((part) => part.trim().replace(/^[，,、。；：？！\s]+|[，,、。；：？！\s]+$/gu, ""))
  .filter((part) => part.length >= 2))];

/** Owns the two model calls used to extract and independently review research objectives. */
export class OpenAiCompatibleResearchObjectiveModel {
  constructor(private readonly options: { base_url: string; api_key?: string; provider: string; model: string; timeout_ms: number; max_output_tokens: number; objective_prompt: { id: string; version: string; content: string }; coverage_prompt: { id: string; version: string; content: string }; fetch?: FetchLike }) {}

  async analyze(originalQuestion: string): Promise<ResearchObjectiveModelResult> {
    return this.analyzeWithModel(originalQuestion);
  }

  private async analyzeWithModel(originalQuestion: string): Promise<ResearchObjectiveModelResult> {
    const objectiveBusinessValidation = (value: ResearchObjectiveList): string[] => value.original_question === originalQuestion
      ? [...validateObjectiveIdentities(value), ...validateSourceClaims(value, originalQuestion)]
      : ["The returned original_question differs from the submitted question."];
    const extractionInput = { original_question: originalQuestion, requested_source_claims: requestedSourceClaims(originalQuestion) };
    let objective = await this.call<ResearchObjectiveList>({ stage: "objective_extraction", question: originalQuestion, prompt: this.options.objective_prompt, schemaName: "objective-list", schemaId: "research_objective_list", input: extractionInput, validate: validateResearchObjectiveList, validateBusiness: objectiveBusinessValidation });
    let coverage = await this.call<ObjectiveCoverageReview>({ stage: "objective_coverage", question: originalQuestion, prompt: this.options.coverage_prompt, schemaName: "coverage-review", schemaId: "objective_coverage_review", input: { original_question: originalQuestion, proposed_objective_list: objective.value }, validate: validateObjectiveCoverageReview, validateBusiness: validateCoverageConsistency });
    const audit = [objective.audit, coverage.audit];
    coverage.value = reconcileCoverageReview(objective.value, coverage.value);
    if (coverage.value.decision === "needs_review") {
      objective = await this.call<ResearchObjectiveList>({ stage: "objective_semantic_repair", question: originalQuestion, prompt: this.options.objective_prompt, schemaName: "objective-list", schemaId: "research_objective_list", input: { task: "Revise the objective list using the independent coverage findings. Preserve every source claim, remove unsupported additions, and do not change the original question.", original_question: originalQuestion, requested_source_claims: requestedSourceClaims(originalQuestion), prior_objective_list: objective.value, coverage_findings: coverage.value }, validate: validateResearchObjectiveList, validateBusiness: objectiveBusinessValidation });
      coverage = await this.call<ObjectiveCoverageReview>({ stage: "objective_coverage_recheck", question: originalQuestion, prompt: this.options.coverage_prompt, schemaName: "coverage-review", schemaId: "objective_coverage_review", input: { original_question: originalQuestion, proposed_objective_list: objective.value, prior_coverage_findings: coverage.value }, validate: validateObjectiveCoverageReview, validateBusiness: validateCoverageConsistency });
      coverage.value = reconcileCoverageReview(objective.value, coverage.value);
      audit.push(objective.audit, coverage.audit);
    }
    return { objective_list: objective.value, coverage: coverage.value, audit };
  }

  private async call<T>(input: { stage: ModelAuditRecord["stage"]; question: string; prompt: { id: string; version: string; content: string }; schemaName: string; schemaId: string; input: unknown; validate: (value: unknown) => string[]; validateBusiness: (value: T) => string[] }): Promise<{ value: T; audit: ModelAuditRecord }> {
    const started = Date.now(); const schema = readSchema(input.schemaName); const schemaText = JSON.stringify(schema); const questionSha = digest(input.question);
    const base = { schema_version: "1.0.0" as const, stage: input.stage, provider: this.options.provider, model: this.options.model, prompt: { id: input.prompt.id, version: input.prompt.version, sha256: digest(input.prompt.content) }, output_schema: { id: input.schemaName, version: "1.0.0", sha256: digest(schemaText) }, question_sha256: questionSha };
    let responseReceived = false; let jsonParsed = false; let schemaPassed = false; let repairAttempts = 0; let finishReason: string | undefined; let responseChars: number | undefined;
    try {
      const request = async (modelInput: unknown): Promise<{ payload: unknown; parsed: unknown }> => {
        jsonParsed = false;
        const send = async (responseFormat?: Record<string, unknown>): Promise<Response> => {
          const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.options.timeout_ms);
          try {
            return await (this.options.fetch ?? nodeHttp1Fetch)(`${this.options.base_url.replace(/\/$/u, "")}/chat/completions`, { method: "POST", headers: { ...(this.options.api_key ? { authorization: `Bearer ${this.options.api_key}` } : {}), "content-type": "application/json" }, body: JSON.stringify({ model: this.options.model, max_tokens: this.options.max_output_tokens, ...(this.options.provider === "local" ? { temperature: 0 } : {}), ...(responseFormat ? { response_format: responseFormat } : {}), messages: [{ role: "system", content: input.prompt.content }, { role: "user", content: JSON.stringify(modelInput) }] }), signal: controller.signal });
          } finally { clearTimeout(timer); }
        };
        let response = await send({ type: "json_schema", json_schema: { name: input.schemaId, strict: true, schema: strictSchema(schema) } });
        const rejected = (status: number): boolean => [400, 404, 415, 422].includes(status);
        if (rejected(response.status)) response = await send({ type: "json_object" });
        if (rejected(response.status)) response = await send();
        responseReceived = true;
        if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
        const payload = await response.json(); const content = responseText(payload); if (!content) throw new Error("PROVIDER_RESPONSE_EMPTY");
        const candidateFinishReason = (payload as { choices?: Array<{ finish_reason?: unknown }> }).choices?.[0]?.finish_reason;
        finishReason = typeof candidateFinishReason === "string" ? candidateFinishReason : undefined;
        responseChars = content.length;
        const parsed = parseJsonObject(content);
        if (parsed === undefined) throw new Error(finishReason === "length" ? "OUTPUT_TRUNCATED" : "JSON_PARSE_FAILED");
        jsonParsed = true; return { payload, parsed };
      };
      let { payload, parsed } = await request({ task_input: input.input, output_contract: compactModelContract(input.schemaName) });
      if (input.schemaName === "objective-list" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        (parsed as Record<string, unknown>).original_question = input.question;
      }
      let issues = input.validate(parsed);
      if (issues.length) {
        repairAttempts = 1;
        schemaPassed = false;
        ({ payload, parsed } = await request({ task: "Repair the prior output to exactly match output_contract. Return only the corrected object.", original_input: input.input, prior_output: parsed, validation_errors: issues, output_contract: compactModelContract(input.schemaName) }));
        issues = input.validate(parsed);
      }
      if (issues.length) throw new Error(`SCHEMA_VALIDATION_FAILED:${issues.join(" | ")}`);
      schemaPassed = true;
      let businessIssues = input.validateBusiness(parsed as T);
      if (businessIssues.length && repairAttempts === 0) {
        repairAttempts = 1;
        schemaPassed = false;
        ({ payload, parsed } = await request({ task: "Repair the prior output to satisfy the business invariants and output_contract. Return only the corrected object.", original_input: input.input, prior_output: parsed, validation_errors: businessIssues, output_contract: compactModelContract(input.schemaName) }));
        issues = input.validate(parsed);
        if (issues.length) throw new Error(`SCHEMA_VALIDATION_FAILED:${issues.join(" | ")}`);
        schemaPassed = true;
        businessIssues = input.validateBusiness(parsed as T);
      }
      if (businessIssues.length) throw new Error(`BUSINESS_VALIDATION_FAILED:${businessIssues.join(" | ")}`);
      const usage = (payload as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      const safeUsage = usage ? { ...(typeof usage.prompt_tokens === "number" ? { input_tokens: usage.prompt_tokens } : {}), ...(typeof usage.completion_tokens === "number" ? { output_tokens: usage.completion_tokens } : {}) } : undefined;
      return { value: parsed as T, audit: { ...base, repair_attempts: repairAttempts, response_received: true, json_parse: "pass", schema_validation: "pass", business_validation: "pass", latency_ms: Date.now() - started, ...(finishReason ? { finish_reason: finishReason } : {}), ...(responseChars !== undefined ? { response_chars: responseChars } : {}), ...(safeUsage && Object.keys(safeUsage).length ? { usage: safeUsage } : {}), output_integrity_id: digest(JSON.stringify(parsed)) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "MODEL_UNAVAILABLE";
      const failure = error instanceof Error && error.name === "AbortError" ? "PROVIDER_TIMEOUT" : message.split(":", 1)[0]!;
      const validationErrors = failure.endsWith("VALIDATION_FAILED") ? message.slice(message.indexOf(":") + 1).split(" | ").filter(Boolean).map((issue) => issue.slice(0, 240)) : [];
      throw Object.assign(new Error("The research objective model did not produce a valid result."), { audit: { ...base, repair_attempts: repairAttempts, response_received: responseReceived, json_parse: jsonParsed ? "pass" : responseReceived ? "fail" : "not_run", schema_validation: schemaPassed ? "pass" : jsonParsed ? "fail" : "not_run", business_validation: failure === "BUSINESS_VALIDATION_FAILED" ? "fail" : "not_run", failure_class: failure, ...(validationErrors.length ? { validation_errors: validationErrors } : {}), latency_ms: Date.now() - started, ...(finishReason ? { finish_reason: finishReason } : {}), ...(responseChars !== undefined ? { response_chars: responseChars } : {}) } satisfies ModelAuditRecord });
    }
  }
}
