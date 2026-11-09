import assert from "node:assert/strict";
import test from "node:test";
import { executeAggregateBinaryAssociation } from "../index.js";

test("executes a generic aggregate binary association", () => {
  const result = executeAggregateBinaryAssociation({ exposed_events: 10, exposed_non_events: 90, unexposed_events: 5, unexposed_non_events: 95 });
  assert.equal(result.status, "completed"); assert.equal(result.estimates.exposed_risk, 0.1); assert.equal(result.estimates.risk_ratio, 2); assert.match(result.input_integrity_id, /^sha256:/u); assert.equal("patient_rows" in result, false); assert.equal(result.model.input, "aggregate_2x2"); assert.match(result.model.formula, /OR/u);
});
test("fails closed for an empty exposure group", () => {
  assert.throws(() => executeAggregateBinaryAssociation({ exposed_events: 0, exposed_non_events: 0, unexposed_events: 1, unexposed_non_events: 1 }), /exposure groups/u);
});
