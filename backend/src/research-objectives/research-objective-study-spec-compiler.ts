import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assessResearchProtocol, JsonSchemaResearchDesignValidator, listStudyConditions, type StudySpec } from "../research-design/index.js";
import { nodeHttp1Fetch } from "../runtime/index.js";
import type { ResearchObjective } from "./research-objective-list.js";

type FetchLike = typeof fetch;
type JsonSchema = Record<string, unknown>;
type ValidationState = "pass" | "fail" | "not_run";

export interface ObjectiveStudySpecAuditRecord {
  schema_version: "1.0.0";
  stage: "objective_study_spec_compile";
  provider: string;
  model: string;
  prompt: { id: string; version: string; sha256: string };
  output_schema: { id: string; version: string; sha256: string };
  objective_sha256: string;
  response_received: boolean;
  json_parse: ValidationState;
  schema_validation: ValidationState;
  business_validation: ValidationState;
  repair_attempts: 0 | 1;
  failure_class?: string;
  validation_errors?: string[];
  latency_ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  output_integrity_id?: string;
  structured_output_mode?: "json_schema" | "json_object" | "prompt_contract";
}

export interface ObjectiveStudySpecCompilation {
  objective_id: string;
  study_spec: StudySpec;
  audit: ObjectiveStudySpecAuditRecord[];
}

export interface ObjectiveStudySpecCompilerInput {
  objective: ResearchObjective;
  shared_context?: Record<string, unknown>;
}

const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const studySpecSchema = JSON.parse(readFileSync(new URL("../../../contracts/research-design/study-spec.schema.json", import.meta.url), "utf8")) as JsonSchema;
const schemaText = JSON.stringify(studySpecSchema);
const strictSchema = (): JsonSchema => { const copy = structuredClone(studySpecSchema); delete copy.$schema; delete copy.$id; return copy; };
const compactStudySpecContract = (): Record<string, unknown> => ({
  schema_version: "1.0.0",
  required_root_fields: ["schema_version", "intent_family", "research_question", "population", "index_time", "exposure_or_predictors", "outcome", "outcome_structure", "time_windows", "estimand", "analysis_family", "assumptions"],
  rules: ["preserve the objective question, population, inputs, outcome and effect modifiers exactly", "do not invent database fields or results", "use an encounter-bounded outcome window", "return one complete JSON StudySpec only"],
});
const responseText = (payload: unknown): string | undefined => {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.find((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"))?.text;
};
const parseJsonObject = (content: string): unknown | undefined => {
  const candidates = [content, content.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu)?.[1]].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) try { return JSON.parse(candidate); } catch { /* try embedded objects */ }
  const starts = [...content.matchAll(/\{/gu)].map(({ index }) => index!);
  const ends = [...content.matchAll(/\}/gu)].map(({ index }) => index!);
  for (const start of starts) for (const end of [...ends].reverse()) {
    if (end <= start) continue;
    try { return JSON.parse(content.slice(start, end + 1)); } catch { /* continue */ }
  }
  return undefined;
};

const normalizePurposeRoles = (value: unknown, objective: ResearchObjective): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const spec = value as Record<string, unknown>;
  const expected = spec.intent_family === "prediction" ? "predictor" : "exposure";
  const inputs = Array.isArray(spec.exposure_or_predictors)
    ? spec.exposure_or_predictors.map((item) => item && typeof item === "object" && !Array.isArray(item) ? { ...(item as Record<string, unknown>), role: expected } : item)
    : spec.exposure_or_predictors;
  let covariates: unknown[] | undefined = Array.isArray(spec.covariates) ? [...spec.covariates] : undefined;
  let modifiers: unknown[] | undefined = Array.isArray(spec.effect_modifiers) ? [...spec.effect_modifiers] : undefined;
  if (objective.effect_modifiers.length === 1 && Array.isArray(modifiers) && modifiers.length === 1) {
    const generatedName = modifiers[0] && typeof modifiers[0] === "object" ? (modifiers[0] as Record<string, unknown>).variable_name : undefined;
    modifiers = [{ ...(modifiers[0] as Record<string, unknown>), variable_name: objective.effect_modifiers[0] }];
    if (Array.isArray(covariates)) {
      const singleCovariate = covariates.length === 1;
      covariates = covariates.map((item) => item && typeof item === "object" && ((item as Record<string, unknown>).name === generatedName || singleCovariate) ? { ...(item as Record<string, unknown>), name: objective.effect_modifiers[0] } : item);
    }
  }
  if (objective.effect_modifiers.length) {
    if (!Array.isArray(covariates)) covariates = [];
    if (!Array.isArray(modifiers)) modifiers = [];
    for (const name of objective.effect_modifiers) {
      if (!covariates.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).name === name)) {
        covariates.push({ name, role: "covariate", operational_definition: "由后续本地 MIMIC 变量映射确定" });
      }
      if (!modifiers.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).variable_name === name)) {
        modifiers.push({ variable_name: name, analysis: "interaction_and_stratified" });
      }
    }
  }
  return { ...spec, ...(inputs ? { exposure_or_predictors: inputs } : {}), ...(covariates ? { covariates } : {}), ...(modifiers ? { effect_modifiers: modifiers } : {}) };
};

