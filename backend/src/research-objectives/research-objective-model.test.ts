import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleResearchObjectiveModel } from "./index.js";

const objective = { schema_version: "1.0.0", original_question: "治疗对血压和死亡的影响", objectives: [
  { objective_id: "bp", purpose: "treatment_effect", relationship: "primary", question: "治疗对血压的影响", population: "目标人群", exposure_or_predictors: ["治疗"], comparator: "未治疗", outcome: "血压", effect_modifiers: [], source_claims: ["血压"] },
  { objective_id: "death", purpose: "treatment_effect", relationship: "secondary", question: "治疗对死亡的影响", population: "目标人群", exposure_or_predictors: ["治疗"], comparator: "未治疗", outcome: "死亡", effect_modifiers: [], source_claims: ["死亡"] },
], ambiguities: [] };
const coverage = { schema_version: "1.0.0", decision: "pass", covered_claims: ["血压", "死亡"], missing_claims: [], altered_claims: [], unsupported_additions: [], explanation: "全部目标已保留" };

test("uses strict schemas for extraction and independent coverage review", async () => {
  const requests: Array<Record<string, unknown>> = []; let calls = 0;
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: "https://router.invalid/v1", api_key: "secret", provider: "router", model: "test-model", timeout_ms: 1000, max_output_tokens: 1000, objective_prompt: { id: "research-objectives", version: "1.0.0", content: "extract" }, coverage_prompt: { id: "research-objective-coverage", version: "1.0.0", content: "review" }, fetch: async (_url, init) => { requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>); const value = calls++ === 0 ? objective : coverage; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), { status: 200 }); } });
  const result = await model.analyze(objective.original_question);
  assert.equal(result.objective_list.objectives.length, 2); assert.equal(result.coverage.decision, "pass"); assert.equal(result.audit.length, 2);
  assert.ok(requests.every((request) => (request.response_format as { json_schema: { strict: boolean } }).json_schema.strict));
  const extractionContract = ((requests[0]?.messages as Array<{ content: string }>)[1]?.content ?? "");
  assert.match(extractionContract, /effect_modification/u);
  assert.match(extractionContract, /affected_objective_ids/u);
  assert.ok(result.audit.every((entry) => entry.schema_validation === "pass" && entry.output_integrity_id?.startsWith("sha256:")));
  assert.doesNotMatch(JSON.stringify(result.audit), /"secret"|"content":"extract"|"content":"review"/u);
});

