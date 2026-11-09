import assert from "node:assert/strict";
import test from "node:test";
import { buildFrames, type FrameExtraction } from "../../study-framing/index.js";
import { assessFrame, FileLimitationKnowledgeBaseRepository, limitationSentences, matchLimitations } from "../index.js";

const knowledge = await new FileLimitationKnowledgeBaseRepository(new URL("../../../../config/mimic-limitations/mimic-iv-3.1.json", import.meta.url)).load();
const extraction = (overrides: Partial<FrameExtraction>): FrameExtraction => ({ goal: "evaluate_treatment", outcome_kind: "event", dose_question: false, population: "", exposure: "", exposure_categories: [], comparator: "", outcomes: [], composite_outcome: "", modifiers: [], mediators: [], predictors: [], time_window: "", ...overrides });

test("every entry is bilingual and has a stable id", () => {
  const ids = new Set<string>();
  for (const entry of knowledge.entries) {
    assert.ok(entry.statement.en && entry.statement.zh, entry.id);
    assert.ok(!ids.has(entry.id), `duplicate ${entry.id}`); ids.add(entry.id);
    if (entry.proxy) assert.ok(entry.proxy.en && entry.proxy.zh, entry.id);
  }
});

test("matches limitations by normalized category and by keyword in either language", () => {
  const question = "高血压患者使用某降压药与不用的心血管死亡差异";
  const [frame] = buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ population: "高血压患者", exposure: "某降压药", comparator: "不用某降压药", outcomes: ["心血管死亡"] }) });
  frame!.exposure!.normalized = { label_en: "Antihypertensive agent", category: "medication" };
  frame!.population!.normalized = { label_en: "Hypertension", category: "diagnosis" };
  const ids = matchLimitations(knowledge, [frame!]).map(({ id }) => id);
  for (const expected of ["single_center", "observational_confounding", "in_hospital_medication_only", "no_cause_of_death", "icd_codes_at_discharge", "blood_pressure_sources", "death_follow_up_one_year"]) assert.ok(ids.includes(expected), expected);
  assert.ok(!ids.includes("pain_scores"));
  const zh = limitationSentences(matchLimitations(knowledge, [frame!]), "zh");
  assert.ok(zh.some((sentence) => /不记录死亡原因.*替代方案/u.test(sentence)));
});

test("flags modules that are not in the local archive", () => {
  const question = "超声心动图测得的心指数与死亡的关系";
  const [frame] = buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ goal: "relate_factor", population: "脓毒症患者", exposure: "超声心动图测得的心指数", outcomes: ["死亡"] }) });
  assert.ok(matchLimitations(knowledge, [frame!]).some(({ id }) => id === "modules_not_in_archive"));
});

test("substitutes unmeasurable death causes and excludes diagnosis-only outcome components", async () => {
  const { assessOutcomeComponents } = await import("../index.js");
  const result = assessOutcomeComponents(knowledge, [
    { text: "心血管死亡", label_en: "Cardiovascular death", category: "outcome" },
    { text: "心肌梗死", label_en: "Myocardial infarction", category: "diagnosis" },
    { text: "中风", label_en: "Stroke", category: "diagnosis" },
  ]);
  assert.deepEqual(result.kept, [{ text: "心血管死亡", concept_en: "All-cause death", substituted_from: "心血管死亡" }]);
  assert.deepEqual(result.excluded.map(({ text }) => text), ["心肌梗死", "中风"]);
  assert.match(result.excluded[0]!.reason.zh, /无法证明发生在暴露之后/u);
});

test("stops an outpatient population and caps survival beyond MIMIC-IV's one-year death follow-up", async () => {
  const { assessFrame } = await import("../index.js");
  const outpatient = "门诊患者使用他汀类药物与心肌梗死发生率的关系";
  const [statin] = buildFrames({ question: outpatient, sub_question: outpatient, first_id: 1, extraction: extraction({ population: "门诊患者", exposure: "他汀类药物", outcomes: ["心肌梗死发生率"] }) });
  const stopped = assessFrame(knowledge, statin!);
  assert.equal(stopped.not_answerable?.slot, "population");
  assert.match(stopped.not_answerable!.reason.zh, /没有门诊/u);
  const pneumonia = "社区获得性肺炎患者使用糖皮质激素与死亡";
  const [cap] = buildFrames({ question: pneumonia, sub_question: pneumonia, first_id: 1, extraction: extraction({ population: "社区获得性肺炎患者", exposure: "糖皮质激素", outcomes: ["死亡"] }) });
  assert.equal(assessFrame(knowledge, cap!).not_answerable, undefined, "community-acquired pneumonia is an inpatient population");
  const survival = "吸烟对肺癌患者5年生存的影响";
  const [lung] = buildFrames({ question: survival, sub_question: survival, first_id: 1, extraction: extraction({ goal: "relate_factor", outcome_kind: "time_to_event", population: "肺癌患者", exposure: "吸烟", outcomes: ["5年生存"], time_window: "5年" }) });
  assert.equal(assessFrame(knowledge, lung!).follow_up_cap?.max_days, 365);
});

