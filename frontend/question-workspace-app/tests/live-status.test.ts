/**
 * Live run status on the page: when a run counts as stalled, and how the time since the last progress update reads.
 *   node --import tsx --test frontend/question-workspace-app/tests/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSince, isStalled, STALLED_AFTER_MS } from "../src/lib/domain.ts";
import type { QuestionRunRecord } from "../src/lib/api-types.ts";

const NOW = Date.parse("2026-11-09T10:00:00Z");
const ago = (seconds: number): number => NOW - seconds * 1000;
const live = (stalled: boolean, heartbeatSecondsAgo: number): QuestionRunRecord["live"] =>
  ({ heartbeat_at: new Date(ago(heartbeatSecondsAgo)).toISOString(), stalled, events: [] });
const run = (status: QuestionRunRecord["status"], value = live(false, 5)): Pick<QuestionRunRecord, "status" | "live"> => ({ status, live: value });

test("the page threshold is the server's", () => {
  assert.equal(STALLED_AFTER_MS, 90_000);
});

test("while the server answers, a run is stalled only when the server says so", () => {
  assert.equal(isStalled(run("running"), { now: NOW, answeredAt: ago(2), failedAt: 0 }), false);
  assert.equal(isStalled(run("running", live(true, 120)), { now: NOW, answeredAt: ago(2), failedAt: 0 }), true);
  // Just confirmed: the record says running while progress.json still holds the plan step's old heartbeat; the server does not flag it.
  assert.equal(isStalled(run("running", live(false, 3600)), { now: NOW, answeredAt: ago(2), failedAt: 0 }), false);
});

test("when the server stops answering (terminal closed, computer asleep) an active run turns stalled after the threshold", () => {
  assert.equal(isStalled(run("running"), { now: NOW, answeredAt: ago(120), failedAt: ago(1) }), true);
  assert.equal(isStalled(run("drafting"), { now: NOW, answeredAt: ago(120), failedAt: ago(1) }), true);
  assert.equal(isStalled({ status: "drafting" }, { now: NOW, answeredAt: ago(120), failedAt: ago(1) }), true);
  assert.equal(isStalled(run("running"), { now: NOW, answeredAt: ago(30), failedAt: ago(1) }), false);
});

test("queued or finished runs, and a tab that only paused polling, are not stalled", () => {
  assert.equal(isStalled(run("queued"), { now: NOW, answeredAt: ago(120), failedAt: ago(1) }), false);
  assert.equal(isStalled(run("completed"), { now: NOW, answeredAt: ago(120), failedAt: ago(1) }), false);
  // A hidden tab pauses polling: the last answer is old, but no poll has failed since.
  assert.equal(isStalled(run("running"), { now: NOW, answeredAt: ago(600), failedAt: ago(700) }), false);
});

test("the time since the last update reads as \"ago\" in each language", () => {
  const at = (seconds: number): string => new Date(ago(seconds)).toISOString();
  assert.equal(formatSince(at(12), "zh", NOW), "12 秒前");
  assert.equal(formatSince(at(300), "zh", NOW), "5 分钟前");
  assert.equal(formatSince(at(7200), "zh", NOW), "2 小时前");
  assert.equal(formatSince(at(12), "en", NOW), "12 s ago");
  assert.equal(formatSince(at(300), "en", NOW), "5 min ago");
  assert.equal(formatSince(at(7200), "en", NOW), "2 h ago");
});