test("accepts a fenced JSON object without weakening schema validation", async () => {
  let calls = 0;
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: "https://router.invalid/v1", api_key: "secret", provider: "router", model: "test-model", timeout_ms: 1000, max_output_tokens: 1000, objective_prompt: { id: "research-objectives", version: "1.0.0", content: "extract" }, coverage_prompt: { id: "research-objective-coverage", version: "1.0.0", content: "review" }, fetch: async () => {
    const value = calls++ === 0 ? objective : coverage;
    return new Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` } }] }), { status: 200 });
  } });
  const result = await model.analyze(objective.original_question);
  assert.equal(result.objective_list.objectives.length, 2);
  assert.equal(result.coverage.decision, "pass");
});

test("local provider uses the model JSON path and never substitutes deterministic objectives", async () => {
  const requests: Array<Record<string, unknown>> = []; let calls = 0;
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: "http://127.0.0.1:11434/v1", provider: "local", model: "local-test", timeout_ms: 1000, max_output_tokens: 1000, objective_prompt: { id: "research-objectives", version: "1.0.0", content: "extract" }, coverage_prompt: { id: "research-objective-coverage", version: "1.0.0", content: "review" }, fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const value = calls++ === 0 ? objective : coverage;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
  } });
  const result = await model.analyze(objective.original_question);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => (request.response_format as { type: string }).type === "json_schema"));
  assert.ok(result.audit.every(({ provider, failure_class }) => provider === "local" && failure_class === undefined));
});

test("local provider fails closed instead of creating rule-derived objectives", async () => {
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: "http://127.0.0.1:11434/v1", provider: "local", model: "local-test", timeout_ms: 1000, max_output_tokens: 1000, objective_prompt: { id: "research-objectives", version: "1.0.0", content: "extract" }, coverage_prompt: { id: "research-objective-coverage", version: "1.0.0", content: "review" }, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }) });
  await assert.rejects(() => model.analyze("随机研究问题"), (error: Error & { audit?: { failure_class?: string } }) => error.audit?.failure_class === "SCHEMA_VALIDATION_FAILED");
});

test("fails closed and attaches a safe audit record for schema-invalid output", async () => {
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: "https://router.invalid/v1", api_key: "secret", provider: "router", model: "test-model", timeout_ms: 1000, max_output_tokens: 1000, objective_prompt: { id: "research-objectives", version: "1.0.0", content: "extract" }, coverage_prompt: { id: "research-objective-coverage", version: "1.0.0", content: "review" }, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }) });
  await assert.rejects(() => model.analyze("问题"), (error: Error & { audit?: { failure_class: string } }) => error.audit?.failure_class === "SCHEMA_VALIDATION_FAILED" && !JSON.stringify(error.audit).includes("secret"));
});

test("restores the server-owned original question without a model rewrite", async () => {
  let calls = 0;
  const wrongQuestion = { ...objective, original_question: "模型改写后的问题" };
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: "https://router.invalid/v1", api_key: "secret", provider: "router", model: "test-model", timeout_ms: 1000, max_output_tokens: 1000, objective_prompt: { id: "research-objectives", version: "1.0.0", content: "extract" }, coverage_prompt: { id: "research-objective-coverage", version: "1.0.0", content: "review" }, fetch: async () => {
    const value = calls++ === 0 ? wrongQuestion : coverage;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
  } });
  const result = await model.analyze(objective.original_question);
  assert.equal(result.objective_list.original_question, objective.original_question);
  assert.equal(result.audit[0]?.business_validation, "pass");
  assert.equal(result.audit[0]?.repair_attempts, 0);
  assert.equal(calls, 2);
});

test("classifies token-limited malformed output as truncated", async () => {
  const content = '{"schema_version":"1.0.0"';
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: "https://router.invalid/v1", api_key: "secret", provider: "router", model: "test-model", timeout_ms: 1000, max_output_tokens: 1000, objective_prompt: { id: "research-objectives", version: "1.0.0", content: "extract" }, coverage_prompt: { id: "research-objective-coverage", version: "1.0.0", content: "review" }, fetch: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content } }] }), { status: 200 }) });
  await assert.rejects(() => model.analyze("问题"), (error: Error & { audit?: { failure_class: string; finish_reason?: string; response_chars?: number } }) =>
    error.audit?.failure_class === "OUTPUT_TRUNCATED" && error.audit.finish_reason === "length" && error.audit.response_chars === content.length);
});

test("fails closed on contradictory coverage and records business failure separately", async () => {
  let calls = 0;
  const contradictory = { ...coverage, missing_claims: ["死亡"] };
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: "https://router.invalid/v1", api_key: "secret", provider: "router", model: "test-model", timeout_ms: 1000, max_output_tokens: 1000, objective_prompt: { id: "research-objectives", version: "1.0.0", content: "extract" }, coverage_prompt: { id: "research-objective-coverage", version: "1.0.0", content: "review" }, fetch: async () => {
    const value = calls++ === 0 ? objective : contradictory;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
  } });
  await assert.rejects(() => model.analyze(objective.original_question), (error: Error & { audit?: { failure_class: string; schema_validation: string; business_validation: string; repair_attempts: number } }) =>
    error.audit?.failure_class === "BUSINESS_VALIDATION_FAILED" && error.audit.schema_validation === "pass" && error.audit.business_validation === "fail" && error.audit.repair_attempts === 1);
});

test("does not claim parse or validation ran when the provider rejects the request", async () => {
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: "https://router.invalid/v1", api_key: "secret", provider: "router", model: "test-model", timeout_ms: 1000, max_output_tokens: 1000, objective_prompt: { id: "research-objectives", version: "1.0.0", content: "extract" }, coverage_prompt: { id: "research-objective-coverage", version: "1.0.0", content: "review" }, fetch: async () => new Response("unavailable", { status: 503 }) });
  await assert.rejects(() => model.analyze(objective.original_question), (error: Error & { audit?: { response_received: boolean; json_parse: string; schema_validation: string; business_validation: string } }) =>
    error.audit?.response_received === true && error.audit.json_parse === "fail" && error.audit.schema_validation === "not_run" && error.audit.business_validation === "not_run");
});

test("performs one semantic objective repair and an independent coverage recheck", async () => {
  const initial = { ...objective, objectives: [objective.objectives[0]!] };
  const needsReview = { ...coverage, decision: "needs_review", covered_claims: ["血压"], missing_claims: ["死亡"], explanation: "遗漏死亡目标" };
  const responses = [initial, needsReview, objective, coverage];
  const requests: Array<Record<string, unknown>> = [];
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: "https://router.invalid/v1", api_key: "secret", provider: "router", model: "test-model", timeout_ms: 1000, max_output_tokens: 1000, objective_prompt: { id: "research-objectives", version: "1.0.0", content: "extract" }, coverage_prompt: { id: "research-objective-coverage", version: "1.0.0", content: "review" }, fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const value = responses.shift();
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
  } });
  const result = await model.analyze(objective.original_question);
  assert.equal(result.objective_list.objectives.length, 2);
  assert.equal(result.coverage.decision, "pass");
  assert.deepEqual(result.audit.map(({ stage }) => stage), ["objective_extraction", "objective_coverage", "objective_semantic_repair", "objective_coverage_recheck"]);
  assert.equal(requests.length, 4);
  assert.doesNotMatch(JSON.stringify(result.audit), /治疗对血压和死亡的影响|遗漏死亡目标/u);
});
