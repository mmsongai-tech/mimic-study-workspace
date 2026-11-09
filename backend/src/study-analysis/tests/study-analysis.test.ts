import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessMethodReadiness, methodOptions, RStudyMethodExecutor, type AnalysisDatasetProfile, type AnalysisOutcomeType } from "../index.js";
import type { StudyType } from "../../study-framing/index.js";

const STUDY_TYPES: StudyType[] = ["descriptive", "group_comparison", "association", "treatment_effect", "time_to_event", "longitudinal_change", "dose_response", "effect_modification", "mediation", "prediction"];
const OUTCOMES: AnalysisOutcomeType[] = ["binary", "continuous", "time_to_event"];

test("offers exactly three registered options for every study type and outcome type", async () => {
  const script = await readFile(new URL("../runtimes/r/study_methods.R", import.meta.url), "utf8");
  const implemented = new Set([...script.matchAll(/^\s+"([a-z_]+\.[a-z_]+)" = function/gmu)].map((match) => match[1]));
  for (const type of STUDY_TYPES) for (const outcome of OUTCOMES) {
    const options = methodOptions(type, outcome);
    assert.equal(options.length, 3, `${type}/${outcome}`);
    for (const option of options) {
      assert.ok(implemented.has(option.method_id), `${option.method_id} is not implemented in R`);
      assert.ok(option.label.zh && option.label.en && option.when_preferred.zh);
    }
  }
});

test("marks options unavailable with bilingual reasons when the data cannot support them", () => {
  const profile: AnalysisDatasetProfile = { rows: 80, outcome_type: "binary", events: 12, exposure_kind: "binary", exposure_group_sizes: [70, 10], covariates: 2, has_mediator: false, predictors: 0, has_time_to_event: false };
  const [iptw, psm, logistic] = methodOptions("treatment_effect", "binary").map((option) => assessMethodReadiness(option, profile));
  assert.equal(iptw!.available, false);
  assert.ok(iptw!.reasons.some(({ zh }) => /完整数据/u.test(zh)));
  assert.equal(psm!.available, false);
  assert.equal(logistic!.available, false);
  assert.ok(logistic!.reasons.some(({ en }) => /events/u.test(en)));
  const ready = assessMethodReadiness(methodOptions("association", "binary")[2]!, profile);
  assert.equal(ready.available, true);
});

// Deterministic simulated cohort with known effects; no real patient data.
const simulate = (n: number): Array<Record<string, unknown>> => {
  let seed = 42;
  const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const normal = (): number => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
  return Array.from({ length: n }, (_, index) => {
    const age = 65 + 12 * normal(); const male = random() < 0.5;
    const exposed = random() < 1 / (1 + Math.exp(-(-0.5 + 0.03 * (age - 65))));
    const mediator = 1 + 0.8 * Number(exposed) + normal();
    const died = random() < 1 / (1 + Math.exp(-(-1.5 - 0.6 * Number(exposed) + 0.04 * (age - 65) + 0.3 * mediator)));
    const hazard = 0.01 * Math.exp(-0.4 * Number(exposed) + 0.03 * (age - 65)); const eventTime = -Math.log(random() + 1e-12) / hazard; const censor = 30 + 300 * random();
    return { analysis_id: String(index), exposure: exposed, outcome: died, time: Math.min(eventTime, censor), event: eventTime <= censor ? 1 : 0, covariate_0: Math.round(age), covariate_1: male ? "M" : "F", mediator_0: mediator, predictor_0: Math.round(age), predictor_1: mediator };
  });
};

