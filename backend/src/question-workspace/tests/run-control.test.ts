import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuestionRunJobService, type QuestionRunLauncher } from "../index.js";

// A launcher that holds the first run open until released, so later runs stay queued.
const gatedLauncher = (): { launcher: QuestionRunLauncher; release: () => void; launched: string[] } => {
  let release = (): void => undefined; const launched: string[] = [];
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { release: () => release(), launched, launcher: { launch: async (input) => { launched.push(input.question); await gate; return { exit_code: 0, stderr: "" }; } } };
};
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

test("a run waiting in the queue can be given up and never starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-control-"));
  try {
    const { launcher, release, launched } = gatedLauncher();
    const jobs = new QuestionRunJobService({ root, launcher });
    const first = await jobs.start({ question: "first question" });
    const second = await jobs.start({ question: "second question" });
    const cancelled = await jobs.cancel(second.id);
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(jobs.cancel(first.id), /still waiting in the queue/u, "the run that is already executing is not interrupted");
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(launched, ["first question"]);
    assert.equal((await jobs.get(second.id))?.status, "cancelled");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a finished or waiting run can be deleted with its files, but not one in progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-control-"));
  try {
    const { launcher, release } = gatedLauncher();
    const jobs = new QuestionRunJobService({ root, launcher });
    const running = await jobs.start({ question: "in progress" });
    const waiting = await jobs.start({ question: "waiting" });
    await assert.rejects(jobs.remove(running.id), /in progress cannot be deleted/u);
    await jobs.remove(waiting.id);
    assert.equal(await exists(jobs.directoryOf(waiting.id)), false);
    assert.equal(await jobs.get(waiting.id), undefined);
    await assert.rejects(jobs.remove("cli-abcdef123"), /read-only/u);
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(await exists(jobs.directoryOf(running.id)), "the run in progress kept its files");
  } finally { await rm(root, { recursive: true, force: true }); }
});