const hasConditionContract = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const condition = value as Record<string, unknown>;
  if (typeof condition.condition_id !== "string" || typeof condition.source_text !== "string") return false;
  if (condition.kind === "all" || condition.kind === "any") return Array.isArray(condition.operands);
  if (condition.kind === "not") return Boolean(condition.operand);
  if (condition.kind === "concept") return typeof condition.concept === "string" && ["present", "absent"].includes(String(condition.assertion));
  if (condition.kind === "numeric_comparison") return typeof condition.concept === "string" && typeof condition.value === "number";
  if (condition.kind === "category_comparison") return typeof condition.concept === "string" && Array.isArray(condition.values);
  if (condition.kind === "event_exists") return typeof condition.concept === "string" && ["present", "absent"].includes(String(condition.occurrence));
  return false;
};

const analysisFamilyFor = (purpose: ResearchObjective["purpose"], outcomeStructure: unknown): StudySpec["analysis_family"] | undefined => {
  if (typeof outcomeStructure !== "string") return undefined;
  const survival = outcomeStructure === "time_to_event" || outcomeStructure === "competing_risk";
  if (purpose === "treatment_effect") return survival ? "time_to_event_treatment_effect" : "propensity_weighted_treatment_effect";
  if (purpose === "prediction") return survival ? "time_to_event_prediction" : outcomeStructure === "binary" ? "binary_prediction" : undefined;
  return survival ? "time_to_event_association" : "association";
};

