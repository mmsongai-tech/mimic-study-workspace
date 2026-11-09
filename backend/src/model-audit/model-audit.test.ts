import assert from "node:assert/strict";
import test from "node:test";
import { ModelAuditQueryService, toSafeModelAuditRecord } from "./model-audit.js";

test("projects only approved model audit metadata", () => {
  const record = toSafeModelAuditRecord({
    stage: "extract",
    provider: "router",
    model: "model-a",
    prompt_id: "p",
    prompt_version: "1",
    prompt_integrity_id: "sha256:p",
    schema_id: "s",
    schema_version: "1",
    schema_integrity_id: "sha256:s",
    json_parse: "pass",
    schema_validation: "pass",
    business_validation: "pass",
    structured_output_mode: "json_schema",
    repair_attempts: 1,
    latency_ms: 12,
    question: "private",
    prompt_text: "secret",
    output: { patient_id: "P-1" },
    api_key: "key",
    attempts: [{ provider: "router", model: "model-a", order: 1, latency_ms: 10, outcome: "succeeded", failure_class: "MODEL_AUTHENTICATION_FAILED" }],
  });

  assert.equal(record.model, "model-a");
  assert.equal(record.structured_output_mode, "json_schema");
  assert.equal(record.attempts?.[0]?.provider, "router");
  assert.doesNotMatch(JSON.stringify(record), /private|secret|patient_id|P-1|key/u);
});

test("bounds audit reads and normalizes invalid states", async () => {
  let limit = 0;
  const service = new ModelAuditQueryService({
    list(value) {
      limit = value;
      return [{ json_parse: "bad", repair_attempts: -1 }];
    },
  });
  const result = await service.list(900);
  assert.equal(limit, 100);
  assert.equal(result.records[0]?.json_parse, "not_run");
  assert.equal(result.records[0]?.repair_attempts, 0);
});
