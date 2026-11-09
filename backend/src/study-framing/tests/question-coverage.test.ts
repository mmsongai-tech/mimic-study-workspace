import assert from "node:assert/strict";
import test from "node:test";
import { buildConceptFinder, unaccountedConcepts } from "../index.js";
import type { StudyFrame } from "../domain/study-frame.js";

const find = buildConceptFinder([
  { id: "hypertension", label: "Hypertension", names: ["高血压", "high blood pressure"] },
  { id: "bph", label: "Benign prostatic hyperplasia", names: ["前列腺增生", "BPH", "prostatic hyperplasia"] },
  { id: "class:alpha", label: "Alpha-adrenergic blockers", names: ["α受体阻滞剂", "α受体阻断剂", "alpha blocker"] },
  { id: "all_cause_death", label: "All-cause death", names: ["全因死亡", "死亡", "mortality"] },
]);
const frame = (question: string, slots: Partial<StudyFrame>): StudyFrame => ({ frame_id: "f1", sub_question: question, study_type: "treatment_effect", facets: { goal: "evaluate_treatment", outcome_kind: "event", dose_question: false, has_modifier: false, has_mediator: false }, modifiers: [], mediators: [], predictors: [], assumptions: [], ambiguities: [], status: "ready", ...slots });
const slot = (text: string) => ({ text, verbatim: true });

test("a condition the question names but no slot carries is reported", () => {
  const dropped = frame("前列腺增生患者使用α受体阻滞剂后高血压和死亡的差异", { population: slot("高血压"), exposure: slot("α受体阻滞剂"), outcome: slot("全因死亡") });
  assert.deepEqual(unaccountedConcepts(dropped, find), ["bph"]);
});

test("nothing is reported when every named concept is carried, whichever language the slot uses", () => {
  const carried = frame("糖尿病合并高血压患者使用钙通道阻滞剂的死亡", { population: slot("糖尿病合并高血压"), exposure: { text: "Calcium channel blocker", verbatim: false, normalized: { label_en: "Calcium channel blockers", category: "medication" } }, outcome: slot("死亡") });
  assert.deepEqual(unaccountedConcepts(carried, find), []);
  assert.deepEqual(unaccountedConcepts(frame("hypertension and mortality", { population: slot("high blood pressure"), outcome: slot("mortality") }), find), []);
});

test("a Latin name matches whole words only and a three-letter abbreviation is ignored", () => {
  assert.deepEqual([...find("subphrenic abscess")], []);
  assert.deepEqual([...find("patients with prostatic hyperplasia")], ["bph"]);
  assert.deepEqual([...find("patients with BPH")], [], "an abbreviation of three letters or fewer is too ambiguous to name a concept");
});

test("a population that names two conditions or treatments is their conjunction; one concept is left alone", async () => {
  const { populationConcepts } = await import("../question-coverage.js");
  const concepts = [
    { id: "sepsis", label: "Sepsis", names: ["脓毒症"], category: "diagnosis" }, { id: "invasive_ventilation", label: "Invasive mechanical ventilation", names: ["ventilated", "mechanically ventilated", "机械通气"], category: "intervention" },
    { id: "diabetes", label: "Diabetes", names: [], category: "diagnosis" }, { id: "t2dm", label: "Type 2 diabetes", names: [], category: "diagnosis" }, { id: "lactate", label: "Lactate", names: [], category: "laboratory" },
  ];
  assert.deepEqual(populationConcepts(concepts, "mechanically ventilated patients with sepsis"), ["Sepsis", "Invasive mechanical ventilation"]);
  assert.equal(populationConcepts(concepts, "patients with sepsis"), undefined);
  assert.equal(populationConcepts(concepts, "patients with type 2 diabetes"), undefined, "a name inside a longer one is not a second condition");
  assert.equal(populationConcepts(concepts, "sepsis patients with high lactate"), undefined, "a laboratory value is not a population condition");
});
