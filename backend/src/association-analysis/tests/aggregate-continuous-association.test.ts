import assert from "node:assert/strict";
import test from "node:test";
import { executeAggregateContinuousAssociation } from "../index.js";

test("executes a generic aggregate continuous comparison", () => {
  const result = executeAggregateContinuousAssociation({ exposed: { n: 4, sum: 20, sum_of_squares: 110 }, unexposed: { n: 4, sum: 12, sum_of_squares: 40 } });
  assert.equal(result.status, "completed");
  assert.equal(result.estimates.mean_difference, 2);
  assert.equal(result.estimates.exposed_sd, 1.8257418583505538);
  assert.equal(result.model.input, "aggregate_group_moments");
});

test("rejects inconsistent aggregate moments", () => {
  assert.throws(() => executeAggregateContinuousAssociation({ exposed: { n: 2, sum: 10, sum_of_squares: 1 }, unexposed: { n: 2, sum: 4, sum_of_squares: 8 } }), /Inconsistent/u);
});
