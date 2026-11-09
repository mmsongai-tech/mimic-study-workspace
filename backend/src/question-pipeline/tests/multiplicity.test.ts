import assert from "node:assert/strict";
import test from "node:test";
import { adjustForMultiplicity } from "../multiplicity.js";
import { familyPValue, planHeadline } from "../headline.js";
import type { PlanOutcome } from "../plan-execution.js";

const plan = (plan_id: string, p: number | null, status = "completed") => ({ plan_id, status, result: { estimates: [{ measure: "odds_ratio", p_value: p }] } }) as unknown as PlanOutcome;

test("Holm adjusts the headline P values step-down and keeps them monotone", () => {
  const result = adjustForMultiplicity([plan("a", 0.01), plan("b", 0.04), plan("c", 0.03)])!;
  assert.equal(result.analyses, 3);
  const by = Object.fromEntries(result.adjusted.map((row) => [row.plan_id, row.p_adjusted]));
  assert.ok(Math.abs(by.a! - 0.03) < 1e-12);
  assert.ok(Math.abs(by.c! - 0.06) < 1e-12);
  assert.ok(Math.abs(by.b! - 0.06) < 1e-12);
});

test("a single analysis or blocked plans are not adjusted", () => {
  assert.equal(adjustForMultiplicity([plan("a", 0.01)]), undefined);
  assert.equal(adjustForMultiplicity([plan("a", 0.01), plan("b", 0.02, "blocked"), plan("c", null)]), undefined);
});

test("two plans reporting the same estimate count as one analysis", () => {
  const result = adjustForMultiplicity([plan("a", 0.01), plan("a2", 0.01), plan("b", 0.04)])!;
  assert.equal(result.analyses, 2);
  assert.equal(result.adjusted.length, 3);
  assert.equal(result.adjusted.find(({ plan_id }) => plan_id === "a2")!.p_adjusted, result.adjusted.find(({ plan_id }) => plan_id === "a")!.p_adjusted);
});

const failedCheck = (check_id: string) => ({ checks: [{ check_id, status: "fail" }] });

test("a result that is not reliably estimable is left out of the family and never counts as significant", () => {
  const degenerate = { ...plan("bad", 1e-9), quality: failedCheck("effect_size_plausible") } as unknown as PlanOutcome;
  const result = adjustForMultiplicity([degenerate, plan("a", 0.2), plan("b", 0.5)])!;
  assert.equal(result.analyses, 2);
  assert.equal(result.adjusted.some(({ plan_id }) => plan_id === "bad"), false);
  assert.equal(result.significant_before, 0);
  assert.equal(result.significant_after, 0);
});

test("a prediction model is judged by its AUC and stays out of the family", () => {
  const prediction = { plan_id: "p", status: "completed", chosen_method: "prediction.logistic", result: { estimates: [{ term: "predictor_0", measure: "odds_ratio", p_value: 1e-6 }, { term: "auc", measure: "auc", estimate: 0.63, p_value: null }] } } as unknown as PlanOutcome;
  const result = adjustForMultiplicity([prediction, plan("a", 0.01), plan("b", 0.02)])!;
  assert.equal(result.analyses, 2);
  assert.equal(result.adjusted.some(({ plan_id }) => plan_id === "p"), false);
});

test("an effect-modification analysis enters the family with its interaction test, not a subgroup estimate", () => {
  const modification = { plan_id: "m", status: "completed", result: { estimates: [{ term: "exposure", measure: "odds_ratio", estimate: 0.8, p_value: 1e-8 }], diagnostics: { p_interaction: 0.4 } } } as unknown as PlanOutcome;
  const result = adjustForMultiplicity([modification, plan("a", 0.01)])!;
  assert.equal(result.adjusted.find(({ plan_id }) => plan_id === "m")!.p_value, 0.4);
  assert.equal(result.significant_before, 1);
});

test("significant counts are over distinct analyses, like the analysis count", () => {
  const result = adjustForMultiplicity([plan("a", 0.001), plan("a2", 0.001), plan("b", 0.04), plan("c", 0.5)])!;
  assert.equal(result.analyses, 3);
  assert.equal(result.adjusted.length, 4);
  assert.equal(result.significant_before, 2);
  assert.equal(result.significant_after, 1);
});

test("a description adds no P value to the family, even its exploratory between-group tests", () => {
  // The test row comes first: without the description rule, the first row (a between-group test with its P) would be the headline.
  const described = { plan_id: "d", status: "completed", chosen_method: "descriptive.stratified", result: { estimates: [
    { term: "test:characteristic_0", label: "Age: difference between groups (Wilcoxon)", measure: "test_statistic", estimate: 10, ci_low: null, ci_high: null, p_value: 0.001 },
    { term: "characteristic_0", label: "Age (overall)", measure: "mean", estimate: 70, ci_low: 69, ci_high: 71, p_value: null },
  ] } } as unknown as PlanOutcome;
  const result = adjustForMultiplicity([described, plan("a", 0.01), plan("b", 0.04)])!;
  assert.equal(result.analyses, 2);
  assert.equal(result.adjusted.some(({ plan_id }) => plan_id === "d"), false);
  // Only tests (no proportion or mean): still nothing enters the family.
  const testsOnly = { ...described, result: { estimates: [described.result!.estimates[0]!] } } as unknown as PlanOutcome;
  assert.equal(familyPValue(testsOnly), undefined);
});

test("a description by group only answers with the groups' shares and every characteristic in each group", () => {
  const rates = { plan_id: "r", status: "completed", chosen_method: "descriptive.rates", result: { estimates: [
    { term: "group:F", label: "Sex: F (overall)", measure: "proportion", estimate: 0.47, ci_low: 0.46, ci_high: 0.48, p_value: null },
    { term: "group:M", label: "Sex: M (overall)", measure: "proportion", estimate: 0.53, ci_low: 0.52, ci_high: 0.54, p_value: null },
    { term: "characteristic_0:F", label: "Age in Sex = F", measure: "mean", estimate: 73.8, ci_low: 73.6, ci_high: 74, p_value: null },
    { term: "characteristic_0:M", label: "Age in Sex = M", measure: "mean", estimate: 70.2, ci_low: 70, ci_high: 70.4, p_value: null },
  ] } } as unknown as PlanOutcome;
  const headline = planHeadline(rates);
  assert.equal(headline.kind, "description");
  assert.deepEqual(headline.kind === "description" ? headline.estimates.map(({ term }) => term) : [], ["group:F", "group:M", "characteristic_0:F", "characteristic_0:M"]);
  // With overall rows (summary or stratified), the characteristics are answered overall, after the shares.
  const summary = { ...rates, chosen_method: "descriptive.summary", result: { estimates: [...rates.result!.estimates, { term: "characteristic_0", label: "Age (overall)", measure: "mean", estimate: 71.9, ci_low: 71.7, ci_high: 72, p_value: null }] } } as unknown as PlanOutcome;
  const overall = planHeadline(summary);
  assert.deepEqual(overall.kind === "description" ? overall.estimates.map(({ term }) => term) : [], ["group:F", "group:M", "characteristic_0"]);
});
