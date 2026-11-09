import assert from "node:assert/strict";
import test from "node:test";
import { resolvedOptions } from "../question-plan.js";
import type { DraftPlan } from "../question-plan.js";
import { offerTimeOptions, resolveTime, retimeWindows, timeChoiceProblem } from "../time-options.js";
import type { StudySpec } from "../../research-design/index.js";

const spec = {
  exposure_or_predictors: [{ name: "Drug", role: "exposure" }],
  time_windows: [
    { purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" },
    { purpose: "baseline", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" },
    { purpose: "follow_up", anchor: "index_time", start_offset: 24, end_offset: 72, unit: "hour" },
  ],
} as unknown as StudySpec;

test("a plan offers the windows it carries, each with its default among the choices", () => {
  const offer = offerTimeOptions(spec)!;
  assert.equal(offer.exposure!.default_hours, 24);
  assert.ok(offer.exposure!.choices.includes(48) && offer.exposure!.choices.includes(24));
  assert.equal(offer.follow_up_end!.default_hours, 72);
  assert.equal(offer.outcome_horizon, undefined, "no outcome horizon window, none offered");
  assert.equal(offerTimeOptions({ time_windows: [] } as unknown as StudySpec), undefined);
});

test("a choice outside the offer, or a follow-up that ends before the exposure window does, is refused", () => {
  const offer = offerTimeOptions(spec);
  assert.match(timeChoiceProblem(offer, { exposure_hours: 5 })!, /not offered/u);
  assert.equal(timeChoiceProblem(offer, { exposure_hours: 48 }), undefined);
  assert.match(timeChoiceProblem(offer, { exposure_hours: 72, follow_up_end_hours: 72 })!, /after the exposure window/u);
  assert.match(timeChoiceProblem(undefined, { exposure_hours: 24 })!, /offers no time options/u);
});

test("re-timing moves every exposure and baseline window, copies inside conditions included, and the follow-up start with them", () => {
  const offer = offerTimeOptions(spec);
  const manifest = {
    time_windows: spec.time_windows,
    variables: [{ semantic_condition: { kind: "event_exists", window: { purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" } } }],
    population_predicate: { kind: "all", operands: [{ kind: "event_exists", window: { purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" } }] },
  };
  const moved = retimeWindows(manifest, offer, resolveTime(offer, { exposure_hours: 48, follow_up_end_hours: 96 })) as typeof manifest;
  assert.equal(moved.time_windows!.find((w) => w.purpose === "exposure")!["end_offset" as never], 48);
  assert.equal(moved.time_windows!.find((w) => w.purpose === "baseline")!["end_offset" as never], 48);
  const followUp = moved.time_windows!.find((w) => w.purpose === "follow_up") as unknown as { start_offset: number; end_offset: number };
  assert.deepEqual([followUp.start_offset, followUp.end_offset], [48, 96]);
  assert.equal((moved.variables[0]!.semantic_condition.window as { end_offset: number }).end_offset, 48);
  assert.equal(((moved.population_predicate.operands[0] as { window: { end_offset: number } }).window).end_offset, 48);
  assert.equal((manifest.time_windows![0] as unknown as { end_offset: number }).end_offset, 24, "the original is not changed");
  assert.equal(retimeWindows(manifest, offer, resolveTime(offer, undefined)), manifest, "the default changes nothing");
});

test("the landmark follows the chosen exposure window", () => {
  const offer = offerTimeOptions(spec);
  const plan = { design_options: { landmark: { hours: 24, default: true }, time: offer } } as unknown as DraftPlan;
  assert.equal(resolvedOptions(plan, undefined).landmark_hours, 24);
  assert.equal(resolvedOptions(plan, { time: { exposure_hours: 48 } }).landmark_hours, 48);
  assert.equal(resolvedOptions(plan, { landmark: false, time: { exposure_hours: 48 } }).landmark_hours, undefined);
});

test("a prediction's outcome window starts where the chosen predictor window ends; a treatment's starts at time zero", () => {
  const window = (purpose: string, start: number, end: number) => ({ purpose, anchor: "index_time", start_offset: start, end_offset: end, unit: "hour" });
  const prediction = { exposure_or_predictors: [{ name: "Heart rate", role: "predictor" }], time_windows: [window("exposure", 0, 6), window("baseline", 0, 6), window("outcome", 6, 48)] } as unknown as StudySpec;
  const offer = offerTimeOptions(prediction);
  const outcome = (spec: StudySpec) => spec.time_windows!.find(({ purpose }) => purpose === "outcome") as unknown as { start_offset: number; end_offset: number };
  const longer = retimeWindows(prediction, offer, resolveTime(offer, { exposure_hours: 12 }));
  assert.deepEqual([outcome(longer).start_offset, outcome(longer).end_offset], [12, 48]);
  const later = retimeWindows(prediction, offer, resolveTime(offer, { outcome_horizon_hours: 72 }));
  assert.deepEqual([outcome(later).start_offset, outcome(later).end_offset], [6, 72]);
  const treatment = { exposure_or_predictors: [{ name: "Drug", role: "exposure" }], time_windows: [window("exposure", 0, 24), { purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 28, unit: "day" }] } as unknown as StudySpec;
  const treatmentOffer = offerTimeOptions(treatment);
  const retimed = retimeWindows(treatment, treatmentOffer, resolveTime(treatmentOffer, { exposure_hours: 48, outcome_horizon_hours: 720 }));
  assert.deepEqual(retimed.time_windows!.find(({ purpose }) => purpose === "outcome"), { purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 720, unit: "hour" });
});
