import assert from "node:assert/strict";
import test from "node:test";
import { buildMethodOptions, selectStatisticalMethod } from "../index.js";

test("exposes a primary method and guarded alternatives", () => {
  const method = selectStatisticalMethod({ intent_family: "association", outcome_structure: "binary" } as never);
  const options = buildMethodOptions({ method, primary_available: true });
  assert.equal(options[0]?.primary, true); assert.equal(options[0]?.available, true);
  assert.ok(options.slice(1).every((option) => option.available === false && option.unavailable_reason));
});
