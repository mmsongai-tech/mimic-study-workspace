import assert from "node:assert/strict";
import test from "node:test";
import { executeKaplanMeierSummary } from "../index.js";

test("summarizes generic time-to-event records", () => {
  const result = executeKaplanMeierSummary([{ duration: 2, event: true, group: "exposed" }, { duration: 5, event: false, group: "exposed" }, { duration: 3, event: true, group: "unexposed" }, { duration: 6, event: false, group: "unexposed" }]);
  assert.equal(result.status, "completed"); assert.equal(result.groups.exposed.events, 1); assert.equal(result.groups.unexposed.censored, 1); assert.equal(result.diagnostics.proportional_hazards, "not_evaluated");
});

test("fails closed when one survival group is absent", () => {
  assert.throws(() => executeKaplanMeierSummary([{ duration: 1, event: true, group: "exposed" }]), /Both survival groups/u);
});
