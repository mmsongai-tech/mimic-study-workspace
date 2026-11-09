import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteModelAuditRepository } from "./sqlite-model-audit-repository.js";
test("persists only safe audit metadata across repository instances", () => {
  const path = join(mkdtempSync(join(tmpdir(), "model-audit-")), "audit.sqlite");
  const writer = new SqliteModelAuditRepository(path);
  writer.append([{ stage: "objective_extraction", provider: "router", model: "model-a", prompt: { id: "p", version: "1", sha256: "sha256:p" }, output_schema: { id: "s", version: "1", sha256: "sha256:s" }, json_parse: "pass", schema_validation: "pass", business_validation: "pass", repair_attempts: 0, latency_ms: 20, question: "private", output: { patient_id: "P-1" } }]);
  writer.close();
  const reader = new SqliteModelAuditRepository(path); const records = reader.list(10); reader.close();
  assert.equal(records[0]?.prompt.integrity_id, "sha256:p");
  assert.equal(records[0]?.schema.id, "s");
  assert.doesNotMatch(JSON.stringify(records), /private|patient_id|P-1/u);
});