const completeExecutableDefaults = (value: unknown, objective: ResearchObjective): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const spec = structuredClone(value) as Record<string, unknown>;
  delete spec.comparator;
  const outcomeStructure = spec.outcome_structure;
  const population: Record<string, unknown> = spec.population && typeof spec.population === "object" && !Array.isArray(spec.population)
    ? { ...(spec.population as Record<string, unknown>) }
    : { description: objective.population };
  population.description = objective.population;
  if (!hasConditionContract(population.criteria)) {
    population.criteria = { condition_id: "population.target", source_text: objective.population, kind: "concept", concept: objective.population, assertion: "present" };
  }
  const indexTime: Record<string, unknown> = spec.index_time && typeof spec.index_time === "object" && !Array.isArray(spec.index_time)
    ? { ...(spec.index_time as Record<string, unknown>) }
    : { event: "本次符合条件的住院或 ICU 入院" };
  if (typeof indexTime.selection_rule !== "string") indexTime.selection_rule = "按每次符合条件的 encounter 计入";
  const expectedRole = objective.purpose === "prediction" ? "predictor" : "exposure";
  const exposureOrPredictors = Array.isArray(spec.exposure_or_predictors)
    ? spec.exposure_or_predictors.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const variable: Record<string, unknown> = { ...(item as Record<string, unknown>), role: expectedRole };
        if (variable.contrast && typeof variable.contrast === "object" && !Array.isArray(variable.contrast)) {
          const contrast = { ...(variable.contrast as Record<string, unknown>) };
          if (contrast.kind === "binary_presence" || contrast.kind === "as_recorded") {
            variable.contrast = { kind: contrast.kind };
          } else if (contrast.kind === "numeric_threshold" || contrast.kind === "threshold") {
            const operatorAliases: Record<string, string> = { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };
            const numericValue = typeof contrast.value === "number" ? contrast.value : Number(contrast.value);
            variable.contrast = {
              ...contrast,
              kind: "threshold",
              operator: operatorAliases[String(contrast.operator)] ?? contrast.operator,
              ...(Number.isFinite(numericValue) ? { value: numericValue } : {}),
            };
          }
        }
        const sourceName = objective.exposure_or_predictors[index] ?? variable.name;
        if (typeof variable.operational_definition !== "string") variable.operational_definition = "由后续本地 MIMIC 变量映射确定";
        if (!hasConditionContract(variable.definition) && typeof sourceName === "string") variable.definition = { condition_id: `input.${index + 1}`, source_text: sourceName, kind: "concept", concept: sourceName, assertion: "present" };
        return variable;
      })
    : spec.exposure_or_predictors;
  const rawOutcome = Array.isArray(spec.outcome) && spec.outcome.length === 1 ? spec.outcome[0] : spec.outcome;
  const outcome = rawOutcome && typeof rawOutcome === "object" && !Array.isArray(rawOutcome)
    ? { ...(rawOutcome as Record<string, unknown>), role: "outcome" }
    : rawOutcome;
  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
    if (typeof outcome.operational_definition !== "string") outcome.operational_definition = "由后续本地 MIMIC 变量映射确定";
    if (!hasConditionContract(outcome.definition)) {
      outcome.definition = outcomeStructure === "binary"
        ? { condition_id: "outcome.target", source_text: objective.outcome, kind: "event_exists", concept: objective.outcome, occurrence: "present" }
        : { condition_id: "outcome.target", source_text: objective.outcome, kind: "concept", concept: objective.outcome, assertion: "present" };
    }
  }
  const timeWindows = Array.isArray(spec.time_windows) && spec.time_windows.length
    ? spec.time_windows.map((window) => window && typeof window === "object" && !Array.isArray(window) && "end_event" in window
      ? { purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }
      : window)
    : [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }];
  const rawEstimand = spec.estimand && typeof spec.estimand === "object" && !Array.isArray(spec.estimand)
    ? { ...(spec.estimand as Record<string, unknown>) }
    : undefined;
  const intercurrentHandling = typeof rawEstimand?.handling_of_intercurrents === "string"
    ? rawEstimand.handling_of_intercurrents
    : undefined;
  if (rawEstimand) {
    delete rawEstimand.handling_of_intercurrents;
    rawEstimand.target_population = objective.population;
    rawEstimand.exposure_contrast = objective.comparator
      ? `${objective.exposure_or_predictors.join(" 与 ")} vs ${objective.comparator}`
      : objective.exposure_or_predictors.join(" 与 ");
    rawEstimand.outcome_measure = objective.outcome;
  }
  const estimand = rawEstimand ?? {
    target_population: objective.population,
    exposure_contrast: objective.comparator ? `${objective.exposure_or_predictors.join(" 与 ")} vs ${objective.comparator}` : objective.exposure_or_predictors.join(" 与 "),
    outcome_measure: objective.outcome,
    summary_measure: outcomeStructure === "binary" ? "风险差" : "均值差",
  };
  const allowedAnalysisFamilies = new Set(["association", "binary_prediction", "propensity_weighted_treatment_effect", "time_to_event_association", "time_to_event_prediction", "time_to_event_treatment_effect"]);
  const analysisFamily = allowedAnalysisFamilies.has(String(spec.analysis_family)) ? spec.analysis_family : analysisFamilyFor(objective.purpose, outcomeStructure);
  const identificationAssumptions = Array.isArray(spec.identification_assumptions) ? spec.identification_assumptions : [];
  const assumptions = [
    ...(Array.isArray(spec.assumptions) ? spec.assumptions : []),
    ...identificationAssumptions,
    ...(intercurrentHandling ? [`Intercurrent event handling: ${intercurrentHandling}`] : []),
  ];
  delete spec.identification_assumptions;
  for (const assumption of [
    "服务端依据已确认目标和本地 MIMIC 能力补全最小可执行协议字段。",
    "未明确的时间窗限定为本次住院/ICU encounter 内，并由后续数据映射验证。",
  ]) if (!assumptions.includes(assumption)) assumptions.push(assumption);
  return { ...spec, population, index_time: indexTime, ...(exposureOrPredictors ? { exposure_or_predictors: exposureOrPredictors } : {}), ...(outcome ? { outcome } : {}), outcome_structure: outcomeStructure, time_windows: timeWindows, estimand, ...(analysisFamily ? { analysis_family: analysisFamily } : {}), assumptions };
};

