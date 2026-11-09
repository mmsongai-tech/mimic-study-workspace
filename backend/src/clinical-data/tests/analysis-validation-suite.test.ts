import assert from "node:assert/strict";
import test from "node:test";
import { createReproducibleAnalysisReport, runAnalysisValidationSuite, validateAggregateBinaryProfile } from "../index.js";

const rows = [{ id: 1, exposure: true, outcome: true }, { id: 2, exposure: true, outcome: false }, { id: 3, exposure: false, outcome: true }, { id: 4, exposure: false, outcome: false }];
const manifest = { subject_id: "id", exposure: "exposure", outcome: "outcome" };

test("runs baseline and sensitivity scenarios and verifies repeatability", async () => {
  const suite = await runAnalysisValidationSuite({ family: "binary_association", baseline: { id: "baseline", label: "prespecified", manifest }, sensitivity: [{ id: "threshold-alt", label: "alternative", manifest }], source: () => rows });
  assert.equal(suite.scenarios.every((scenario) => scenario.status === "passed"), true); assert.equal(suite.stability.repeated_baseline_equal, true);
});

test("records blocked scenarios instead of substituting a method", async () => {
  const suite = await runAnalysisValidationSuite({ family: "time_to_event_association", baseline: { id: "baseline", label: "cox", manifest }, sensitivity: [], source: () => rows });
  assert.equal(suite.scenarios[0]!.status, "blocked"); assert.match(suite.scenarios[0]!.blocking_reason!, /Cox executor/u);
});

test("creates a stable report integrity identifier from all inputs", () => {
  const validation = { schema_version: "1.0.0" as const, family: "binary_association" as const, scenarios: [], stability: { repeated_baseline_equal: true } };
  const first = createReproducibleAnalysisReport({ study: { id: 1 }, manifest: { id: 2 }, method: { id: 3 }, data_provenance: { hash: "x" }, validation });
  const second = createReproducibleAnalysisReport({ study: { id: 1 }, manifest: { id: 2 }, method: { id: 3 }, data_provenance: { hash: "x" }, validation });
  assert.equal(first.report_integrity_id, second.report_integrity_id); assert.match(String(first.report_integrity_id), /^sha256:/u);
});

test("validates a full-data binary aggregate and proves deterministic statistics", () => {
  const validation = validateAggregateBinaryProfile({ label: "reviewed exposure", counts: { exposed_events: 10, exposed_non_events: 90, unexposed_events: 5, unexposed_non_events: 95 } });
  assert.equal(validation.scenarios[0]?.run?.quality.rows_seen, 200);
  assert.equal(validation.stability.repeated_baseline_equal, true);
  assert.equal(validation.scenarios[0]?.status, "passed");
});
