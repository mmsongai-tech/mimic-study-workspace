import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkReport, scoreCase, summarize, type BenchmarkCase, type RunSummary } from "../index.js";

const item = (measure: string, value: number, low: number, high: number, n = 1000): BenchmarkCase => ({ id: "lit-x", study_type: "treatment_effect", question_zh: "q", citation: { title: "Paper", year: 2025 }, results: { cohort_n: n, primary_estimate: { measure, value, ci_low: low, ci_high: high } } });
const run = (measure: string, estimate: number, low: number, high: number, rows = 900): RunSummary => ({ status: "completed", plans: [{ plan_id: "f1", status: "completed", cohort: { rows }, quality: { status: "warn" }, result: { status: "completed", estimates: [{ label: "x", measure, estimate, ci_low: low, ci_high: high }] } }] });

test("grades agreement by direction and interval overlap on the published measure", () => {
  assert.equal(scoreCase(item("OR", 0.75, 0.63, 0.89), run("odds_ratio", 0.8, 0.7, 0.92)).grade, "agrees");
  assert.equal(scoreCase(item("OR", 0.75, 0.63, 0.89), run("odds_ratio", 0.5, 0.4, 0.6)).grade, "same_direction");
  assert.equal(scoreCase(item("HR", 1.41, 1.3, 1.52), run("hazard_ratio", 0.9, 0.8, 0.99)).grade, "differs");
  assert.equal(scoreCase(item("HR", 1.41, 1.3, 1.52), run("odds_ratio", 1.5, 1.2, 1.8)).grade, "not_comparable");
  assert.equal(scoreCase(item("RD", -4.03, -6.9, -1.0), run("risk_difference", -0.03, -0.05, -0.01)).grade, "agrees", "percentage-point RDs are rescaled");
  assert.equal(scoreCase(item("AUC", 0.858, 0.799, 0.916), run("auc", 0.83, 0.8, 0.86)).grade, "agrees");
  const score = scoreCase(item("OR", 0.75, 0.63, 0.89, 1000), run("odds_ratio", 0.8, 0.7, 0.92, 900));
  assert.equal(score.cohort_ratio, 0.9);
});

test("records why a case did not run and summarizes the grades", () => {
  const blocked: RunSummary = { status: "completed", plans: [{ plan_id: "f1", status: "blocked", blockers: [{ code: "VARIABLE_UNMAPPED", message: { en: "exposure “X”: not found." } }] }] };
  const failed = scoreCase(item("OR", 1, 0.9, 1.1), blocked);
  assert.equal(failed.grade, "did_not_run");
  assert.match(failed.first_blocker!, /VARIABLE_UNMAPPED/u);
  const scores = [failed, scoreCase(item("OR", 0.75, 0.63, 0.89), run("odds_ratio", 0.8, 0.7, 0.92))];
  assert.deepEqual(summarize(scores), { total: 2, ran: 1, cohort_within_2x: 1, agrees: 1, same_direction: 0, differs: 0, not_comparable: 0, did_not_run: 1 });
  assert.match(benchmarkReport(scores, "zh", "2026-09-27"), /运行成功 1\/2/u);
  assert.match(benchmarkReport(scores, "en", "2026-09-27"), /lit-x: VARIABLE_UNMAPPED/u);
});