const businessIssues = (objective: ResearchObjective, spec: StudySpec): string[] => {
  const issues = assessResearchProtocol(spec).requirements.filter(({ severity }) => severity === "required").map(({ code, field_path }) => `${code}:${field_path}`);
  if (spec.intent_family !== objective.purpose) issues.push("OBJECTIVE_PURPOSE_CHANGED:/intent_family");
  if (spec.research_question !== objective.question) issues.push("OBJECTIVE_QUESTION_CHANGED:/research_question");
  if (spec.population?.description !== objective.population) issues.push("OBJECTIVE_POPULATION_CHANGED:/population/description");
  const compact = (value: string): string => value.toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "");
  const populationText = compact(objective.population);
  const protectedTerms = [...objective.exposure_or_predictors, objective.outcome].map(compact).filter((term) => term.length >= 2);
  const populationLeaves = spec.population?.criteria ? listStudyConditions(spec.population.criteria).filter(({ kind }) => !["all", "any", "not"].includes(kind)) : [];
  for (const leaf of populationLeaves) {
    const leafTerms = [compact(leaf.source_text), ...("concept" in leaf ? [compact(leaf.concept)] : [])].filter((term) => term.length >= 2);
    if (protectedTerms.some((term) => leafTerms.some((leafTerm) => leafTerm.includes(term) || term.includes(leafTerm)) && !populationText.includes(term) && !term.includes(populationText))) issues.push(`OBJECTIVE_VARIABLE_ADDED_TO_POPULATION:${leaf.condition_id}`);
  }
  if (spec.population?.exclusion_criteria?.length && !/(?:排除|不含|除外|未患|无|without|exclude|free of)/iu.test(objective.population)) issues.push("OBJECTIVE_EXCLUSION_ADDED:/population/exclusion_criteria");
  const inputs = new Set((spec.exposure_or_predictors ?? []).map(({ name }) => name));
  for (const name of objective.exposure_or_predictors) if (!inputs.has(name)) issues.push(`OBJECTIVE_INPUT_MISSING:${name}`);
  if (spec.outcome?.name !== objective.outcome) issues.push("OBJECTIVE_OUTCOME_CHANGED:/outcome/name");
  const covariates = new Set((spec.covariates ?? []).map(({ name }) => name));
  const modifiers = new Set((spec.effect_modifiers ?? []).map(({ variable_name }) => variable_name));
  for (const name of objective.effect_modifiers) {
    if (!covariates.has(name)) issues.push(`OBJECTIVE_MODIFIER_COVARIATE_MISSING:${name}`);
    if (!modifiers.has(name)) issues.push(`OBJECTIVE_MODIFIER_MISSING:${name}`);
  }
  return issues;
};

/** Compiles one extracted objective while keeping model, schema, and protocol failures explicit. */
export class OpenAiCompatibleObjectiveStudySpecCompiler {
  private readonly validation = new JsonSchemaResearchDesignValidator();

  constructor(private readonly options: { base_url: string; api_key?: string; provider: string; model: string; timeout_ms: number; max_output_tokens: number; prompt: { id: string; version: string; content: string }; fetch?: FetchLike }) {}

