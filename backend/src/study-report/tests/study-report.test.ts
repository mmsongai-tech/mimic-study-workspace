import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFrames } from "../../study-framing/index.js";
import type { QuestionRunResult } from "../../question-pipeline/index.js";
import { buildReportDocument, renderMarkdown, renderText, writeQuestionReports } from "../index.js";

const question = "住院患者使用某药与不用某药的死亡差异";
const [frame] = buildFrames({ question, sub_question: question, first_id: 1, extraction: { goal: "evaluate_treatment", outcome_kind: "event", dose_question: false, population: "住院患者", exposure: "某药", exposure_categories: [], comparator: "不用某药", outcomes: ["死亡"], composite_outcome: "", modifiers: [], mediators: [], predictors: [], time_window: "" } });
const [vague] = buildFrames({ question, sub_question: "某药的疗效", first_id: 2, extraction: { goal: "evaluate_treatment", outcome_kind: "event", dose_question: false, population: "住院患者", exposure: "某药", exposure_categories: [], comparator: "", outcomes: ["疗效"], composite_outcome: "", modifiers: [], mediators: [], predictors: [], time_window: "" } });

const fixture = (outputDir: string): QuestionRunResult => ({
  schema_version: "1.0.0", run_id: "question-run:test", question, created_at: "2026-09-24T00:00:00.000Z",
  versions: { study_spec_compiler: "1.0.0", method_registry: "1.0.0", model: "test-model" }, data_source: { id: "simulated", version: "test" },
  frame_set: { schema_version: "1.0.0", original_question: question, frames: [frame!, vague!] },
  plans: [{
    plan_id: "f1", frame_id: "f1", status: "completed", stage_reached: "analysis", blockers: [],
    study_spec: { schema_version: "1.0.0", intent_family: "treatment_effect", population: { description: "住院患者" }, exposure_or_predictors: [{ name: "Drug", role: "exposure", operational_definition: "Any Drug within 24 h." }], outcome: { name: "Death", role: "outcome", operational_definition: "Any death." }, covariates: [{ name: "Age", role: "covariate", operational_definition: "Age." }], assumptions: ["Time zero is hospital admission."] },
    mapping: [{ role: "exposure", requested_term: "Drug", status: "resolved", selected: { mapping_id: "m1", label: "Drug labels", status: "model_reviewed", table: "mimiciv_hosp.prescriptions", identifiers: 3, values: ["Drug A", "Drug A XL", "drug a"] }, candidates: [] }],
    cohort: { rows: 600, analysis_units: 650, excluded_rows: 50, exclusion_reasons: { not_in_population: 40, incomplete_required_variables: 10 }, cohort_integrity_id: "sha256:cohort" },
    method_options: [{ method_id: "treatment.iptw", label: { en: "IPTW", zh: "逆概率加权" }, when_preferred: { en: "whole cohort", zh: "全队列" }, requirements: { min_rows: 100 }, readiness: { method_id: "treatment.iptw", available: true, reasons: [] } }],
    chosen_method: "treatment.iptw",
    result: { method_id: "treatment.iptw", method_library_version: "1.0.0", status: "completed", n_input: 600, n_analysed: 600, output_dir: outputDir,
      estimates: [{ term: "exposure", label: "Drug (IPTW)", measure: "odds_ratio", estimate: 0.72, ci_low: 0.55, ci_high: 0.94, p_value: 0.0004 }],
      diagnostics: { effective_sample_size: 540.2, max_smd_after: 0.03 }, warnings: ["Example caution."],
      tables: { table1: [{ variable: "N", overall: "600", exposed: "200", unexposed: "400", smd: null }, { variable: "Age", overall: "65 (12)", exposed: "66 (11)", unexposed: "64 (12)", smd: 0.12 }] },
      figures: [{ file: "estimates.png", title: "Effect estimate", kind: "forest" }] },
  }, {
    plan_id: "f3", frame_id: "f1", status: "blocked", stage_reached: "mapping", study_spec: { schema_version: "1.0.0", intent_family: "treatment_effect" },
    blockers: [{ stage: "mapping", code: "VARIABLE_UNMAPPED", message: { en: "exposure “罕见药”: not found.", zh: "暴露“罕见药”：未找到。" } }],
  }],
  unanswered_frames: [{ frame: vague!, reasons: [{ en: "Outcome too vague.", zh: "结局描述过于笼统。" }] }],
  summary: { frames: 2, plans: 2, completed: 1, blocked: 1, failed: 0, needs_clarification: 1 }, model_audit: [],
});

