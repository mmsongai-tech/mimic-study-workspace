import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleClinicalTermExpander } from "../index.js";

test("uses a bounded structured model call only for terminology expansion", async () => {
  let request: Record<string, unknown> | undefined;
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "https://router.example/v1", api_key: "secret", model: "cheap-model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 900,
    fetch: async (_url, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ normalized_label_en: "Diabetes mellitus", synonyms: ["diabetes"], code_hints: ["E10", "E11", "250"], category: "diagnosis", ambiguities: [] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const expansion = await expander.expand({ term: "糖尿病", role: "population" });
  assert.equal(expansion.normalized_label_en, "Diabetes mellitus");
  assert.deepEqual(expansion.code_hints, ["E10", "E11", "250"]);
  assert.equal(request?.model, "cheap-model");
  assert.equal(request?.max_tokens, 500);
  assert.equal("temperature" in (request ?? {}), false);
  assert.equal((request?.response_format as { type?: string }).type, "json_schema");
});

test("falls back to JSON object mode and supplies an empty legacy code-hint list before local validation", async () => {
  const formats: string[] = [];
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "https://router.example/v1", model: "compatible-model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 500,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { response_format: { type: string } };
      formats.push(request.response_format.type);
      if (formats.length === 1) return new Response("unsupported response format", { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ normalized_label_en: "Generic diagnosis", synonyms: ["generic"], category: "diagnosis", ambiguities: [] }) } }] }), { status: 200 });
    },
  });
  const expansion = await expander.expand({ term: "通用诊断", role: "population" });
  assert.deepEqual(formats, ["json_schema", "json_object"]);
  assert.deepEqual(expansion.code_hints, []);
});

test("retains a safe HTTP status when terminology expansion is rejected", async () => {
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "https://router.example/v1", model: "model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 500,
    fetch: async () => new Response("unavailable", { status: 503 }),
  });
  await assert.rejects(expander.expand({ term: "通用概念", role: "outcome" }), /HTTP 503/u);
});

test("accepts a code-fenced JSON reply instead of reporting malformed content", async () => {
  const fenced = "```json\n" + JSON.stringify({ normalized_label_en: "Hypertension", synonyms: ["high blood pressure"], code_hints: ["I10", "401"], category: "diagnosis", ambiguities: [] }) + "\n```";
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "http://127.0.0.1:11434/v1", model: "local-model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 500,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: fenced } }] }), { status: 200 }),
  });
  const expansion = await expander.expand({ term: "高血压患者", role: "population" });
  assert.equal(expansion.normalized_label_en, "Hypertension");
  assert.deepEqual(expansion.code_hints, ["I10", "401"]);
});

test("still rejects replies that contain no JSON object", async () => {
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "http://127.0.0.1:11434/v1", model: "local-model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 500,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "I cannot help with that." } }] }), { status: 200 }),
  });
  await assert.rejects(expander.expand({ term: "高血压", role: "population" }), /malformed content/u);
});

test("drops unusable code hints and over-long lists instead of rejecting the expansion", async () => {
  const reply = {
    normalized_label_en: "Stroke", category: "diagnosis",
    synonyms: ["cerebrovascular accident", "CVA", "cerebrovascular accident", "x", "a", "b1", "c1", "d1", "e1", "f1", "g1"],
    code_hints: ["SNOMED:230690007", "ICD10CM.I63", "icd-9 434", "I61", "not a code"],
    ambiguities: [{ label: "Ischemic vs hemorrhagic", explanation: "Stroke subtype changes the code set." }, { label: "", explanation: "" }],
  };
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "http://127.0.0.1:11434/v1", model: "local-model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 500,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 }),
  });
  const expansion = await expander.expand({ term: "中风", role: "outcome" });
  assert.equal(expansion.normalized_label_en, "Stroke");
  assert.deepEqual(expansion.code_hints, ["I63", "434", "I61"]);
  assert.equal(expansion.synonyms.length, 8);
  assert.deepEqual(expansion.ambiguities, [{ label: "Ischemic vs hemorrhagic", explanation: "Stroke subtype changes the code set." }]);
});