test("runs registered methods end to end in R and removes the patient-level input", { timeout: 300_000 }, async () => {
  const rows = simulate(800);
  const executor = new RStudyMethodExecutor({ timeout_ms: 120_000 });
  const base = await mkdtemp(join(tmpdir(), "study-analysis-test-"));
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("mimic-study-method-")));
  try {
    const cases: Array<[string, "binary" | "time_to_event", string]> = [
      ["regression.adjusted", "binary", "odds_ratio"], ["treatment.iptw", "binary", "odds_ratio"], ["survival.cox", "time_to_event", "hazard_ratio"],
      ["modification.interaction", "binary", "odds_ratio"], ["mediation.product", "binary", "indirect_effect_product"], ["prediction.logistic", "binary", "odds_ratio"],
    ];
    for (const [method_id, outcome_type, measure] of cases) {
      const result = await executor.run(rows, { method_id, outcome_type, covariates: ["covariate_0", "covariate_1"], modifier: "covariate_1", mediator: "mediator_0", predictors: ["predictor_0", "predictor_1"], labels: { exposure: "Simulated drug" } }, join(base, method_id));
      assert.equal(result.status, "completed", `${method_id}: ${result.error ?? ""}`);
      assert.equal(result.n_analysed, 800);
      const estimate = result.estimates.find((row) => row.measure === measure);
      assert.ok(estimate && Number.isFinite(estimate.estimate) && Number(estimate.ci_low) <= Number(estimate.estimate) && Number(estimate.estimate) <= Number(estimate.ci_high), `${method_id} estimate`);
      assert.ok(Array.isArray(result.tables.table1) && result.tables.table1.length > 1, `${method_id} table 1`);
    }
    const cox = await executor.run(rows, { method_id: "survival.cox", outcome_type: "time_to_event", covariates: ["covariate_0"] }, join(base, "cox-check"));
    const hazard = cox.estimates.find(({ measure }) => measure === "hazard_ratio")!;
    assert.ok(Number(hazard.estimate) < 1, "the simulated protective effect is recovered");
    assert.ok(cox.figures.some(({ kind }) => kind === "kaplan_meier"));
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith("mimic-study-method-") && !before.has(name));
    assert.deepEqual(after, [], "temporary patient-level CSV directories are removed");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reports a failed method with its reason instead of throwing", { timeout: 120_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "study-analysis-fail-"));
  try {
    const result = await new RStudyMethodExecutor().run(simulate(100), { method_id: "regression.rcs", outcome_type: "binary", covariates: [] }, base);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /continuous exposure/u);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("IPTW balances a rare exposure (weights are truncated within each treatment group)", { timeout: 120_000 }, async () => {
  let seed = 11; const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const rows = Array.from({ length: 6000 }, (_, index) => {
    const age = 40 + 50 * random();
    const exposed = random() < 1 / (1 + Math.exp(-(-6 + 0.06 * age)));
    return { analysis_id: String(index), exposure: exposed, outcome: random() < 0.05 + 0.002 * (age - 40), covariate_0: age };
  });
  const base = await mkdtemp(join(tmpdir(), "study-analysis-rare-"));
  try {
    const result = await new RStudyMethodExecutor().run(rows, { method_id: "treatment.iptw", outcome_type: "binary", covariates: ["covariate_0"] }, base);
    assert.equal(result.status, "completed", result.error);
    const balance = result.tables.balance![0]!;
    assert.ok(Number(balance.smd_before) > 0.3, "the simulated exposure is imbalanced on age");
    assert.ok(Number(balance.smd_after) < 0.1, `weighting balances age (after ${balance.smd_after})`);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("event minimums do not apply to continuous outcomes", () => {
  const profile: AnalysisDatasetProfile = { rows: 5000, outcome_type: "continuous", exposure_kind: "binary", exposure_group_sizes: [1500, 3500], covariates: 3, modifier_levels: [2400, 2600], has_mediator: false, predictors: 0, has_time_to_event: false };
  const [interaction] = methodOptions("effect_modification", "continuous").map((option) => assessMethodReadiness(option, profile));
  assert.equal(interaction!.available, true, JSON.stringify(interaction!.reasons));
});

test("the weighted interaction analysis weights the effect inside each level of the modifier, not only the interaction test", { timeout: 300_000 }, async () => {
  const rows = simulate(1200);
  const executor = new RStudyMethodExecutor({ timeout_ms: 120_000 });
  const base = await mkdtemp(join(tmpdir(), "study-analysis-weighted-"));
  try {
    const config = { outcome_type: "binary" as const, covariates: ["covariate_0", "covariate_1"], modifier: "covariate_1", labels: { exposure: "Simulated drug", covariate_1: "Sex" } };
    const plain = await executor.run(rows, { ...config, method_id: "modification.interaction" }, join(base, "plain"));
    const weighted = await executor.run(rows, { ...config, method_id: "modification.iptw_interaction" }, join(base, "weighted"));
    assert.equal(plain.status, "completed", plain.error ?? ""); assert.equal(weighted.status, "completed", weighted.error ?? "");
    assert.ok(plain.estimates.every(({ label }) => !String(label).includes("IPTW")));
    const strata = weighted.estimates.filter(({ label }) => String(label).includes("Sex = "));
    assert.equal(strata.length, 2);
    assert.ok(strata.every(({ label }) => String(label).includes("(IPTW)")), "each level's effect is an IPTW estimate");
    assert.notEqual(strata[0]!.estimate, plain.estimates.find(({ label }) => String(label).includes(String(strata[0]!.label).split(" in ")[1]!.split(" (")[0]!))?.estimate, "weighting changes the estimate");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("the weighted interaction test compares the level estimates it reports", { timeout: 120_000 }, async () => {
  // Like an alpha-blocker in hypertension: the drug is rare and strongly confounded in women, with the same true effect in both sexes.
  // On a real question, a likelihood-ratio test of a model weighted over the whole cohort gave a very small P value for level
  // estimates whose difference was smaller than its standard error.
  let seed = 11; const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const rows = Array.from({ length: 4000 }, (_, index) => {
    const female = random() < 0.45; const severity = random();
    const exposed = random() < (female ? 0.02 + 0.2 * severity ** 3 : 0.1 + 0.2 * severity);
    return { analysis_id: String(index), exposure: exposed, outcome: -2 * Number(exposed) + 6 * severity + 3 * (random() - 0.5) * 4, covariate_0: severity, covariate_1: female ? 1 : 0 };
  });
  const base = await mkdtemp(join(tmpdir(), "study-analysis-interaction-"));
  try {
    const result = await new RStudyMethodExecutor().run(rows, { method_id: "modification.iptw_interaction", outcome_type: "continuous", covariates: ["covariate_0", "covariate_1"], modifier: "covariate_1", labels: { covariate_1: "Sex" } }, base);
    assert.equal(result.status, "completed", result.error);
    const levels = result.estimates.filter(({ label }) => String(label).includes("Sex = ") && String(label).includes("(IPTW)"));
    assert.equal(levels.length, 2);
    const se = levels.map(({ ci_low, ci_high }) => (Number(ci_high) - Number(ci_low)) / (2 * 1.959964));
    const z = (Number(levels[0]!.estimate) - Number(levels[1]!.estimate)) / Math.sqrt(se[0]! ** 2 + se[1]! ** 2);
    const normal = (x: number): number => 0.5 * (1 + Math.sign(x) * Math.sqrt(1 - Math.exp(-2 * x * x / Math.PI))); // within 0.002, enough here
    const expected = 2 * (1 - normal(Math.abs(z)));
    const reported = Number(result.diagnostics.p_interaction);
    assert.ok(Math.abs(reported - expected) < 0.01, `interaction P ${reported} is the Wald test of the reported level estimates (${expected})`);
    const effective = Number(result.diagnostics.effective_sample_size);
    assert.ok(effective > 0 && effective <= rows.length, `effective sample of the level weights (${effective})`);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("an E-value accompanies each ratio estimate and follows the published formula", { timeout: 120_000 }, async () => {
  let seed = 5; const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const rows = Array.from({ length: 5000 }, (_, index) => {
    const age = 40 + 50 * random(); const exposed = random() < 0.4;
    return { analysis_id: String(index), exposure: exposed, outcome: random() < (exposed ? 0.08 : 0.04), covariate_0: age };
  });
  const base = await mkdtemp(join(tmpdir(), "study-analysis-evalue-"));
  try {
    const result = await new RStudyMethodExecutor().run(rows, { method_id: "treatment.iptw", outcome_type: "binary", covariates: ["covariate_0"] }, base);
    assert.equal(result.status, "completed", result.error);
    const main = result.estimates.find(({ label }) => !label.includes("sensitivity"))!;
    const entry = result.tables.sensitivity!.find((row) => row.estimate === main.label)!;
    const rr = Math.max(main.estimate!, 1 / main.estimate!);
    assert.equal(Number(entry.e_value), Number((rr + Math.sqrt(rr * (rr - 1))).toFixed(2)));
    assert.ok(Number(entry.e_value_ci) >= 1 && Number(entry.e_value_ci) <= Number(entry.e_value));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a prediction is compared with a model of the background characteristics alone and cross-validated", { timeout: 120_000 }, async () => {
  let seed = 9; const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const rows = Array.from({ length: 3000 }, (_, index) => {
    const age = 40 + 50 * random(); const lactate = 4 * random();
    const risk = 1 / (1 + Math.exp(-(-4 + 0.02 * (age - 60) + 1.1 * lactate)));
    return { analysis_id: String(index), outcome: random() < risk, predictor_0: lactate, covariate_0: age };
  });
  const base = await mkdtemp(join(tmpdir(), "study-analysis-prediction-"));
  try {
    const result = await new RStudyMethodExecutor().run(rows, { method_id: "prediction.logistic", outcome_type: "binary", covariates: ["covariate_0"], predictors: ["predictor_0"] }, base);
    assert.equal(result.status, "completed", result.error);
    const auc = (term: string) => result.estimates.find((estimate) => estimate.term === term)!.estimate!;
    const model = result.estimates.find(({ term }) => term === "auc")!.estimate!;
    assert.ok(auc("auc_baseline") < model, "lactate adds discrimination over age alone");
    assert.ok(auc("auc_cv") > 0.6 && auc("auc_cv") < 1);
    assert.ok(Number(result.diagnostics.auc_gain_over_baseline) > 0 && Number(result.diagnostics.auc_gain_p) < 0.05);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a prediction fitted on complete cases is compared with one that imputes missing predictors", { timeout: 180_000 }, async () => {
  let seed = 21; const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const rows = Array.from({ length: 2500 }, (_, index) => {
    const age = 40 + 50 * random(); const lactate = 4 * random();
    const risk = 1 / (1 + Math.exp(-(-4 + 0.02 * (age - 60) + 1.1 * lactate)));
    return { analysis_id: String(index), outcome: random() < risk, predictor_0: random() < 0.4 ? null : lactate, covariate_0: age };
  });
  const base = await mkdtemp(join(tmpdir(), "study-analysis-imputed-"));
  try {
    const result = await new RStudyMethodExecutor().run(rows, { method_id: "prediction.logistic", outcome_type: "binary", covariates: ["covariate_0"], predictors: ["predictor_0"] }, base);
    assert.equal(result.status, "completed", result.error);
    const imputed = result.estimates.find(({ term }) => term === "auc_imputed");
    assert.ok(imputed, `the imputed comparison is reported (${result.warnings.join("; ")})`);
    assert.ok(imputed!.estimate! > 0.5 && imputed!.estimate! < 1);
    assert.ok(Number(result.diagnostics.imputed_incomplete_rows) > 800);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a group with no events gets a finite Firth estimate beside the diverging usual one", { timeout: 120_000 }, async () => {
  let seed = 3; const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const rows = Array.from({ length: 3000 }, (_, index) => {
    const age = 40 + 50 * random(); const exposed = index < 40;
    return { analysis_id: String(index), exposure: exposed, outcome: !exposed && random() < 0.1, covariate_0: age };
  });
  const base = await mkdtemp(join(tmpdir(), "study-analysis-firth-"));
  try {
    const result = await new RStudyMethodExecutor().run(rows, { method_id: "regression.adjusted", outcome_type: "binary", covariates: ["covariate_0"] }, base);
    assert.equal(result.status, "completed", result.error);
    const firth = result.estimates.find(({ term }) => term === "exposure_firth");
    assert.ok(firth, "a Firth estimate is added when a group has no events");
    assert.ok(firth!.estimate! > 0 && firth!.estimate! < 1, "no events among the exposed means a protective but finite odds ratio");
    assert.ok(Number.isFinite(firth!.ci_low!) && Number.isFinite(firth!.ci_high!) && firth!.ci_high! < 100);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a continuous exposure is also reported per one standard deviation", { timeout: 120_000 }, async () => {
  let seed = 17; const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const rows = Array.from({ length: 2000 }, (_, index) => {
    const lipid = 100 + 40 * random(); const age = 40 + 50 * random();
    return { analysis_id: String(index), exposure: lipid, outcome: random() < 1 / (1 + Math.exp(-(-3 + 0.02 * (lipid - 120)))), covariate_0: age };
  });
  const base = await mkdtemp(join(tmpdir(), "study-analysis-sd-"));
  try {
    const result = await new RStudyMethodExecutor().run(rows, { method_id: "regression.adjusted", outcome_type: "binary", covariates: ["covariate_0"] }, base);
    assert.equal(result.status, "completed", result.error);
    const perUnit = result.estimates.find(({ label }) => label.endsWith("(adjusted)"))!.estimate!;
    const perSd = result.estimates.find(({ term }) => term === "exposure_per_sd")!;
    const spread = Math.sqrt(rows.reduce((sum, row) => sum + (row.exposure - rows.reduce((a, r) => a + r.exposure, 0) / rows.length) ** 2, 0) / (rows.length - 1));
    assert.ok(Math.abs(perSd.estimate! - Math.exp(Math.log(perUnit) * spread)) < 1e-3);
    assert.match(perSd.label, /per 1 SD/u);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a yes/no outcome that happens to nobody leaves no method available, with the reason", () => {
  const profile: AnalysisDatasetProfile = { rows: 4000, outcome_type: "binary", events: 0, exposure_kind: "continuous", covariates: 3, has_mediator: false, predictors: 0, has_time_to_event: false };
  const options = methodOptions("association", "binary").map((option) => assessMethodReadiness(option, profile));
  assert.ok(options.length > 0 && options.every(({ available }) => !available));
  assert.ok(options.every(({ reasons }) => reasons.some(({ en }) => /does not vary/u.test(en))));
});

test("a dose that takes only a few distinct values falls back to the linear term instead of failing on the spline knots", { timeout: 120_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "study-analysis-fewdose-"));
  try {
    let seed = 5; const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const rows = Array.from({ length: 600 }, (_, index) => { const dose = random() < 0.8 ? 0 : random() < 0.7 ? 1 : 2; return { analysis_id: String(index), exposure: dose, outcome: random() < 0.2 + 0.05 * dose, covariate_0: 40 + 40 * random() }; });
    const result = await new RStudyMethodExecutor().run(rows, { method_id: "regression.rcs", outcome_type: "binary", covariates: ["covariate_0"] }, base);
    assert.equal(result.status, "completed", result.error ?? "");
    assert.ok(result.estimates.some(({ measure }) => measure === "odds_ratio"));
    assert.ok(result.warnings.some((warning) => /too few distinct values for a spline/u.test(warning)));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("describes each characteristic overall and by a yes/no grouping without dropping rows, and tests between groups only when asked", { timeout: 300_000 }, async () => {
  // Simulated rows: the grouping is a drug received or not, one characteristic is missing for a quarter of the rows, one is yes/no.
  const rows = simulate(400).map((row, index) => ({ analysis_id: row.analysis_id, exposure: row.exposure, characteristic_0: row.covariate_0, ...(index % 4 ? { characteristic_1: row.mediator_0 } : {}), characteristic_2: row.outcome, covariate_0: row.covariate_1 }));
  const executor = new RStudyMethodExecutor({ timeout_ms: 120_000 });
  const base = await mkdtemp(join(tmpdir(), "study-description-test-"));
  try {
    const config = (method_id: string) => ({ method_id, outcome_type: "binary" as const, covariates: ["covariate_0"], characteristics: ["characteristic_0", "characteristic_1", "characteristic_2"], labels: { exposure: "Simulated drug", characteristic_0: "Age", characteristic_1: "Marker", characteristic_2: "Death", covariate_0: "Sex" } });
    const summary = await executor.run(rows, config("descriptive.summary"), join(base, "summary"));
    assert.equal(summary.status, "completed", summary.error);
    assert.equal(summary.n_analysed, 400, "a description drops no row for a missing value");
    const labels = summary.estimates.map(({ label }) => label);
    for (const expected of ["Simulated drug: yes (overall)", "Age (overall)", "Age in Simulated drug = yes", "Marker in Simulated drug = no", "Death (overall)"]) assert.ok(labels.includes(expected), expected);
    const death = summary.estimates.find(({ label }) => label === "Death (overall)")!;
    assert.equal(death.measure, "proportion");
    assert.ok(Number(death.ci_low) < Number(death.estimate) && Number(death.estimate) < Number(death.ci_high));
    assert.ok(!summary.estimates.some(({ measure }) => measure === "test_statistic" || measure === "odds_ratio"), "no test and no effect estimate unless asked");
    const table1 = summary.tables.table1!;
    assert.deepEqual(Object.keys(table1[0]!), ["variable", "overall", "exposed", "unexposed", "missing"]);
    assert.equal(table1.find(({ variable }) => variable === "Marker")?.missing, "100");
    const stratified = await executor.run(rows, config("descriptive.stratified"), join(base, "stratified"));
    assert.equal(stratified.estimates.filter(({ measure }) => measure === "test_statistic").length, 3);
    const rates = await executor.run(rows, config("descriptive.rates"), join(base, "rates"));
    assert.ok(!rates.estimates.some(({ label }) => label === "Age (overall)") && rates.estimates.some(({ label }) => label === "Age in Simulated drug = yes"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
