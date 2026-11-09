import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface PackEntry { concept_id: string; sources: Array<{ kind: string; codes?: Array<{ code: string; version: number }> }> }
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as T;
const codesOf = (pack: { mappings: PackEntry[] }, conceptId: string, version: number): Set<string> =>
  new Set(pack.mappings.find((entry) => entry.concept_id === conceptId)!.sources[0]!.codes!.filter((code) => code.version === version).map(({ code }) => code));

test("diagnosis code sets cover the codes the archive uses and leave out look-alikes", async () => {
  const pack = await readJson<{ mappings: PackEntry[] }>("../../../../config/mappings/mimic-iv-core.json");
  // Atrial fibrillation was coded I48.9 (unspecified fibrillation or flutter) until 2019: tens of thousands of diagnoses.
  assert.ok(codesOf(pack, "atrial_fibrillation", 10).has("I489"), "I48.9 is the usual code of unspecified atrial fibrillation");
  assert.ok(!codesOf(pack, "atrial_fibrillation", 10).has("I4892"), "unspecified atrial flutter is not atrial fibrillation");
  // Respiratory failure after trauma or surgery is not ARDS.
  assert.deepEqual([...codesOf(pack, "ards", 9)].sort(), ["51852", "51882"]);
  assert.ok(codesOf(pack, "end_stage_kidney_disease", 9).has("5856") && codesOf(pack, "end_stage_kidney_disease", 10).has("N186"));
  assert.ok(codesOf(pack, "pneumonia", 10).has("J690") && codesOf(pack, "pneumonia", 9).has("99731"), "aspiration and ventilator-associated pneumonia are pneumonia");
  assert.ok(codesOf(pack, "chronic_kidney_disease", 10).has("I129") && codesOf(pack, "chronic_kidney_disease", 9).has("40300"), "hypertensive chronic kidney disease is chronic kidney disease");
  assert.ok(codesOf(pack, "dementia", 9).has("29420") && codesOf(pack, "dementia", 10).has("G3183"), "unspecified, frontotemporal and Lewy body dementia");
  assert.ok(codesOf(pack, "diabetes_mellitus", 9).has("24900"), "secondary diabetes");
  assert.ok(codesOf(pack, "copd", 9).has("49320"), "chronic obstructive asthma");
});

test("the diagnosis order of the derived layer lists every coded diagnosis concept once and only appends", async () => {
  const pack = await readJson<{ mappings: PackEntry[] }>("../../../../config/mappings/mimic-iv-core.json");
  const { order } = await readJson<{ order: string[] }>("../../../../config/derived/diagnosis-order.json");
  const coded = pack.mappings.filter((entry) => entry.sources[0]?.kind === "diagnosis_code" && entry.sources[0].codes?.length).map((entry) => entry.concept_id);
  assert.equal(new Set(order).size, order.length, "no concept appears twice");
  assert.deepEqual(coded.filter((concept) => !order.includes(concept)), [], "a new coded concept must be appended to the order file, which fixes its derived item ids");
  // The first 24 entries are the order the derived layer was first built with; they never move.
  assert.deepEqual(order.slice(0, 24), ["acute_kidney_injury", "acute_pancreatitis", "ards", "arrhythmia", "atrial_fibrillation", "benign_prostatic_hyperplasia", "chronic_kidney_disease", "cirrhosis", "copd", "coronary_heart_disease", "dementia", "diabetes_mellitus", "diabetic_ketoacidosis", "heart_failure", "hypertension", "intracerebral_hemorrhage", "lung_cancer", "myocardial_infarction", "pneumonia", "sepsis", "septic_shock", "smoking", "stroke", "transient_ischemic_attack"]);
});

test("an eye-drop beta blocker is not counted as a systemic beta blocker", async () => {
  const catalog = await readJson<{ classes: Array<{ class_id: string; ingredients: string[] }> }>("../../../../config/drug-classes/drug-classes.json");
  const ingredients = (id: string) => catalog.classes.find((item) => item.class_id === id)!.ingredients;
  assert.ok(!ingredients("beta_blockers").includes("timolol") && !ingredients("beta_blockers").includes("betaxolol"), "timolol and betaxolol are used almost only as glaucoma eye drops");
  assert.deepEqual(ingredients("ophthalmic_beta_blockers").sort(), ["betaxolol", "timolol"]);
});