test("an aim that needs data MIMIC-IV does not hold is stopped with the reason, and ordinary wording is not", async () => {
  const { assessFrame } = await import("../index.js");
  const make = (question: string, overrides: Partial<FrameExtraction>) => buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction(overrides) })[0]!;
  const cases: Array<[string, Partial<FrameExtraction>, string | undefined]> = [
    ["Does the chest X-ray finding predict ventilation?", { goal: "predict", exposure: "chest X-ray finding", outcomes: ["mechanical ventilation"] }, "exposure"],
    ["射血分数降低的心衰患者使用β受体阻滞剂与死亡", { population: "射血分数降低的心衰患者", exposure: "β受体阻滞剂", outcomes: ["死亡"] }, "population"],
    ["Is the drug associated with 30-day readmission?", { exposure: "statin", outcomes: ["30-day readmission"] }, undefined], // answered by the derived readmission variables, with the cautions of readmission_this_hospital_only
    ["儿童脓毒症患者使用激素与死亡", { population: "儿童脓毒症患者", exposure: "激素", outcomes: ["死亡"] }, "population"],
    ["In patients with ARDS, is statin use before ICU admission associated with lower 30-day mortality?", { population: "ARDS", exposure: "statin use before", outcomes: ["30-day mortality"] }, "exposure"],
    ["Primary hypertension and metoprolol with death", { population: "primary hypertension", exposure: "metoprolol", outcomes: ["death"] }, undefined],
    ["Diethylstilbestrol and death", { exposure: "diethylstilbestrol", outcomes: ["death"] }, undefined],
    // Whether a drug should be used is a recommendation (2026-11-04: none of the earlier phrases matched these).
    ["脓毒症休克患者该不该用β受体阻滞剂", { population: "脓毒症休克患者", exposure: "β受体阻滞剂", outcomes: ["死亡"] }, "exposure"],
    ["Should beta blockers be used in patients with septic shock?", { population: "septic shock", exposure: "beta blockers", outcomes: ["death"] }, "exposure"],
    ["高血压患者是否应该使用ACEI", { population: "高血压患者", exposure: "ACEI", outcomes: ["死亡"] }, "exposure"],
    ["Is the use of beta blockers in septic shock associated with death?", { population: "septic shock", exposure: "beta blockers", outcomes: ["death"] }, undefined],
  ];
  for (const [question, overrides, slot] of cases) assert.equal(assessFrame(knowledge, make(question, overrides)).not_answerable?.slot, slot, question);
});

test("no rule refuses a question for something the concept pack can answer", async () => {
  const { readFile } = await import("node:fs/promises");
  const pack = JSON.parse(await readFile(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url), "utf8")) as { mappings: Array<{ concept_id: string; labels: { en: string; zh?: string }; synonyms: string[] }> };
  const names = (entry: (typeof pack.mappings)[number]): string => [entry.labels.en, entry.labels.zh, ...entry.synonyms].filter(Boolean).join(" | ").toLocaleLowerCase();
  const clashes: string[] = [];
  for (const entry of knowledge.entries) {
    const rule = entry.frame_rule;
    if (rule?.action !== "not_answerable") continue;
    for (const keyword of rule.keywords) for (const concept of pack.mappings) if (names(concept).includes(keyword.toLocaleLowerCase())) clashes.push(`${entry.id} refuses “${keyword}” but the pack defines ${concept.concept_id}`);
  }
  assert.deepEqual(clashes, [], "a refusal rule contradicts a defined variable: remove the refusal or the variable");
});

test("ECG events and clinical notes are not answerable, whichever slot names them", async () => {
  const knowledge = await new FileLimitationKnowledgeBaseRepository(new URL("../../../../config/mimic-limitations/mimic-iv-3.1.json", import.meta.url)).load();
  const frame = (outcome: string) => ({ frame_id: "f1", sub_question: "q", study_type: "treatment_effect", facets: {}, population: { text: "hospitalised adults", verbatim: true }, exposure: { text: "sertraline", verbatim: true }, outcome: { text: outcome, verbatim: true }, modifiers: [], mediators: [], predictors: [], assumptions: [], ambiguities: [], status: "ready" }) as unknown as Parameters<typeof assessFrame>[1];
  assert.match(assessFrame(knowledge, frame("ECG safety events")).not_answerable!.reason.en, /MIMIC-IV-ECG/u);
  assert.match(assessFrame(knowledge, frame("QTc prolongation")).not_answerable!.reason.en, /MIMIC-IV-ECG/u);
  assert.equal(assessFrame(knowledge, frame("in-hospital death")).not_answerable, undefined);
  assert.match(assessFrame(knowledge, frame("ED triage risk level")).not_answerable!.reason.en, /MIMIC-IV-ED/u);
  assert.equal(assessFrame(knowledge, frame("emergency admission")).not_answerable, undefined);
});

test("a description's characteristics are held to the rules on outcomes", () => {
  const question = "Describe the ejection fraction and length of stay of patients with heart failure";
  const [frame] = buildFrames({ question, sub_question: question, first_id: 1, extraction: extraction({ goal: "describe", outcome_kind: "none", population: "patients with heart failure", outcomes: ["ejection fraction", "length of stay"] }) });
  assert.equal(frame!.study_type, "descriptive");
  assert.equal(frame!.outcome, undefined);
  assert.equal(assessFrame(knowledge, frame!).not_answerable?.text, "ejection fraction");
  assert.ok(matchLimitations(knowledge, [frame!]).some(({ id }) => id === "no_echo_measurements"));
});
