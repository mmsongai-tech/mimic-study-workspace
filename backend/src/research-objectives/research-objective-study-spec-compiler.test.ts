import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleObjectiveStudySpecCompiler, SavedObjectiveStudySpecCompiler, type ResearchObjective } from "./index.js";

const objective: ResearchObjective = { objective_id: "objective-1", purpose: "treatment_effect", relationship: "primary", question: "治疗对结局有什么影响？", population: "目标住院人群", exposure_or_predictors: ["治疗"], comparator: "未治疗", outcome: "结局", effect_modifiers: ["分组变量"], source_claims: ["治疗", "结局", "分组变量"] };
const completeSpec = { schema_version: "1.0.0", intent_family: "treatment_effect", title: "治疗效果研究", research_question: objective.question, population: { description: "目标住院人群", inclusion_criteria: ["符合目标人群"], criteria: { condition_id: "population.target", source_text: "目标住院人群", kind: "concept", concept: "目标住院人群", assertion: "present" } }, index_time: { event: "入组", selection_rule: "每次符合条件的住院" }, exposure_or_predictors: [{ name: "治疗", role: "exposure", operational_definition: "基线时是否接受治疗", definition: { condition_id: "exposure.treatment", source_text: "治疗", kind: "concept", concept: "治疗", assertion: "present" }, contrast: { kind: "binary_presence" } }], outcome: { name: "结局", role: "outcome", operational_definition: "随访期记录的结局", definition: { condition_id: "outcome.event", source_text: "结局", kind: "event_exists", concept: "结局", occurrence: "present" }, contrast: { kind: "binary_presence" } }, outcome_structure: "binary", time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], covariates: [{ name: "分组变量", role: "covariate", operational_definition: "入组前记录的分组变量", definition: { condition_id: "covariate.group", source_text: "分组变量", kind: "concept", concept: "分组变量", assertion: "present" } }], effect_modifiers: [{ variable_name: "分组变量", analysis: "interaction_and_stratified" }], estimand: { target_population: "目标住院人群", exposure_contrast: "治疗与未治疗", outcome_measure: "结局风险", summary_measure: "风险差" }, analysis_family: "propensity_weighted_treatment_effect", assumptions: ["未说明的基线窗口需要研究者复核"] };

const compiler = (responses: unknown[], requests: Array<Record<string, unknown>> = []) => new OpenAiCompatibleObjectiveStudySpecCompiler({ base_url: "https://router.invalid/v1", api_key: "secret", provider: "router", model: "test-model", timeout_ms: 1000, max_output_tokens: 2000, prompt: { id: "research-objective-study-spec", version: "1.0.0", content: "compile" }, fetch: async (_url, init) => { requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), { status: 200 }); } });

test("compiles an objective through strict schema and protocol validation", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const result = await compiler([completeSpec], requests).compile({ objective, shared_context: { population_hint: "住院人群" } });
  assert.equal(result.objective_id, objective.objective_id);
  assert.equal(result.study_spec.research_question, objective.question);
  assert.equal(result.audit[0]?.business_validation, "pass");
  assert.equal((requests[0]?.response_format as { json_schema: { strict: boolean } }).json_schema.strict, true);
  assert.doesNotMatch(JSON.stringify(result.audit), /secret|治疗对结局有什么影响|"compile"/u);
});

test("restores upstream effect modifiers without a full model rewrite", async () => {
  const incomplete = { ...completeSpec, effect_modifiers: [], covariates: [] };
  const result = await compiler([incomplete]).compile({ objective });
  assert.equal(result.audit[0]?.repair_attempts, 0);
  assert.equal(result.study_spec.effect_modifiers?.[0]?.variable_name, "分组变量");
  assert.equal(result.study_spec.covariates?.[0]?.name, "分组变量");
});

test("normalizes mechanical JSON-mode fields without changing objective semantics", async () => {
  const mechanical = {
    ...completeSpec,
    comparator: "模型生成的额外比较组别名",
    population: { description: objective.population, criteria: { kind: "all", children: [] } },
    index_time: { event: "入组" },
    exposure_or_predictors: completeSpec.exposure_or_predictors.map(({ operational_definition: _definition, ...variable }) => ({ ...variable, contrast: { kind: "binary_presence", operator: "equals", value: 1 } })),
    outcome: { name: objective.outcome },
    time_windows: [{ purpose: "follow-up", anchor: "admission", end_event: "end of hospital encounter", description: "住院期间" }],
    analysis_family: "causal_inference",
    identification_assumptions: ["无未测量混杂"],
  };

  const result = await compiler([mechanical]).compile({ objective });

  assert.equal(result.audit[0]?.repair_attempts, 0);
  assert.equal(result.study_spec.population?.criteria?.kind, "concept");
  assert.equal(result.study_spec.index_time?.selection_rule, "按每次符合条件的 encounter 计入");
  assert.deepEqual(result.study_spec.exposure_or_predictors?.[0]?.contrast, { kind: "binary_presence" });
  assert.equal(result.study_spec.outcome?.role, "outcome");
  assert.deepEqual(result.study_spec.time_windows, [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }]);
  assert.equal(result.study_spec.analysis_family, "propensity_weighted_treatment_effect");
  assert.ok(result.study_spec.assumptions?.includes("无未测量混杂"));
  assert.equal(result.study_spec.estimand?.exposure_contrast, "治疗 vs 未治疗");
  assert.equal("comparator" in result.study_spec, false);
});

