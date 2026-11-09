import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleStructuredProvider } from "../openai-compatible-structured-provider.js";
import { completeAssociationProposal } from "../../research-design/tests/model-fixtures.js";
import { RESEARCH_DESIGN_COMPACT_OUTPUT_CONTRACT, RESEARCH_DESIGN_OUTPUT_CONTRACT } from "../research-design-output-contract.js";

test("initial request uses equivalent compact schema; repair restores canonical representation", async () => {
  const bodies: Array<{ messages: Array<{ content: string }> }> = [];
  const provider = new OpenAiCompatibleStructuredProvider({ base_url: "https://example.invalid/v1", max_output_tokens: 1000,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(bodies.length === 1 ? {} : completeAssociationProposal()) } }] }));
    } });
  await provider.generateProposal({ profile: "synthetic", system_prompt: "Stable instructions", timeout_ms: 1000,
    model_input: { request: { message: "Synthetic question", client_request_id: "repair" }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } } });
  assert.equal(bodies.length, 2);
  assert.deepEqual(JSON.parse(bodies[0]!.messages[1]!.content).output_contract, RESEARCH_DESIGN_COMPACT_OUTPUT_CONTRACT);
  assert.deepEqual(JSON.parse(bodies[1]!.messages[1]!.content).output_contract, RESEARCH_DESIGN_OUTPUT_CONTRACT);
});

test("context compaction preserves values, labels, conflicting answers, free text and caller state", async () => {
  let visible: any;
  const provider = new OpenAiCompatibleStructuredProvider({ base_url: "https://example.invalid/v1", max_output_tokens: 1000,
    fetch: async (_url, init) => {
      visible = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).model_input;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(completeAssociationProposal()) } }] }));
    } });
  const context = { question_id: "window", question: "Which window?", selected_value: "encounter", selected_label: "Current encounter" };
  const history = [
    { message: "Keep every outcome", answers: { window: "encounter" }, answer_context: [context] },
    { answers: { window: "different" }, answer_context: [context] },
    { answers: { window: "encounter", missing: false }, answer_context: [context] },
    { answers: { choices: ["a", "b"] }, answer_context: [{ ...context, question_id: "choices", selected_value: ["a", "b"] }] },
  ];
  const original = structuredClone(history);
  await provider.generateProposal({ profile: "synthetic", system_prompt: "Instructions", timeout_ms: 1000,
    model_input: { request: { message: "Keep current choice", client_request_id: "context" }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" }, clarification_history: history } });
  assert.equal(visible.clarification_history.length, 4);
  assert.equal(visible.clarification_history[0].answers, undefined);
  assert.equal(visible.clarification_history[0].message, "Keep every outcome");
  assert.deepEqual(visible.clarification_history[0].answer_context, [context]);
  assert.deepEqual(visible.clarification_history[1].answers, history[1]!.answers);
  assert.deepEqual(visible.clarification_history[2].answers, history[2]!.answers);
  assert.equal(visible.clarification_history[3].answers, undefined);
  assert.deepEqual(history, original);
});

test("request metadata does not change model-visible bytes or mutate the caller's request", async () => {
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const provider = new OpenAiCompatibleStructuredProvider({ base_url: "https://example.invalid/v1", max_output_tokens: 1000,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(completeAssociationProposal()) } }] }));
    } });
  for (const id of ["first", "second"]) {
    const request = { message: "Synthetic research", client_request_id: id, session_id: id, base_revision: id === "first" ? 1 : 2, allow_openai_fallback: false };
    await provider.generateProposal({ profile: "synthetic-model", system_prompt: "Stable synthetic instructions", timeout_ms: 1000,
      model_input: { request, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } } });
    assert.equal(request.client_request_id, id);
    assert.equal(request.session_id, id);
  }
  assert.deepEqual(bodies[0]?.messages, bodies[1]?.messages);
  const visible = JSON.parse(bodies[0]!.messages[1]!.content);
  assert.deepEqual(visible.model_input.request, { message: "Synthetic research" });
});

test("different questions keep the stable contract prefix before dynamic context", async () => {
  const contents: string[] = [];
  const provider = new OpenAiCompatibleStructuredProvider({ base_url: "https://example.invalid/v1", max_output_tokens: 1000,
    fetch: async (_url, init) => {
      contents.push(JSON.parse(String(init?.body)).messages[1].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(completeAssociationProposal()) } }] }));
    } });
  for (const message of ["Synthetic question A", "Synthetic question B"]) {
    await provider.generateProposal({ profile: "synthetic-model", system_prompt: "Stable instructions", timeout_ms: 1000,
      model_input: { request: { message, client_request_id: message }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } } });
  }
  assert.notEqual(contents[0], contents[1]);
  assert.ok(contents[0]!.startsWith('{"output_contract":'));
  const prefix = (content: string) => content.slice(0, content.indexOf('"model_input":'));
  assert.equal(prefix(contents[0]!), prefix(contents[1]!));
  assert.ok(prefix(contents[0]!).length > 1000);
});
