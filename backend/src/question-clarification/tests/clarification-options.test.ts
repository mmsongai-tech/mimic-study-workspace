import assert from "node:assert/strict";
import { test } from "node:test";
import type { StudyFrame } from "../../study-framing/index.js";
import { FileReadingCatalogRepository, clarificationOffers, decide, pickIndex, readingAssumption, readingsFor, resolvedQuestion } from "../index.js";

const catalog = await new FileReadingCatalogRepository(new URL("../../../../config/clarifications/vague-outcome-readings.json", import.meta.url)).load();

const frame = (over: Partial<StudyFrame> & { sub_question: string }): StudyFrame => ({
  frame_id: "f1", study_type: "treatment_effect", facets: { goal: "evaluate_treatment", outcome_kind: "none", dose_question: false, has_modifier: false, has_mediator: false },
  modifiers: [], mediators: [], predictors: [], assumptions: [], status: "needs_clarification",
  ambiguities: [{ code: "VAGUE_OUTCOME", slot: "outcome", message: "vague" }], outcome: { text: "疗效", verbatim: true }, ...over,
});

const alpha = frame({ sub_question: "钙通道阻滞剂用于老年高血压患者的疗效评价", exposure: { text: "钙通道阻滞剂", verbatim: true }, population: { text: "老年高血压", verbatim: true } });

test("every reading in the shipped catalog is complete and the catalog loads", () => {
  assert.ok(catalog.generic.length >= 3);
  assert.ok(catalog.purposes.length >= 4);
});

test("readings that fit the treatment come first, general ones fill up to three", () => {
  const readings = readingsFor(alpha, catalog);
  assert.equal(readings.length, 3);
  assert.equal(readings[0]!.id, "bp_lowering");
  assert.deepEqual(readings.slice(1).map(({ id }) => id), ["in_hospital_death", "hospital_stay"]);
});

test("a treatment with no purpose in the catalog is offered the general readings only", () => {
  const readings = readingsFor(frame({ sub_question: "X药在患者中的疗效", exposure: { text: "X药", verbatim: true } }), catalog);
  assert.deepEqual(readings.map(({ id }) => id), ["in_hospital_death", "hospital_stay", "readmission_30d"]);
});

test("an offer writes each reading into the question; the other aims keep their words", () => {
  const question = `A药降低死亡率吗？${alpha.sub_question}`;
  const [offer] = clarificationOffers(question, [alpha], catalog);
  assert.equal(offer!.options.length, 3);
  assert.equal(offer!.options[0]!.sub_question, "钙通道阻滞剂用于老年高血压患者的降压效果评价");
  assert.equal(offer!.options[0]!.question, `A药降低死亡率吗？${offer!.options[0]!.sub_question}`);
});

test("an English question gets English readings", () => {
  const english = frame({ sub_question: "Is efficacy of statins different in sepsis?", outcome: { text: "efficacy", verbatim: true } });
  const [offer] = clarificationOffers(english.sub_question, [english], catalog);
  assert.match(offer!.options[0]!.sub_question, /in-hospital death/u);
});

test("an aim that is not stopped for a vague outcome, or whose words cannot be located, gets no offer", () => {
  assert.equal(clarificationOffers(alpha.sub_question, [{ ...alpha, status: "ready" }], catalog).length, 0);
  assert.equal(clarificationOffers("another sentence", [alpha], catalog).length, 0);
  assert.equal(clarificationOffers(alpha.sub_question, [{ ...alpha, ambiguities: [] }], catalog).length, 0);
});

test("ask leaves the choice to the researcher; first takes the best reading; random is stable for a question", () => {
  const offers = clarificationOffers(alpha.sub_question, [alpha], catalog);
  const asked = decide(alpha.sub_question, offers, "ask");
  assert.equal(asked.question, alpha.sub_question); assert.equal(asked.records[0]!.chosen, undefined);
  const first = decide(alpha.sub_question, offers, "first");
  assert.equal(first.records[0]!.chosen!.option_id, "bp_lowering"); assert.match(first.question, /降压效果/u);
  const again = decide(alpha.sub_question, offers, "random");
  assert.equal(again.records[0]!.chosen!.by, "automatic_random");
  assert.equal(pickIndex("random", "q", "f1", 3), pickIndex("random", "q", "f1", 3));
  assert.ok([...Array(40).keys()].some((i) => pickIndex("random", `q${i}`, "f1", 3) !== 0), "random must not always pick the first");
});

test("the chosen reading is stated as an assumption with the others it was chosen from", () => {
  const offers = clarificationOffers(alpha.sub_question, [alpha], catalog);
  const [record] = decide(alpha.sub_question, offers, "first").records;
  const note = readingAssumption(record!)!;
  assert.match(note, /Blood pressure lowering/u); assert.match(note, /In-hospital death/u); assert.match(note, /chosen automatically/u);
  assert.equal(readingAssumption(offers[0]!), undefined);
  assert.equal(resolvedQuestion(alpha.sub_question, offers, {}), alpha.sub_question);
});
