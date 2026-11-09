import { RESEARCH_DESIGN_COMPACT_OUTPUT_CONTRACT, RESEARCH_DESIGN_OUTPUT_CONTRACT } from "./research-design-output-contract.js";
import { normalizeResearchDesignProposal, validateResearchDesignProposal } from "../research-design/index.js";
import type { StructuredResearchDesignProvider } from "./retrying-research-design-model.js";
import { StructuredProviderError } from "./retrying-research-design-model.js";
import { nodeHttp1Fetch } from "./node-http1-fetch.js";

type FetchLike = typeof fetch;
type OutputLanguage = "en" | "zh-CN";


const inferOutputLanguage = (modelInput: unknown): OutputLanguage =>
  /\p{Script=Han}/u.test(JSON.stringify(modelInput)) ? "zh-CN" : "en";

const withoutRuntimeControls = (modelInput: unknown): unknown => {
  const copy = structuredClone(modelInput) as { request?: Record<string, unknown>; clarification_history?: Array<Record<string, unknown>> };
  if (copy.request) {
    for (const field of ["allow_openai_fallback", "client_request_id", "session_id", "base_revision"]) delete copy.request[field];
  }
  // Preserve all turns and free text. Only remove answers that are represented
  // exactly by their question/value/label context in the same turn.
  for (const turn of copy.clarification_history ?? []) {
    if (!isRecord(turn.answers) || !Array.isArray(turn.answer_context)) continue;
    const answers = Object.entries(turn.answers);
    if (answers.length && answers.every(([id, value]) => (turn.answer_context as unknown[]).some((context) =>
      isRecord(context) && context.question_id === id && typeof context.question === "string" &&
      typeof context.selected_label === "string" && JSON.stringify(context.selected_value) === JSON.stringify(value)))) {
      delete turn.answers;
    }
  }
  return copy;
};