// A 1×1 PNG so the Word renderer can embed a real figure.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// pilot-1: report notices. The owner's fixed wording, pinned here so a change to it is deliberate.
const NOTICE = {
  zh: "研究原型：结果未经临床审核或外部验证，仅为观察性关联，不能作为临床决策依据；结果来自 MIMIC-IV，只能与持有 PhysioNet 授权的人员分享。",
  en: "Research prototype: results have not been reviewed by clinicians or validated externally; they are observational associations, not a basis for clinical decisions. Results come from MIMIC-IV and may be shared only with people who hold PhysioNet credentialed access.",
} as const;
const QUESTION_LABEL = { zh: "研究问题", en: "Research question" } as const;
/** The notice appears once, in the report's language, after the title and before the question. */
const assertNoticeNearTop = (content: string, language: "zh" | "en", format: string): void => {
  const other = language === "zh" ? "en" : "zh";
  const at = content.indexOf(NOTICE[language]);
  assert.ok(at >= 0, `${format} ${language}: notice missing`);
  assert.equal(content.indexOf(NOTICE[language], at + 1), -1, `${format} ${language}: notice repeated`);
  assert.ok(at < content.indexOf(QUESTION_LABEL[language]), `${format} ${language}: notice is not above the question`);
  assert.ok(at < content.indexOf("MIMIC-IV") + 200, `${format} ${language}: notice is not next to the title`);
  assert.equal(content.includes(NOTICE[other]), false, `${format} ${language}: notice in the other language`);
};
/** The paragraphs of a Word file, read with the same Python runtime that wrote it. */
const docxParagraphs = (python: string, path: string): string[] => {
  const read = spawnSync(python, ["-c", "import sys, docx\nfor p in docx.Document(sys.argv[1]).paragraphs: print(p.text)", path], { encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  return read.stdout.split("\n");
};

test("builds the same report structure in Chinese and English with results, blockers and reproducibility", () => {
  const zh = buildReportDocument(fixture("/figures"), "zh", ["仅使用院内数据。"]);
  const en = buildReportDocument(fixture("/figures"), "en");
  assert.equal(zh.title, "MIMIC-IV 研究报告");
  assert.equal(en.title, "MIMIC-IV Study Report");
  const zhText = JSON.stringify(zh.blocks); const enText = JSON.stringify(en.blocks);
  assert.match(zhText, /比值比 OR 0\.720 \(95% CI 0\.550–0\.940\), P <0\.001/u);
  assert.match(enText, /Odds ratio 0\.720/u);
  assert.match(zhText, /暴露“罕见药”：未找到/u);
  assert.match(zhText, /结局描述过于笼统/u);
  assert.match(zhText, /仅使用院内数据/u);
  assert.match(enText, /question-run:test/u);
  assert.ok(en.blocks.some((block) => block.kind === "figure" && block.path === "/figures/estimates.png"));
});

test("renders Markdown tables with relative figure links and aligned plain-text tables", () => {
  const document = buildReportDocument(fixture("/runs/r1/f1/treatment.iptw"), "en");
  const markdown = renderMarkdown(document, "/runs/r1");
  assert.match(markdown, /\| Estimate \| Measure \| Value \| 95% CI \| P \|/u);
  assert.match(markdown, /!\[Effect estimate\]\(f1\/treatment\.iptw\/estimates\.png\)/u);
  const text = renderText(buildReportDocument(fixture("/x"), "zh"));
  assert.match(text, /^MIMIC-IV 研究报告\n=+/u);
  assert.match(text, /-+-\+-/u);
});

test("writes Markdown, text and Word reports in both languages", { timeout: 120_000, skip: !existsSync(".venv/bin/python3") && "report runtime not installed (scripts/setup-report-runtime.zsh)" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "study-report-test-"));
  try {
    await writeFile(join(directory, "estimates.png"), PNG);
    const written = await writeQuestionReports(fixture(directory), join(directory, "report"));
    assert.deepEqual(written.map(({ language }) => language), ["zh", "en"]);
    for (const report of written) {
      assert.equal(report.docx_error, undefined);
      assert.ok((await stat(report.docx!)).size > 5000);
      assert.match(await readFile(report.markdown, "utf8"), /MIMIC-IV/u);
      // The Word file carries the notice as the paragraph right under its title.
      const paragraphs = docxParagraphs(".venv/bin/python3", report.docx!);
      assert.equal(paragraphs[1], NOTICE[report.language]);
      assertNoticeNearTop(paragraphs.join("\n"), report.language, "docx");
    }
    assert.match(await readFile(join(directory, "report", "run.json"), "utf8"), /question-run:test/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("every report format carries the research-prototype and data-sharing notice in its language, also without the Word runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "study-report-notice-"));
  try {
    // A missing Python runtime still writes Markdown and text, and the document handed to the Word renderer is checked directly.
    const written = await writeQuestionReports(fixture(directory), directory, { python_binary: join(directory, "no-python") });
    assert.deepEqual(written.map(({ language }) => language), ["zh", "en"]);
    for (const report of written) {
      assert.ok(report.docx_error, "the Word failure is reported");
      assertNoticeNearTop(await readFile(report.markdown, "utf8"), report.language, "markdown");
      assertNoticeNearTop(await readFile(report.text, "utf8"), report.language, "text");
      const forWord = JSON.parse(await readFile(join(directory, `.report.${report.language}.json`), "utf8")) as { blocks: Array<{ kind: string; text?: string }> };
      assert.deepEqual(forWord.blocks[1], { kind: "paragraph", text: NOTICE[report.language] });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  // A report with no completed analysis still carries it.
  const base = fixture("/x");
  const nothingRan = buildReportDocument({ ...base, plans: [base.plans[1]!], summary: { ...base.summary, completed: 0 } }, "en");
  assertNoticeNearTop(renderText(nothingRan), "en", "text");
});

test("an all-pass check verdict says the checks are automatic and do not confirm the variables", () => {
  const base = fixture("/figures");
  const quality = { rules_version: "1.0.0", status: "pass" as const, checks: [
    { check_id: "covariate_balance", status: "pass" as const, title: { en: "Covariate balance", zh: "协变量平衡" }, observed: "max SMD 0.030", expected: "max SMD ≤ 0.1", message: { en: "Balanced.", zh: "均衡。" } },
    { check_id: "group_sizes", status: "pass" as const, title: { en: "Group sizes", zh: "组别规模" }, observed: "200 / 400", expected: "≥ 50 per group", message: { en: "Large enough.", zh: "足够。" } },
  ] };
  const result: QuestionRunResult = { ...base, plans: [{ ...base.plans[0]!, quality }, base.plans[1]!] };
  const en = JSON.stringify(buildReportDocument(result, "en").blocks); const zh = JSON.stringify(buildReportDocument(result, "zh").blocks);
  // Beside the headline in the summary and in the results section.
  assert.equal(en.split("(all 2 automatic checks passed; this does not confirm the variables were chosen correctly)").length - 1, 2);
  assert.equal(zh.split("（自动核查 2 项均通过，不代表变量选择一定正确）").length - 1, 2);
  assert.doesNotMatch(en, /\(all \d+ checks passed\)/u);
  assert.doesNotMatch(zh, /（\d+ 项核查均通过）/u);
});

test("names the other listed levels as the comparator of an active-comparator plan", () => {
  const classQuestion = "降压药（ACEI、ARB、利尿剂）对死亡的疗效";
  const [classes] = buildFrames({ question: classQuestion, sub_question: classQuestion, first_id: 1, extraction: { goal: "evaluate_treatment", outcome_kind: "event", dose_question: false, population: "", exposure: "降压药（ACEI、ARB、利尿剂）", exposure_categories: ["ACEI", "ARB", "利尿剂"], comparator: "", outcomes: ["死亡"], composite_outcome: "", modifiers: [], mediators: [], predictors: [], time_window: "" } });
  const base = fixture("/figures");
  const result: QuestionRunResult = { ...base, frame_set: { ...base.frame_set, frames: [classes!] }, plans: [{ ...base.plans[0]!, plan_id: "f1.2", exposure_level: "ARB" }] };
  const comparatorRow = (language: "zh" | "en") => JSON.stringify(buildReportDocument(result, language).blocks.find((block) => block.kind === "table"));
  assert.match(comparatorRow("en"), /patients receiving ACEI, 利尿剂 but not ARB/u);
  assert.match(comparatorRow("zh"), /使用ACEI、利尿剂但未使用ARB者/u);
});

test("shows the check verdict beside every headline, the checks table and the patient flow", () => {
  const base = fixture("/figures");
  const quality = { rules_version: "1.0.0", status: "warn" as const, checks: [
    { check_id: "covariate_balance", status: "pass" as const, title: { en: "Covariate balance", zh: "协变量平衡" }, observed: "max SMD 0.030", expected: "max SMD ≤ 0.1", message: { en: "Balanced.", zh: "均衡。" } },
    { check_id: "severity_adjustment", status: "warn" as const, title: { en: "Illness severity adjustment", zh: "病情严重度校正" }, observed: "none", expected: "at least one severity measure", message: { en: "Not adjusted.", zh: "未校正。" } },
  ] };
  const result: QuestionRunResult = { ...base, plans: [{ ...base.plans[0]!, quality }, base.plans[1]!] };
  const en = JSON.stringify(buildReportDocument(result, "en").blocks); const zh = JSON.stringify(buildReportDocument(result, "zh").blocks);
  assert.match(en, /Odds ratio 0\.720[^"]*\(1 warning: illness severity adjustment\)/u);
  assert.match(zh, /（1 项警告：病情严重度校正）/u);
  assert.match(en, /Result checks \(rules 1\.0\.0\)/u);
  assert.match(en, /Excluded \(not in the study population\): 40 → remaining 610/u);
  assert.match(zh, /进入队列: 600/u);
  assert.match(JSON.stringify(buildReportDocument(base, "en").blocks), /\(not checked\)/u);
  // Every result states how far it can be read, from its own checks.
  assert.match(en, /How far to read it/u);
  assert.match(en, /not proof of causation/u);
  assert.match(en, /Illness severity was not adjusted for/u);
  assert.match(zh, /解读边界/u);
  // A degenerate estimate is not reported as a number.
  const broken = { rules_version: "1.0.0", status: "fail" as const, checks: [{ check_id: "effect_size_plausible", status: "fail" as const, title: { en: "Effect size", zh: "效应量" }, observed: "OR 0.000", expected: "0.01–100", message: { en: "Degenerate.", zh: "退化。" } }] };
  const failed = JSON.stringify(buildReportDocument({ ...base, plans: [{ ...base.plans[0]!, quality: broken }, base.plans[1]!] }, "en").blocks);
  assert.match(failed, /Not reliably estimable/u);
  assert.doesNotMatch(failed, /Odds ratio 0\.720/u);
});

test("reports the target-trial protocol, a method deviation and the plan lock", () => {
  const base = fixture("/figures");
  const protocol = { protocol_version: "1.0.0", elements: [{ key: "comparator" as const, label: { en: "Comparison group", zh: "对照组" }, emulation: "不用某药" }],
    design_checks: [{ check_id: "outcome_after_exposure", status: "warn" as const, message: { en: "Early outcomes count.", zh: "早期结局被计入。" } }] };
  const result: QuestionRunResult = { ...base, plan_lock: { lock_id: "plan-lock:sha256:abc", locked_at: "2026-09-25T00:00:00.000Z", confirmed_by: "user" },
    plans: [{ ...base.plans[0]!, protocol, method_note: { en: "The confirmed method could not run; IPTW was used.", zh: "确认的方法无法运行，改用 IPTW。" } }, base.plans[1]!] };
  const en = JSON.stringify(buildReportDocument(result, "en").blocks); const zh = JSON.stringify(buildReportDocument(result, "zh").blocks);
  assert.match(en, /Target-trial protocol \(1\.0\.0\)/u);
  assert.match(en, /"Comparison group","不用某药"/u);
  assert.match(en, /warning: Early outcomes count\./u);
  assert.match(en, /The confirmed method could not run; IPTW was used\./u);
  assert.match(en, /plan_lock: plan-lock:sha256:abc \(confirmed by the user/u);
  assert.match(zh, /plan_lock: plan-lock:sha256:abc \(用户确认/u);
});

test("a prediction model headlines its test-set AUC and an effect-modification analysis its interaction test", () => {
  const base = fixture("/figures");
  const completed = base.plans[0]!;
  // Synthetic numbers (not from MIMIC).
  const prediction = { ...completed, plan_id: "f1.p", chosen_method: "prediction.logistic", result: { ...completed.result!, method_id: "prediction.logistic", estimates: [
    { term: "predictor_0", label: "Lactate (per unit)", measure: "odds_ratio", estimate: 1.5, ci_low: 1.4, ci_high: 1.6, p_value: 0.0001 },
    { term: "auc", label: "Test-set AUC", measure: "auc", estimate: 0.7, ci_low: 0.68, ci_high: 0.72, p_value: null },
    { term: "auc_baseline", label: "Background-only AUC", measure: "auc", estimate: 0.6, ci_low: 0.58, ci_high: 0.62, p_value: null }] } };
  const modification = { ...completed, plan_id: "f1.m", result: { ...completed.result!, estimates: [{ term: "exposure", label: "Drug in Gender = F (IPTW)", measure: "odds_ratio", estimate: 0.8, ci_low: 0.7, ci_high: 0.9, p_value: 0.00001 }], diagnostics: { p_interaction: 0.423 } } };
  const result: QuestionRunResult = { ...base, plans: [prediction, modification] };
  const en = JSON.stringify(buildReportDocument(result, "en").blocks);
  assert.match(en, /Test-set AUC 0\.700 \(95% CI 0\.680–0\.720\); background-only model AUC 0\.600/u);
  assert.doesNotMatch(en, /f1\.p[^"]*Lactate/u);
  assert.match(en, /P for difference in effect 0\.423; Drug in Gender = F \(IPTW\): Odds ratio 0\.800/u);
});

test("a prediction's patient flow names predictors, not an exposure or adjustment variables", () => {
  const base = fixture("/figures");
  const completed = base.plans[0]!;
  const prediction = { ...completed, chosen_method: "prediction.logistic", cohort: { ...completed.cohort!, exclusion_reasons: { not_in_population: 40, incomplete_required_variables: 10, incomplete_model_variables: 5 } } };
  const en = JSON.stringify(buildReportDocument({ ...base, plans: [prediction] }, "en").blocks);
  const zh = JSON.stringify(buildReportDocument({ ...base, plans: [prediction] }, "zh").blocks);
  assert.match(en, /no predictor measured in the window or no outcome/u);
  assert.match(en, /missing a predictor or background variable/u);
  assert.doesNotMatch(en, /lacks the exposure or outcome|missing adjustment variables/u);
  assert.doesNotMatch(zh, /缺少暴露或结局|缺少校正变量/u);
  const treatment = JSON.stringify(buildReportDocument(base, "en").blocks);
  assert.match(treatment, /lacks the exposure or outcome/u);
});

// Review of 2026-11-04: an ICU description's flow said "admission", a list of 61 codes read "(60 total)", the Chinese Table 1 of
// an English grouping read "有beta blockers", and a by-group-only description headlined only the groups' shares.
test("a description's report names its unit, counts every code used, reads an English grouping in Chinese and headlines its characteristics", () => {
  const english = "How many ICU patients with heart failure received beta blockers, and what are their characteristics?";
  const [described] = buildFrames({ question: english, sub_question: english, first_id: 1, extraction: { goal: "describe", outcome_kind: "none", dose_question: false, population: "ICU patients with heart failure", exposure: "beta blockers", exposure_categories: [], comparator: "", outcomes: ["Lactate"], composite_outcome: "", modifiers: [], mediators: [], predictors: [], time_window: "" } });
  assert.equal(described!.study_type, "descriptive");
  const codes = Array.from({ length: 61 }, (_, index) => `ICD-10 I50${index}`);
  const base = fixture("/figures");
  const plan = { ...base.plans[0]!, frame_id: "f1", chosen_method: "descriptive.rates",
    study_spec: { schema_version: "1.0.0" as const, intent_family: "association" as const, index_time: { event: "ICU admission", selection_rule: "first ICU stay per patient" }, exposure_or_predictors: [{ name: "Beta blockers", role: "exposure" as const, operational_definition: "Any recorded Beta blockers within the first 24 hours after the index time." }], characteristics: [{ name: "Lactate", role: "covariate" as const, operational_definition: "Lactate as its variable definition specifies." }] },
    mapping: [{ role: "population", requested_term: "heart failure", status: "resolved" as const, selected: { mapping_id: "hf", label: "Heart failure", status: "validated", table: "mimiciv_hosp.diagnoses_icd", identifiers: 61, values: codes.slice(0, 60) }, candidates: [] }],
    cohort: { rows: 900, analysis_units: 1000, excluded_rows: 100, exclusion_reasons: { not_first_eligible_unit_of_patient: 100 }, cohort_integrity_id: "sha256:cohort" },
    result: { ...base.plans[0]!.result!, method_id: "descriptive.rates", n_input: 900, n_analysed: 900, estimates: [
      { term: "group:yes", label: "Beta blockers: yes (overall)", measure: "proportion", estimate: 0.54, ci_low: 0.5, ci_high: 0.58, p_value: null },
      { term: "group:no", label: "Beta blockers: no (overall)", measure: "proportion", estimate: 0.46, ci_low: 0.42, ci_high: 0.5, p_value: null },
      { term: "characteristic_0:yes", label: "Lactate in Beta blockers = yes", measure: "mean", estimate: 2.2, ci_low: 2.1, ci_high: 2.3, p_value: null },
      { term: "characteristic_0:no", label: "Lactate in Beta blockers = no", measure: "mean", estimate: 2.8, ci_low: 2.7, ci_high: 2.9, p_value: null }],
      tables: { table1: [{ variable: "N", overall: "900", exposed: "486", unexposed: "414", missing: "" }, { variable: "Lactate", overall: "2.5 (1.2)", exposed: "2.2 (1.1)", unexposed: "2.8 (1.3)", missing: "600" }] } } };
  const result: QuestionRunResult = { ...base, question: english, frame_set: { schema_version: "1.0.0", original_question: english, frames: [described!] }, plans: [plan], unanswered_frames: [] };
  const en = renderMarkdown(buildReportDocument(result, "en"), "/runs");
  const zh = renderMarkdown(buildReportDocument(result, "zh"), "/runs");
  assert.match(en, /Excluded \(not the patient's first eligible ICU stay\): 100 → remaining 900/u);
  assert.match(en, /Analysis units assessed \(ICU stays\): 1,000/u);
  assert.match(zh, /排除（同一患者的非首次符合条件 ICU 入住）：100/u);
  assert.match(en, /… \(61 total\)/u);
  assert.match(zh, /等 61 项/u);
  assert.doesNotMatch(en, /60 total/u);
  assert.match(zh, /\| beta blockers：是 \| beta blockers：否 \|/iu);
  assert.doesNotMatch(zh, /有beta blockers/iu);
  assert.match(en, /900 patients: Beta blockers: yes 54\.0%.*Lactate in Beta blockers = yes 2\.20.*Lactate in Beta blockers = no 2\.80/u);
  // A hospital-admission plan keeps "admission".
  const admission = { ...plan, study_spec: { ...plan.study_spec, index_time: { event: "hospital admission", selection_rule: "first hospital admission per patient" } } };
  assert.match(renderMarkdown(buildReportDocument({ ...result, plans: [admission] }, "en"), "/runs"), /not the patient's first eligible admission/u);
});

// Compendium of 2026-11-04 (how to read, item 12): the adjustment row listed lactate although it was left out of the model,
// an ICU question's flow said "discharged or died" for an ICU stay that ended, and 4.4's English design table said "first 24
// hours" for vital signs read over 0–6 hours.
test("the report lists only the adjustment variables the model used, names an ICU stay that ended, and states the window the plan ran with", () => {
  const base = fixture("/figures");
  const completed = base.plans[0]!;
  const spec = completed.study_spec;
  const withSeverity = { ...completed, covariates_not_modelled: [{ name: "Lactate", reason: "switched_off" as const }], study_spec: { ...spec, covariates: [...spec.covariates!, { name: "Lactate", role: "covariate" as const, operational_definition: "Lactate in the first 24 hours after the index time (illness severity)." }] } };
  const en = JSON.stringify(buildReportDocument({ ...base, plans: [withSeverity] }, "en").blocks);
  const zh = JSON.stringify(buildReportDocument({ ...base, plans: [withSeverity] }, "zh").blocks);
  assert.match(en, /"Adjustment","Age \(not in the model: Lactate, switched off\)"/u);
  assert.match(zh, /"校正变量","年龄（未纳入模型：乳酸，未选用）"/u);

  const icu = { ...completed, study_spec: { ...spec, index_time: { event: "ICU admission", selection_rule: "first ICU stay per patient" } }, cohort: { ...completed.cohort!, exclusion_reasons: { ended_before_landmark: 30, outcome_before_landmark: 5, not_in_population: 5, incomplete_required_variables: 10 } } };
  const icuEn = JSON.stringify(buildReportDocument({ ...base, plans: [icu] }, "en").blocks);
  const icuZh = JSON.stringify(buildReportDocument({ ...base, plans: [icu] }, "zh").blocks);
  assert.match(icuEn, /the ICU stay ended before the follow-up start \(transfer out of the ICU, discharge or death\)/u);
  assert.match(icuEn, /had the outcome before the follow-up start \(including earlier in the same admission, before the ICU stay\)\): 5 → remaining 615/u);
  assert.match(icuZh, /ICU 入住在随访起点之前已结束（转出 ICU、出院或死亡）/u);
  assert.doesNotMatch(icuEn, /discharged or died before/u);

  const sixHours = { ...completed, chosen_method: "prediction.logistic", study_spec: { ...spec, intent_family: "prediction" as const,
    exposure_or_predictors: [{ name: "Heart rate", role: "predictor" as const, operational_definition: "Heart rate within the first 24 hours after the index time, summarised as its variable definition specifies." }],
    time_windows: [{ purpose: "exposure" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 6, unit: "hour" as const }, { purpose: "baseline" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 6, unit: "hour" as const }] } };
  const sixEn = JSON.stringify(buildReportDocument({ ...base, plans: [sixHours] }, "en").blocks);
  assert.match(sixEn, /Heart rate: Heart rate within the first 6 hours after the index time/u);
  assert.doesNotMatch(sixEn, /first 24 hours/u);
});

test("a prediction's report names its background variables and a predictor that a default covariate repeats", () => {
  const base = fixture("/figures");
  const completed = base.plans[0]!;
  const prediction = { ...completed, chosen_method: "prediction.logistic", covariates_not_modelled: [{ name: "Age", reason: "predictor" as const }],
    study_spec: { ...completed.study_spec, intent_family: "prediction" as const, covariates: [{ name: "Age", role: "covariate" as const, operational_definition: "Age." }, { name: "Sex", role: "covariate" as const, operational_definition: "Sex." }] } };
  const en = JSON.stringify(buildReportDocument({ ...base, plans: [prediction] }, "en").blocks);
  const zh = JSON.stringify(buildReportDocument({ ...base, plans: [prediction] }, "zh").blocks);
  assert.match(en, /"Background variables \(comparison model\)","Sex \(not in the comparison model: Age, already a predictor\)"/u);
  assert.match(zh, /"背景变量（对照模型）","性别（未纳入对照模型：年龄，已作为预测因子）"/u);
  assert.doesNotMatch(en, /the exposure itself/u);
});
