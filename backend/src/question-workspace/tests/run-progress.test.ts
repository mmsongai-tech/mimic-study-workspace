import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuestionRunJobService, readRunProgress, RunProgressFile } from "../index.js";

test("writes progress events with a heartbeat and reports a silent running run as stalled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "run-progress-"));
  try {
    let now = new Date("2026-09-25T08:00:00.000Z");
    const progress = new RunProgressFile(directory, "测试问题", () => now);
    await progress.start();
    await progress.event("mapping", "f1 · started");
    const running = await readRunProgress(directory, new Date("2026-09-25T08:00:30.000Z"));
    assert.equal(running?.status, "running");
    assert.equal(running?.current?.stage, "mapping");
    assert.equal(running?.stalled, false);
    assert.equal((await readRunProgress(directory, new Date("2026-09-25T08:05:00.000Z")))?.stalled, true);
    now = new Date("2026-09-25T08:06:00.000Z");
    await progress.finish("completed");
    const finished = await readRunProgress(directory, new Date("2026-09-25T09:00:00.000Z"));
    assert.equal(finished?.status, "completed");
    assert.equal(finished?.stalled, false, "a finished run is never stalled");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("lists command-line runs with their live progress next to workspace runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-runs-"));
  const cli = await mkdtemp(join(tmpdir(), "cli-runs-"));
  try {
    await mkdir(join(cli, "formal-4-run-r5"));
    const progress = new RunProgressFile(join(cli, "formal-4-run-r5"), "降压药对心血管结局的疗效");
    await progress.start();
    await progress.event("cohort_scan", "mimiciv_hosp.prescriptions: 3,000,000 rows");
    const jobs = new QuestionRunJobService({ root, command_line_root: cli, launcher: { launch: async () => ({ exit_code: 0, stderr: "" }) } });
    const runs = await jobs.list();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.id, "cli-formal-4-run-r5");
    assert.equal(runs[0]!.source, "command_line");
    assert.equal(runs[0]!.status, "running");
    assert.match(runs[0]!.live?.current?.detail ?? "", /3,000,000 rows/u);
    assert.equal((await jobs.get("cli-formal-4-run-r5"))?.question, "降压药对心血管结局的疗效");
    await progress.finish("completed");
  } finally { await rm(root, { recursive: true, force: true }); await rm(cli, { recursive: true, force: true }); }
});