test("preserves intercurrent handling as an assumption outside the strict estimand", async () => {
  const withIntercurrentHandling = {
    ...completeSpec,
    estimand: { ...completeSpec.estimand, handling_of_intercurrents: "Censor at treatment discontinuation." },
  };

  const result = await compiler([withIntercurrentHandling]).compile({ objective });

  assert.equal("handling_of_intercurrents" in (result.study_spec.estimand as unknown as Record<string, unknown>), false);
  assert.ok(result.study_spec.assumptions?.includes("Intercurrent event handling: Censor at treatment discontinuation."));
});

test("fails closed after one repair and reports safe business errors", async () => {
  const changed = { ...completeSpec, outcome: { ...completeSpec.outcome, name: "其他结局" } };
  await assert.rejects(() => compiler([changed, changed]).compile({ objective }), (error: Error & { audit?: { failure_class: string; repair_attempts: number; validation_errors?: string[] } }) => error.audit?.failure_class === "BUSINESS_VALIDATION_FAILED" && error.audit.repair_attempts === 1 && error.audit.validation_errors?.some((issue) => issue.includes("OBJECTIVE_OUTCOME_CHANGED")) === true && !JSON.stringify(error.audit).includes(objective.question));
});

test("separates provider failures from parse and validation", async () => {
  const service = new OpenAiCompatibleObjectiveStudySpecCompiler({ base_url: "https://router.invalid/v1", api_key: "secret", provider: "router", model: "test-model", timeout_ms: 1000, max_output_tokens: 2000, prompt: { id: "research-objective-study-spec", version: "1.0.0", content: "compile" }, fetch: async () => new Response("unavailable", { status: 503 }) });
  await assert.rejects(() => service.compile({ objective }), (error: Error & { audit?: { failure_class: string; json_parse: string; schema_validation: string } }) => error.audit?.failure_class === "PROVIDER_HTTP_503" && error.audit.json_parse === "fail" && error.audit.schema_validation === "not_run");
});

test("local provider compiles through model JSON and fails closed without a rule fallback", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const service = new OpenAiCompatibleObjectiveStudySpecCompiler({ base_url: "http://127.0.0.1:11434/v1", provider: "local", model: "local-test", timeout_ms: 1000, max_output_tokens: 2000, prompt: { id: "research-objective-study-spec", version: "1.0.0", content: "compile" }, fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(completeSpec) } }] }), { status: 200 });
  } });
  const result = await service.compile({ objective });
  assert.equal(requests.length, 1);
  assert.equal((requests[0]?.response_format as { type: string }).type, "json_schema");
  assert.equal(result.audit[0]?.provider, "local");
  assert.equal(result.audit[0]?.failure_class, undefined);

  const invalid = new OpenAiCompatibleObjectiveStudySpecCompiler({ base_url: "http://127.0.0.1:11434/v1", provider: "local", model: "local-test", timeout_ms: 1000, max_output_tokens: 2000, prompt: { id: "research-objective-study-spec", version: "1.0.0", content: "compile" }, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }) });
  await assert.rejects(() => invalid.compile({ objective }), (error: Error & { audit?: { failure_class?: string } }) => error.audit?.failure_class === "SCHEMA_VALIDATION_FAILED");
});

test("rejects model-invented population restrictions derived from the exposure or outcome", async () => {
  const simpleObjective: ResearchObjective = { ...objective, population: "ICU患者", exposure_or_predictors: ["血清乳酸"], outcome: "急性肾损伤发生率", effect_modifiers: [] };
  const invented = { ...completeSpec, research_question: simpleObjective.question, population: { description: "ICU患者", inclusion_criteria: ["ICU患者"], exclusion_criteria: ["入科时已有急性肾损伤"], criteria: { condition_id: "population", source_text: "ICU患者且入科时无急性肾损伤", kind: "all", operands: [{ condition_id: "icu", source_text: "ICU患者", kind: "concept", concept: "ICU患者", assertion: "present" }, { condition_id: "aki", source_text: "入科时已有急性肾损伤", kind: "concept", concept: "急性肾损伤", assertion: "absent" }] } }, exposure_or_predictors: [{ ...completeSpec.exposure_or_predictors[0], name: "血清乳酸" }], outcome: { ...completeSpec.outcome, name: "急性肾损伤发生率" }, covariates: [], effect_modifiers: [] };
  await assert.rejects(() => compiler([invented, invented]).compile({ objective: simpleObjective }), (error: Error & { audit?: { validation_errors?: string[] } }) => error.audit?.validation_errors?.some((issue) => issue.includes("OBJECTIVE_VARIABLE_ADDED_TO_POPULATION") || issue.includes("OBJECTIVE_EXCLUSION_ADDED")) === true);
});

test("reuses only an integrity-bound StudySpec for the exact objective and question", async () => {
  const crypto = await import("node:crypto");
  const hash = (value: unknown) => `sha256:${crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
  const serialized = JSON.stringify({ schema_version: "1.0.0", original_question: "完整研究问题", items: [{ objective_id: objective.objective_id, objective_sha256: hash(objective), study_spec: completeSpec, study_spec_integrity_id: hash(completeSpec), generated_by: { provider: "router", model: "test-model", prompt: { id: "research-objective-study-spec", version: "1.0.0", sha256: hash("prompt") } } }] });

  const result = await new SavedObjectiveStudySpecCompiler(serialized, "完整研究问题").compile({ objective });

  assert.equal(result.study_spec.research_question, objective.question);
  assert.equal(result.audit[0]?.provider, "saved_artifact");
  assert.throws(() => new SavedObjectiveStudySpecCompiler(serialized, "另一个问题"), /does not match/u);
});