const modelVisibleInput = (modelInput: unknown, outputLanguage: OutputLanguage, includeFullContract = false) => ({
  // Stable contract bytes precede all question-specific content for prefix caching.
  output_contract: includeFullContract ? RESEARCH_DESIGN_OUTPUT_CONTRACT : RESEARCH_DESIGN_COMPACT_OUTPUT_CONTRACT,
  output_language: outputLanguage,
  language_requirement: outputLanguage === "zh-CN"
    ? "所有面向用户的自然语言文本必须使用中文；只有临床缩写、专有名词、结构字段、标识符、枚举和代码可以保留英文。"
    : "Write every user-visible natural-language field in English, except source phrases that must be preserved exactly.",
  model_input: withoutRuntimeControls(modelInput),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

const validateChineseText = (value: unknown, path: string, issues: string[]): void => {
  if (typeof value === "string" && value.trim() && !/\p{Script=Han}/u.test(value)) {
    issues.push(`${path} must use Chinese for user-visible text`);
  }
};

const validateChineseTextArray = (value: unknown, path: string, issues: string[]): void => {
  if (!Array.isArray(value)) return;
  value.forEach((item, index) => validateChineseText(item, `${path}/${index}`, issues));
};

const validateChineseCandidateSpec = (value: unknown, path: string, issues: string[]): void => {
  if (!isRecord(value)) return;
  validateChineseText(value.title, `${path}/title`, issues);
  validateChineseText(value.research_question, `${path}/research_question`, issues);
  validateChineseTextArray(value.assumptions, `${path}/assumptions`, issues);
  const population = isRecord(value.population) ? value.population : undefined;
  if (population) {
    validateChineseText(population.description, `${path}/population/description`, issues);
    validateChineseTextArray(population.inclusion_criteria, `${path}/population/inclusion_criteria`, issues);
    validateChineseTextArray(population.exclusion_criteria, `${path}/population/exclusion_criteria`, issues);
  }
  const indexTime = isRecord(value.index_time) ? value.index_time : undefined;
  if (indexTime) {
    validateChineseText(indexTime.event, `${path}/index_time/event`, issues);
    validateChineseText(indexTime.selection_rule, `${path}/index_time/selection_rule`, issues);
  }
  const variables = [
    ...(Array.isArray(value.exposure_or_predictors) ? value.exposure_or_predictors : []),
    ...(Array.isArray(value.covariates) ? value.covariates : []),
    ...(value.outcome ? [value.outcome] : []),
  ];
  variables.forEach((variable, index) => {
    if (!isRecord(variable)) return;
    validateChineseText(variable.operational_definition, `${path}/variables/${index}/operational_definition`, issues);
  });
  const estimand = isRecord(value.estimand) ? value.estimand : undefined;
  if (estimand) {
    for (const key of ["target_population", "exposure_contrast", "outcome_measure", "summary_measure"] as const) {
      validateChineseText(estimand[key], `${path}/estimand/${key}`, issues);
    }
  }
};

const validateOutputLanguage = (proposal: unknown, outputLanguage: OutputLanguage): string[] => {
  if (outputLanguage !== "zh-CN" || !isRecord(proposal)) return [];
  const issues: string[] = [];
  validateChineseText(proposal.assistant_message, "/assistant_message", issues);
  validateChineseTextArray(proposal.assumptions, "/assumptions", issues);
  const intent = isRecord(proposal.intent_assessment) ? proposal.intent_assessment : undefined;
  if (intent) {
    validateChineseText(intent.reason, "/intent_assessment/reason", issues);
    validateChineseText(intent.clarifying_question, "/intent_assessment/clarifying_question", issues);
  }
  if (Array.isArray(proposal.clarifying_questions)) {
    proposal.clarifying_questions.forEach((question, questionIndex) => {
      if (!isRecord(question)) return;
      validateChineseText(question.prompt, `/clarifying_questions/${questionIndex}/prompt`, issues);
      validateChineseText(question.reason, `/clarifying_questions/${questionIndex}/reason`, issues);
      if (!Array.isArray(question.options)) return;
      question.options.forEach((option, optionIndex) => {
        if (!isRecord(option)) return;
        validateChineseText(option.label, `/clarifying_questions/${questionIndex}/options/${optionIndex}/label`, issues);
        validateChineseText(option.explanation, `/clarifying_questions/${questionIndex}/options/${optionIndex}/explanation`, issues);
      });
    });
  }
  if (Array.isArray(proposal.suggestions)) {
    proposal.suggestions.forEach((suggestion, index) => {
      if (!isRecord(suggestion)) return;
      validateChineseText(suggestion.label, `/suggestions/${index}/label`, issues);
      validateChineseText(suggestion.explanation, `/suggestions/${index}/explanation`, issues);
      validateChineseCandidateSpec(suggestion.candidate_spec, `/suggestions/${index}/candidate_spec`, issues);
    });
  }
  if (Array.isArray(proposal.warnings)) {
    proposal.warnings.forEach((warning, index) => {
      if (isRecord(warning)) validateChineseText(warning.message, `/warnings/${index}/message`, issues);
    });
  }
  validateChineseCandidateSpec(proposal.candidate_spec, "/candidate_spec", issues);
  return issues;
};

const responseText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.filter((item): item is { type: "text"; text: string } =>
    Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string")).map((item) => item.text).join("");
};

const proposalJsonText = (content: string): string => {
  const exact = content.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu)?.[1];
  const blocks = [...content.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/giu)];
  const sole = blocks.length === 1 && !content.replace(blocks[0]![0], "").includes("```") ? blocks[0]?.[1] : undefined;
  return exact ?? sole ?? content;
};

// Only allowlisted categories and numeric offsets survive; engine error text may contain output values.
const safeSyntaxDetail = (content: string): string => {
  try { JSON.parse(proposalJsonText(content)); return "valid_json"; } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const category = /Unterminated string/u.test(message) ? "unterminated_string"
      : /Bad control character/u.test(message) ? "control_character"
      : /Unexpected end/u.test(message) ? "incomplete_json"
      : /Expected property name|Expected double-quoted property name/u.test(message) ? "property_name"
      : message.includes("Expected ',' or '}'") || message.includes("Expected ',' or ']'") ? "separator"
      : /Unexpected non-whitespace character/u.test(message) ? "trailing_content"
      : /Unexpected token/u.test(message) ? "unexpected_token" : "syntax";
    return `${category}:offset=${message.match(/position (\d+)/u)?.[1] ?? "unknown"}`;
  }
};

const safeSchemaDetail = (errors: string[]): string => {
  const fields = ["intent_assessment", "candidate_spec", "spec_patch", "clarifying_questions", "readiness", "time_windows", "population", "index_time", "exposure_or_predictors", "outcome", "outcome_structure", "covariates", "estimand", "analysis_family", "effect_modifiers", "analysis_objectives", "derivation"];
  return fields.filter((field) => errors.some((issue) => issue.includes(`/${field}`))).join(",") || "root";
};

export class OpenAiCompatibleStructuredProvider implements StructuredResearchDesignProvider {
  constructor(private readonly options: {
    base_url: string;
    api_key?: string;
    max_output_tokens: number;
    provider?: string;
    reasoning_effort?: "low" | "medium" | "high" | "xhigh";
    fetch?: FetchLike;
  }) {}

