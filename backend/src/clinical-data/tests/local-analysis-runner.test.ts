import assert from "node:assert/strict";
import test from "node:test";
import { LocalAnalysisRunner } from "../index.js";

const rows = [
  { stay_id: 1, exposure: true, outcome: true }, { stay_id: 2, exposure: true, outcome: false },
  { stay_id: 3, exposure: false, outcome: true }, { stay_id: 4, exposure: false, outcome: false },
];
const manifest = { subject_id: "stay_id", exposure: "exposure", outcome: "outcome" };

test("dispatches a manifest to the requested binary family", async () => {
  const run = await new LocalAnalysisRunner().run("binary_association", rows, manifest);
  assert.equal(run.family, "binary_association");
  assert.deepEqual((run.result as { counts: Record<string, number> }).counts, { exposed_events: 1, exposed_non_events: 1, unexposed_events: 1, unexposed_non_events: 1 });
});

test("fails closed when a requested executor is not registered", async () => {
  await assert.rejects(() => new LocalAnalysisRunner().run("time_to_event_association", rows, { ...manifest, time_end: "duration" }), /No Cox executor/u);
});