  async compile(input: ObjectiveStudySpecCompilerInput): Promise<ObjectiveStudySpecCompilation> {
    const started = Date.now();
    const base = { schema_version: "1.0.0" as const, stage: "objective_study_spec_compile" as const, provider: this.options.provider, model: this.options.model, prompt: { id: this.options.prompt.id, version: this.options.prompt.version, sha256: digest(this.options.prompt.content) }, output_schema: { id: "study-spec", version: "1.0.0", sha256: digest(schemaText) }, objective_sha256: digest(JSON.stringify(input.objective)) };
    let responseReceived = false; let jsonParsed = false; let schemaPassed = false; let repairAttempts: 0 | 1 = 0; let outputMode: ObjectiveStudySpecAuditRecord["structured_output_mode"];
    try {
      const request = async (modelInput: unknown): Promise<{ payload: unknown; parsed: unknown }> => {
        jsonParsed = false;
        const send = async (responseFormat?: Record<string, unknown>): Promise<Response> => {
          const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.options.timeout_ms);
          try {
            return await (this.options.fetch ?? nodeHttp1Fetch)(`${this.options.base_url.replace(/\/$/u, "")}/chat/completions`, { method: "POST", headers: { ...(this.options.api_key ? { authorization: `Bearer ${this.options.api_key}` } : {}), "content-type": "application/json" }, body: JSON.stringify({ model: this.options.model, max_tokens: this.options.max_output_tokens, ...(this.options.provider === "local" ? { temperature: 0 } : {}), ...(responseFormat ? { response_format: responseFormat } : {}), messages: [{ role: "system", content: this.options.prompt.content }, { role: "user", content: JSON.stringify(modelInput) }] }), signal: controller.signal });
          } finally { clearTimeout(timer); }
        };
        let response = await send({ type: "json_schema", json_schema: { name: "objective_study_spec", strict: true, schema: strictSchema() } }); outputMode = "json_schema";
        const rejected = (status: number) => [400, 404, 415, 422].includes(status);
        if (rejected(response.status)) { response = await send({ type: "json_object" }); outputMode = "json_object"; }
        if (rejected(response.status)) { response = await send(); outputMode = "prompt_contract"; }
        responseReceived = true;
        if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
        const payload = await response.json(); const content = responseText(payload);
        if (!content) throw new Error("PROVIDER_RESPONSE_EMPTY");
        const parsed = parseJsonObject(content);
        if (parsed === undefined) throw new Error("JSON_PARSE_FAILED");
        jsonParsed = true; return { payload, parsed };
      };
      const taskInput = { research_objective: input.objective, ...(input.shared_context ? { shared_context: input.shared_context } : {}) };
      let { payload, parsed } = await request({ task_input: taskInput, output_contract: compactStudySpecContract() });
      parsed = completeExecutableDefaults(normalizePurposeRoles(parsed, input.objective), input.objective);
      let schemaIssues = this.validation.checkStudySpec(parsed);
      let protocolIssues = schemaIssues.length ? [] : businessIssues(input.objective, parsed as StudySpec);
      if (schemaIssues.length || protocolIssues.length) {
        repairAttempts = 1;
        ({ payload, parsed } = await request({ task: "Repair the prior output to satisfy every validation error and the strict response schema. Return only the complete corrected StudySpec.", task_input: taskInput, prior_output: parsed, validation_errors: [...schemaIssues, ...protocolIssues], output_contract: compactStudySpecContract() }));
        parsed = completeExecutableDefaults(normalizePurposeRoles(parsed, input.objective), input.objective);
        schemaIssues = this.validation.checkStudySpec(parsed);
        protocolIssues = schemaIssues.length ? [] : businessIssues(input.objective, parsed as StudySpec);
      }
      if (schemaIssues.length) throw new Error(`SCHEMA_VALIDATION_FAILED:${schemaIssues.join(" | ")}`);
      schemaPassed = true;
      if (protocolIssues.length) throw new Error(`BUSINESS_VALIDATION_FAILED:${protocolIssues.join(" | ")}`);
      const usage = (payload as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      const safeUsage = usage ? { ...(typeof usage.prompt_tokens === "number" ? { input_tokens: usage.prompt_tokens } : {}), ...(typeof usage.completion_tokens === "number" ? { output_tokens: usage.completion_tokens } : {}) } : undefined;
      const studySpec = parsed as StudySpec;
      return { objective_id: input.objective.objective_id, study_spec: studySpec, audit: [{ ...base, response_received: true, json_parse: "pass", schema_validation: "pass", business_validation: "pass", repair_attempts: repairAttempts, latency_ms: Date.now() - started, ...(outputMode ? { structured_output_mode: outputMode } : {}), ...(safeUsage && Object.keys(safeUsage).length ? { usage: safeUsage } : {}), output_integrity_id: digest(JSON.stringify(studySpec)) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "MODEL_UNAVAILABLE";
      const failureClass = error instanceof Error && error.name === "AbortError" ? "PROVIDER_TIMEOUT" : message.split(":", 1)[0]!;
      const validationErrors = failureClass.endsWith("VALIDATION_FAILED") ? message.slice(message.indexOf(":") + 1).split(" | ").filter(Boolean).map((issue) => issue.slice(0, 240)) : [];
      const audit: ObjectiveStudySpecAuditRecord = { ...base, response_received: responseReceived, json_parse: jsonParsed ? "pass" : responseReceived ? "fail" : "not_run", schema_validation: schemaPassed ? "pass" : jsonParsed ? "fail" : "not_run", business_validation: failureClass === "BUSINESS_VALIDATION_FAILED" ? "fail" : "not_run", repair_attempts: repairAttempts, failure_class: failureClass, ...(outputMode ? { structured_output_mode: outputMode } : {}), ...(validationErrors.length ? { validation_errors: validationErrors } : {}), latency_ms: Date.now() - started };
      throw Object.assign(new Error("The objective StudySpec compiler did not produce a valid result."), { audit });
    }
  }
}

export interface SavedObjectiveStudySpecArtifact {
  schema_version: "1.0.0";
  original_question: string;
  items: Array<{
    objective_id: string;
    objective_sha256: string;
    study_spec: StudySpec;
    study_spec_integrity_id: string;
    generated_by: {
      provider: string;
      model: string;
      prompt: { id: string; version: string; sha256: string };
    };
  }>;
}

/** Reuses only complete, hash-bound StudySpecs that still match the exact objective contract. */
export class SavedObjectiveStudySpecCompiler {
  private readonly artifact: SavedObjectiveStudySpecArtifact;
  private readonly validation = new JsonSchemaResearchDesignValidator();

  constructor(serialized: string, expectedQuestion: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(serialized); } catch { throw new Error("The saved objective StudySpec artifact is not valid JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The saved objective StudySpec artifact is invalid.");
    const artifact = parsed as Partial<SavedObjectiveStudySpecArtifact>;
    if (artifact.schema_version !== "1.0.0" || artifact.original_question !== expectedQuestion || !Array.isArray(artifact.items)) {
      throw new Error("The saved objective StudySpec artifact does not match the exact research question.");
    }
    this.artifact = artifact as SavedObjectiveStudySpecArtifact;
  }

  async compile(input: ObjectiveStudySpecCompilerInput): Promise<ObjectiveStudySpecCompilation> {
    const item = this.artifact.items.find(({ objective_id }) => objective_id === input.objective.objective_id);
    const objectiveSha256 = digest(JSON.stringify(input.objective));
    if (!item || item.objective_sha256 !== objectiveSha256 || item.study_spec_integrity_id !== digest(JSON.stringify(item.study_spec))) {
      throw new Error("No integrity-verified saved StudySpec matches this objective.");
    }
    const schemaIssues = this.validation.checkStudySpec(item.study_spec);
    const protocolIssues = schemaIssues.length ? [] : businessIssues(input.objective, item.study_spec);
    if (schemaIssues.length || protocolIssues.length) throw new Error("The saved StudySpec no longer passes the current objective contract.");
    return {
      objective_id: input.objective.objective_id,
      study_spec: structuredClone(item.study_spec),
      audit: [{
        schema_version: "1.0.0",
        stage: "objective_study_spec_compile",
        provider: "saved_artifact",
        model: item.generated_by.model,
        prompt: item.generated_by.prompt,
        output_schema: { id: "study-spec", version: "1.0.0", sha256: digest(schemaText) },
        objective_sha256: objectiveSha256,
        response_received: false,
        json_parse: "pass",
        schema_validation: "pass",
        business_validation: "pass",
        repair_attempts: 0,
        latency_ms: 0,
        output_integrity_id: item.study_spec_integrity_id,
      }],
    };
  }
}
