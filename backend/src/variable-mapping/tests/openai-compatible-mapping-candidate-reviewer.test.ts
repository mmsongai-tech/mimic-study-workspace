import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleMappingCandidateReviewer, mappingCandidateEvidenceDigest, type MappingCandidateReviewInput } from "../index.js";

const input: MappingCandidateReviewInput = {
  requested_term: "target concept",
  role: "exposure",
  candidates: [{
    candidate_id: "candidate:1",
    mapping_status: "database_verified",
    confidence: "low",
    source: { schema: "mimiciv_hosp", table: "diagnoses_icd", dictionary_table: "d_icd_diagnoses" },
    dictionary_entries: [{ evidence_key: "d_icd_diagnoses:10:A1", dictionary: "d_icd_diagnoses", identifier: "A1", code_version: 10, label: "Target concept" }],
  }],
};

test("uses strict JSON Schema and attaches non-clinical review provenance", async () => {
  let requestBody: Record<string, unknown> = {};
  const reviewer = new OpenAiCompatibleMappingCandidateReviewer({
    base_url: "https://provider.test/v1", api_key: "secret", model: "review-model", system_prompt: "review supplied evidence", timeout_ms: 1_000, max_output_tokens: 4_000, now: () => "2026-09-10T00:00:00.000Z",
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schema_version: "1.0.0", requested_term: "target concept", decision: "approved", selected_candidate_id: "candidate:1", selected_evidence_keys: ["d_icd_diagnoses:10:A1"], ranked_candidate_ids: ["candidate:1"], reason_codes: ["DIRECT_LABEL_MATCH"], explanation: "The supplied label directly matches." }) } }] }), { status: 200 });
    },
  });

  const result = await reviewer.review(input);

  assert.equal((requestBody.response_format as { json_schema: { strict: boolean } }).json_schema.strict, true);
  assert.equal(result.evidence_sha256, mappingCandidateEvidenceDigest(input));
  assert.equal(result.authorization_basis, "runtime_configured_automated_review");
  assert.equal(result.clinical_confirmation, false);
  assert.equal(result.model, "review-model");
});

test("rejects model output outside the strict review contract", async () => {
  const reviewer = new OpenAiCompatibleMappingCandidateReviewer({
    base_url: "https://provider.test/v1", api_key: "secret", model: "review-model", system_prompt: "review", timeout_ms: 1_000, max_output_tokens: 1_000,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schema_version: "1.0.0", requested_term: "target concept", decision: "approved", selected_candidate_id: "candidate:1", selected_evidence_keys: [], ranked_candidate_ids: [], reason_codes: [], explanation: "unsupported", invented_field: true }) } }] }), { status: 200 }),
  });
  await assert.rejects(() => reviewer.review(input), /failed its output contract/u);
});

test("falls back to json_object when the provider rejects json_schema", async () => {
  const formats: string[] = [];
  let modelVisibleSchema = false;
  const reviewer = new OpenAiCompatibleMappingCandidateReviewer({
    base_url: "https://provider.test/v1", api_key: "secret", model: "review-model", system_prompt: "review", timeout_ms: 1_000, max_output_tokens: 1_000,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { response_format: { type: string }; messages: Array<{ role: string; content: string }> };
      formats.push(body.response_format.type);
      modelVisibleSchema = modelVisibleSchema || body.messages.some(({ role, content }) => role === "user" && content.includes("output_schema"));
      if (formats.length === 1) return new Response("unsupported", { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schema_version: "1.0.0", requested_term: "target concept", decision: "blocked", selected_candidate_id: null, selected_evidence_keys: [], ranked_candidate_ids: ["candidate:1"], reason_codes: ["INSUFFICIENT_EVIDENCE"], explanation: "The supplied evidence is insufficient." }) } }] }), { status: 200 });
    },
  });

  const result = await reviewer.review(input);

  assert.deepEqual(formats, ["json_schema", "json_object"]);
  assert.equal(modelVisibleSchema, true);
  assert.equal(result.decision, "blocked");
});

test("accepts a schema-valid review wrapped in a JSON code fence", async () => {
  const resultBody = { schema_version: "1.0.0", requested_term: "target concept", decision: "approved", selected_candidate_id: "candidate:1", selected_evidence_keys: ["d_icd_diagnoses:10:A1"], ranked_candidate_ids: ["candidate:1"], reason_codes: ["DIRECT_LABEL_MATCH"], explanation: "The supplied label directly matches." };
  const reviewer = new OpenAiCompatibleMappingCandidateReviewer({
    base_url: "https://provider.test/v1", api_key: "secret", model: "review-model", system_prompt: "review", timeout_ms: 1_000, max_output_tokens: 1_000,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(resultBody)}\n\`\`\`` } }] }), { status: 200 }),
  });
  assert.equal((await reviewer.review(input)).decision, "approved");
});

test("accepts an exact data envelope around a schema-valid review", async () => {
  const resultBody = { schema_version: "1.0.0", requested_term: "target concept", decision: "approved", selected_candidate_id: "candidate:1", selected_evidence_keys: ["d_icd_diagnoses:10:A1"], ranked_candidate_ids: ["candidate:1"], reason_codes: ["DIRECT_LABEL_MATCH"], explanation: "The supplied label directly matches." };
  const reviewer = new OpenAiCompatibleMappingCandidateReviewer({
    base_url: "https://provider.test/v1", api_key: "secret", model: "review-model", system_prompt: "review", timeout_ms: 1_000, max_output_tokens: 1_000,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ data: resultBody }) } }] }), { status: 200 }),
  });

  assert.equal((await reviewer.review(input)).decision, "approved");
});

test("removes repeated reason codes and evidence keys instead of failing the review", async () => {
  const resultBody = { schema_version: "1.0.0", requested_term: "target concept", decision: "approved", selected_candidate_id: "candidate:1", selected_evidence_keys: ["d_icd_diagnoses:10:A1", "d_icd_diagnoses:10:A1"], ranked_candidate_ids: ["candidate:1"], reason_codes: ["DIRECT_LABEL_MATCH", "DIRECT_LABEL_MATCH"], explanation: "The supplied label directly matches." };
  const reviewer = new OpenAiCompatibleMappingCandidateReviewer({
    base_url: "https://provider.test/v1", api_key: "secret", model: "review-model", system_prompt: "review", timeout_ms: 1_000, max_output_tokens: 1_000,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(resultBody) } }] }), { status: 200 }),
  });
  const result = await reviewer.review(input);
  assert.deepEqual(result.reason_codes, ["DIRECT_LABEL_MATCH"]);
  assert.deepEqual(result.selected_evidence_keys, ["d_icd_diagnoses:10:A1"]);
});