  async generateProposal(input: Parameters<StructuredResearchDesignProvider["generateProposal"]>[0]): Promise<unknown> {
    const outputLanguage = inferOutputLanguage(input.model_input);
    const deadline = Date.now() + input.timeout_ms;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeout_ms);
    let response: Response;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.api_key) headers.authorization = `Bearer ${this.options.api_key}`;
    const request = (responseFormat?: Record<string, unknown>, includeFullContract = false) => (this.options.fetch ?? nodeHttp1Fetch)(`${this.options.base_url.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: input.profile, max_tokens: this.options.max_output_tokens, ...(this.options.reasoning_effort ? { reasoning_effort: this.options.reasoning_effort } : {}), ...(responseFormat ? { response_format: responseFormat } : {}), messages: [{ role: "system", content: input.system_prompt }, { role: "user", content: JSON.stringify(modelVisibleInput(input.model_input, outputLanguage, includeFullContract)) }] }),
      signal: controller.signal,
    });
    try {
      response = await request({ type: "json_object" });
      // The initial contract factors repeated schemas without weakening them.
      // Repair uses the original representation; both use backend validation.
      const formatRejected = (status: number): boolean => [400, 404, 415, 422].includes(status);
      if (formatRejected(response.status)) response = await request();
    } catch (error) {
      throw new StructuredProviderError(
        isAbortError(error)
          ? "The research-design provider timed out."
          : "The research-design provider is unavailable.",
        true,
        isAbortError(error) ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        this.options.provider ?? "router",
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? "PROVIDER_AUTHENTICATION_FAILED" : response.status === 429 ? "PROVIDER_RATE_LIMITED" : "PROVIDER_REQUEST_REJECTED";
      throw new StructuredProviderError(
        "The research-design provider rejected the request.",
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status === 408 ? "PROVIDER_TIMEOUT" : response.status >= 500 ? "PROVIDER_UNAVAILABLE" : code,
        this.options.provider ?? "router",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const invalidEnvelope = new StructuredProviderError(
        "The research-design provider returned invalid JSON.",
        false,
        "PROVIDER_RESPONSE_INVALID",
        this.options.provider ?? "router",
      );
      invalidEnvelope.safeResponseDetail = "response_envelope_json";
      throw invalidEnvelope;
    }
    const choice = (payload as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> } | null)?.choices?.[0];
    const content = responseText(choice?.message?.content);
    if (!content) {
      const missingContent = new StructuredProviderError(
        "The research-design provider returned no structured proposal.",
        false,
        "PROVIDER_RESPONSE_INVALID",
        this.options.provider ?? "router",
      );
      missingContent.safeResponseDetail = "missing_text_content";
      throw missingContent;
    }
    const parsed = this.safeParse(content);
    if (parsed === undefined) {
      const repairDiagnostic: { value?: string } = {};
      // Syntax errors need the same bounded repair opportunity as schema errors.
      // Never repair a known truncated response by inventing its missing tail.
      if (choice?.finish_reason !== "length") {
        const repaired = await this.repairProposal(input, content, null,
          ["Response text must contain one complete, syntactically valid JSON proposal."], outputLanguage, deadline, repairDiagnostic);
        if (repaired !== undefined) return repaired;
      }
      const malformedContent = new StructuredProviderError(
        choice?.finish_reason === "length"
          ? "The research-design provider response exceeded the configured output limit."
          : "The research-design provider returned malformed structured content.",
        false,
        choice?.finish_reason === "length" ? "PROVIDER_RESPONSE_TRUNCATED" : "PROVIDER_RESPONSE_INVALID",
        this.options.provider ?? "router",
      );
      const finish = ["stop", "length", "content_filter", "tool_calls"].includes(String(choice?.finish_reason))
        ? String(choice?.finish_reason) : "unknown";
      const shape = content.trimStart().startsWith("{") ? "object" : content.trimStart().startsWith("```") ? "fenced" : "text";
      malformedContent.safeResponseDetail = `malformed_json:finish=${finish}:chars=${content.length}:shape=${shape}:syntax=${safeSyntaxDetail(content)}:repair=${repairDiagnostic.value ?? "not_attempted"}`;
      throw malformedContent;
    }
    const normalized = normalizeResearchDesignProposal(parsed);
    const schemaErrors = validateResearchDesignProposal(normalized);
    const languageErrors = schemaErrors.length === 0 ? validateOutputLanguage(normalized, outputLanguage) : [];
    const validationErrors = [...schemaErrors, ...languageErrors];
    if (validationErrors.length === 0) return normalized;
    const repairDiagnostic: { value?: string } = {};
    const repaired = await this.repairProposal(input, content, parsed, validationErrors, outputLanguage, deadline, repairDiagnostic);
    if (repaired !== undefined) return repaired;
    if (schemaErrors.length === 0 && languageErrors.length > 0) {
      throw new StructuredProviderError(
        "The research-design provider returned content in the wrong output language.",
        false,
        "PROVIDER_RESPONSE_INVALID",
        this.options.provider ?? "router",
      );
    }
    const invalidProposalError = new StructuredProviderError(
      "The research-design provider returned a schema-invalid proposal after one bounded repair.",
      false,
      "PROVIDER_RESPONSE_INVALID",
      this.options.provider ?? "router",
    );
    // Only contract-owned field names and the failure category enter the audit.
    // Do not retain the response, validation values, prompt, or arbitrary error text.
    invalidProposalError.safeResponseDetail = `schema_validation:${safeSchemaDetail(schemaErrors)}:repair=${repairDiagnostic.value ?? "unknown"}`;
    throw invalidProposalError;
  }

  private async repairProposal(
    input: Parameters<StructuredResearchDesignProvider["generateProposal"]>[0],
    content: string,
    parsed: unknown,
    validationErrors: string[],
    outputLanguage: OutputLanguage,
    deadline: number,
    diagnostic: { value?: string } = {},
  ): Promise<unknown | undefined> {
    const controller = new AbortController();
    const remaining = deadline - Date.now();
    if (remaining <= 0) { diagnostic.value = "budget_exhausted"; return undefined; }
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const messages = (includeFullContract: boolean) => [
        { role: "system", content: input.system_prompt },
        { role: "user", content: JSON.stringify(modelVisibleInput(input.model_input, outputLanguage, includeFullContract)) },
        { role: "assistant", content },
        { role: "user", content: JSON.stringify({
          repair_request: true,
          validation_errors: validationErrors,
          output_language: outputLanguage,
          instruction: outputLanguage === "zh-CN"
            ? "严格按 response_format 修正 JSON；若网关未提供 response_format，则按校验错误和前述合同摘要修正。所有面向用户的自然语言文本必须使用中文。只返回 JSON。"
            : "Correct the JSON against response_format. If the gateway omits response_format, use the validation errors and prior contract summary. Return JSON only.",
        }) },
      ];
      const request = (responseFormat?: Record<string, unknown>, includeFullContract = false) => (this.options.fetch ?? nodeHttp1Fetch)(`${this.options.base_url.replace(/\/$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          ...(this.options.api_key ? { authorization: `Bearer ${this.options.api_key}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: input.profile, max_tokens: this.options.max_output_tokens, ...(this.options.reasoning_effort ? { reasoning_effort: this.options.reasoning_effort } : {}), ...(responseFormat ? { response_format: responseFormat } : {}), messages: messages(includeFullContract) }),
        signal: controller.signal,
      });
      let response = await request({ type: "json_object" }, true);
      const formatRejected = (status: number): boolean => [400, 404, 415, 422].includes(status);
      if (formatRejected(response.status)) response = await request(undefined, true);
      if (!response.ok) { diagnostic.value = `http_${response.status}`; return undefined; }
      const payload = await response.json().catch(() => undefined);
      const repairedContent = responseText((payload as { choices?: Array<{ message?: { content?: unknown } }> } | undefined)?.choices?.[0]?.message?.content);
      if (!repairedContent) { diagnostic.value = "missing_text"; return undefined; }
      const repaired = this.safeParse(repairedContent);
      if (repaired === undefined) { diagnostic.value = `malformed_${safeSyntaxDetail(repairedContent)}`; return undefined; }
      const normalized = normalizeResearchDesignProposal(repaired);
      const schemaErrors = validateResearchDesignProposal(normalized);
      if (schemaErrors.length) { diagnostic.value = `schema_${safeSchemaDetail(schemaErrors)}`; return undefined; }
      if (validateOutputLanguage(normalized, outputLanguage).length) { diagnostic.value = "language"; return undefined; }
      diagnostic.value = "accepted";
      return normalized;
    } catch (error) {
      diagnostic.value = isAbortError(error) ? "timeout" : "transport";
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private safeParse(content: string): unknown | undefined {
    try {
      return JSON.parse(proposalJsonText(content));
    } catch {
      return undefined;
    }
  }
}