test("repairs a schema-invalid reply on one retry instead of failing immediately", async () => {
  const replies = [
    { normalized_label_en: "Stroke", category: "disease", synonyms: [], code_hints: [], ambiguities: [] },
    { normalized_label_en: "Stroke", category: "diagnosis", synonyms: [], code_hints: ["I63"], ambiguities: [] },
  ];
  let call = 0;
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "http://127.0.0.1:11434/v1", model: "local-model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 500,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies[call++]) } }] }), { status: 200 });
    },
  });
  const expansion = await expander.expand({ term: "中风", role: "outcome" });
  assert.equal(call, 2);
  assert.equal(expansion.normalized_label_en, "Stroke");
  assert.deepEqual(expansion.code_hints, ["I63"]);
  // The repair turn replays the failed reply plus a message describing the rule violation.
  const repairBody = bodies[1];
  assert.ok(repairBody);
  assert.equal(repairBody.messages.length, 4);
  assert.equal(repairBody.messages[2]?.role, "assistant");
  assert.match(repairBody.messages[3]?.content ?? "", /broke these rules/u);
});

test("gives up after exhausting repair attempts on a persistently invalid reply", async () => {
  let call = 0;
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "http://127.0.0.1:11434/v1", model: "local-model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 500,
    fetch: async () => { call += 1; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ normalized_label_en: "Stroke", synonyms: [], code_hints: [], category: "disease", ambiguities: [] }) } }] }), { status: 200 }); },
  });
  await assert.rejects(expander.expand({ term: "中风", role: "outcome" }), /output contract/u);
  assert.equal(call, 2);
});

test("still rejects an expansion whose category is outside the contract", async () => {
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "http://127.0.0.1:11434/v1", model: "local-model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 500,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ normalized_label_en: "Stroke", synonyms: [], code_hints: [], category: "disease", ambiguities: [] }) } }] }), { status: 200 }),
  });
  await assert.rejects(expander.expand({ term: "中风", role: "outcome" }), /output contract/u);
});

test("keeps code hints only for coded categories and strips study-role words from the label", async () => {
  const replies = [
    { normalized_label_en: "Metoprolol", synonyms: [], code_hints: ["44110", "C07AB02"], category: "medication", ambiguities: [] },
    { normalized_label_en: "hypertension population", synonyms: [], code_hints: ["I10", "401"], category: "diagnosis", ambiguities: [] },
    { normalized_label_en: "All-cause Mortality Outcome", synonyms: [], code_hints: ["E10"], category: "outcome", ambiguities: [] },
  ];
  let call = 0;
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "http://127.0.0.1:11434/v1", model: "local-model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 500,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies[call++]) } }] }), { status: 200 }),
  });
  const drug = await expander.expand({ term: "美托洛尔", role: "exposure" });
  const population = await expander.expand({ term: "高血压人群", role: "population" });
  const death = await expander.expand({ term: "全因死亡结局", role: "outcome" });
  assert.deepEqual(drug.code_hints, []);
  assert.equal(population.normalized_label_en, "hypertension");
  assert.deepEqual(population.code_hints, ["I10", "401"]);
  assert.equal(death.normalized_label_en, "All-cause Mortality");
  assert.deepEqual(death.code_hints, []);
});

test("uses the ingredient name for medications and sends temperature only when configured", async () => {
  const { drugIngredientName } = await import("../index.js");
  assert.equal(drugIngredientName("Metoprolol Tartrate"), "Metoprolol");
  assert.equal(drugIngredientName("Metoprolol Succinate XL"), "Metoprolol");
  assert.equal(drugIngredientName("Amlodipine besylate"), "Amlodipine");
  let body: Record<string, unknown> | undefined;
  const expander = new OpenAiCompatibleClinicalTermExpander({
    base_url: "http://127.0.0.1:11434/v1", model: "local-model", system_prompt: "normalize only", timeout_ms: 1000, max_output_tokens: 500, temperature: 0,
    fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ normalized_label_en: "Metoprolol Tartrate", synonyms: [], code_hints: [], category: "medication", ambiguities: [] }) } }] }), { status: 200 }); },
  });
  const expansion = await expander.expand({ term: "美托洛尔", role: "exposure" });
  assert.equal(expansion.normalized_label_en, "Metoprolol");
  assert.equal(body?.temperature, 0);
});

test("keeps the first word of a drug or class name when stripping salt words", async () => {
  const { drugIngredientName } = await import("../index.js");
  assert.equal(drugIngredientName("Calcium Channel Blocker"), "Calcium Channel Blocker");
  assert.equal(drugIngredientName("Potassium Chloride"), "Potassium");
  assert.equal(drugIngredientName("Metoprolol Succinate XL"), "Metoprolol");
});
