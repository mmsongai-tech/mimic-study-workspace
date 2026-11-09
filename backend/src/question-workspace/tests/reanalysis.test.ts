import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuestionRunJobService, type QuestionRunLauncher } from "../index.js";

const settle = async (jobs: QuestionRunJobService, id: string, status: string): Promise<void> => {
  for (let attempt = 0; attempt < 1000; attempt += 1) { if ((await jobs.get(id))?.status === status) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail(`run ${id} never reached ${status}; it is ${(await jobs.get(id))?.status}`);
};

test("a re-analysis carries both the chosen methods and design options to the entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "reanalysis-options-"));
  try {
    const calls: Array<Parameters<QuestionRunLauncher["launch"]>[0]> = [];
    const launcher: QuestionRunLauncher = { launch: async (input) => { calls.push(input); return { exit_code: 0, stderr: "" }; } };
    const jobs = new QuestionRunJobService({ root, launcher });
    // A completed source run — start() only checks its status, never re-drafts it. Its own draft launch must
    // settle first, so the reanalysis below is unambiguously the only call carrying `from_run`.
    const source = await jobs.start({ question: "某药与死亡" });
    await settle(jobs, source.id, "awaiting_confirmation");
    await writeFile(join(root, source.id, "status.json"), JSON.stringify({ ...source, status: "completed" }));

    const reanalysed = await jobs.start({
      question: "", reanalysis_of: source.id,
      methods: { f1: "treatment.psm" },
      options: { f1: { landmark: false, severity_on: ["Creatinine"] } },
    });
    await settle(jobs, reanalysed.id, "completed");

    const reanalysisCall = calls.find((call) => call.from_run);
    assert.ok(reanalysisCall, "the reanalysis launch must carry from_run");
    assert.equal(reanalysisCall.from_run, join(root, source.id));
    assert.deepEqual(reanalysisCall.methods, { f1: "treatment.psm" });
    assert.deepEqual(reanalysisCall.options, { f1: { landmark: false, severity_on: ["Creatinine"] } });
    // Re-analysis never touches the source run.
    assert.equal((await jobs.get(source.id))!.status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a re-analysis without design-option changes sends no options to the entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "reanalysis-no-options-"));
  try {
    const calls: Array<Parameters<QuestionRunLauncher["launch"]>[0]> = [];
    const launcher: QuestionRunLauncher = { launch: async (input) => { calls.push(input); return { exit_code: 0, stderr: "" }; } };
    const jobs = new QuestionRunJobService({ root, launcher });
    const source = await jobs.start({ question: "某药与死亡" });
    await settle(jobs, source.id, "awaiting_confirmation");
    await writeFile(join(root, source.id, "status.json"), JSON.stringify({ ...source, status: "completed" }));

    const reanalysed = await jobs.start({ question: "", reanalysis_of: source.id, methods: { f1: "treatment.psm" } });
    await settle(jobs, reanalysed.id, "completed");

    const reanalysisCall = calls.find((call) => call.from_run);
    assert.ok(reanalysisCall, "the reanalysis launch must carry from_run");
    assert.equal("options" in reanalysisCall, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
