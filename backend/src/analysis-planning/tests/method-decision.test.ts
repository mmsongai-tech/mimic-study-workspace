import assert from "node:assert/strict";
import test from "node:test";
import { decideStatisticalMethods } from "../index.js";

const study = { schema_version: "1.0.0" as const, intent_family: "association" as const, outcome_structure: "binary" as const };

test("returns a ready primary option only with data evidence and a registered executor", () => {
  const result = decideStatisticalMethods(study, { complete_rows: 100, outcome_events: 20, outcome_non_events: 80 }, ["association.binary.v1.primary"]);
  assert.equal(result.blocking_reasons.length, 0); assert.equal(result.options[0]!.available, true);
});

test("explains missing outcome variation and keeps methods unavailable", () => {
  const result = decideStatisticalMethods(study, { complete_rows: 100, outcome_events: 0, outcome_non_events: 100 }, ["association.binary.v1.primary"]);
  assert.match(result.blocking_reasons[0]!, /event and non-event/u); assert.equal(result.options[0]!.available, false);
});
