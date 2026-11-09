import assert from "node:assert/strict";
import test from "node:test";
import { assessMethodReadiness, selectStatisticalMethod } from "../index.js";

const profile = (row_count: number, distinct_count: number, missing_count = 0) => ({ schema_version: "1.0.0" as const, row_count, missing_count, non_missing_count: row_count - missing_count, distinct_count, top_values: [] });

test("marks a method ready when aggregate prerequisites are present", () => {
  const result = assessMethodReadiness({ method: selectStatisticalMethod({ intent_family: "association", outcome_structure: "binary" } as never), profiles: { population: profile(100, 100), outcome: profile(100, 2) } });
  assert.equal(result.status, "ready");
  assert.equal(result.sample_size, 100);
});

test("blocks a binary analysis when the outcome has no variation", () => {
  const result = assessMethodReadiness({ method: selectStatisticalMethod({ intent_family: "association", outcome_structure: "binary" } as never), profiles: { population: profile(100, 100), outcome: profile(100, 1) } });
  assert.equal(result.status, "blocked");
  assert.match(result.blocking_reasons.join(" "), /event_information/u);
});

test("surfaces missingness as a reviewable warning", () => {
  const result = assessMethodReadiness({ method: selectStatisticalMethod({ intent_family: "association", outcome_structure: "binary" } as never), profiles: { population: profile(100, 100), outcome: profile(100, 2, 4) } });
  assert.equal(result.status, "needs_confirmation");
  assert.ok(result.warnings.some((warning) => warning.includes("missingness")));
});
