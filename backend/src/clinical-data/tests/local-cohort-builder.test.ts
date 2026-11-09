import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalBinaryCohort, executeLocalBinaryAssociation } from "../index.js";

const manifest = { exposure: "diabetes", outcome: "death", exposure_values: [true, 1, "1"], event_values: [true, 1, "1"] } as const;
const rows = [
  { diabetes: true, death: true }, { diabetes: true, death: false },
  { diabetes: false, death: true }, { diabetes: false, death: false },
  { diabetes: null, death: true }, { diabetes: true, death: null },
];

test("builds aggregate counts and excludes invalid rows without returning source rows", () => {
  const result = buildLocalBinaryCohort(rows, manifest);
  assert.deepEqual(result.counts, { exposed_events: 1, exposed_non_events: 1, unexposed_events: 1, unexposed_non_events: 1 });
  assert.equal(result.rows_seen, 6);
  assert.equal(result.rows_excluded, 2);
  assert.equal("rows" in result, false);
});

test("is deterministic and exposes aggregate integrity only", () => {
  const first = executeLocalBinaryAssociation(rows, manifest);
  const second = executeLocalBinaryAssociation(rows, manifest);
  assert.equal(first.cohort.input_integrity_id, second.cohort.input_integrity_id);
  assert.equal(first.input_integrity_id, second.input_integrity_id);
  assert.equal(first.estimates.risk_ratio, 1);
  assert.equal("rows" in first, false);
});

test("rejects a manifest without both fields", () => {
  assert.throws(() => buildLocalBinaryCohort(rows, { ...manifest, outcome: " " }), /fields are required/u);
});
