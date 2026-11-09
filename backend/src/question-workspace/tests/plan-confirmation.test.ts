import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuestionRunJobService, type QuestionRunLauncher } from "../index.js";

// A draft with one runnable plan offering two methods (the launcher stands in for the entrypoint).
const draft = { schema_version: "1.0.0", draft_id: "question-plan:test", question: "某药与死亡", created_at: "2026-09-25T00:00:00.000Z",
  versions: { study_spec_compiler: "1.3.0", method_registry: "1.1.0", protocol: "1.0.0", model: "test" }, data_source: { id: "simulated", version: "test" },
  frame_set: { schema_version: "1.0.0", original_question: "某药与死亡", frames: [] }, unanswered_frames: [], model_audit: [],
  plans: [{ plan: { plan_id: "f1", frame_id: "f1", study_spec: { schema_version: "1.0.0", intent_family: "treatment_effect" }, roles: { mediators: [], modifiers: [], default_covariates: [] } }, status: "ready", manifest: { manifest_id: "m1" }, mapping: [],
    method_options: [{ method_id: "treatment.iptw" }, { method_id: "regression.adjusted" }], default_method: "treatment.iptw", protocol: { protocol_version: "1.0.0", elements: [], design_checks: [] } }] };

const launcher = (calls: Array<Parameters<QuestionRunLauncher["launch"]>[0]>): QuestionRunLauncher => ({ launch: async (input) => {
  calls.push(input);
  if (input.mode === "draft") await writeFile(join(input.directory, "plan-draft.json"), JSON.stringify(draft));
  return { exit_code: 0, stderr: "" };
} });
const settle = async (jobs: QuestionRunJobService, id: string, status: string): Promise<void> => {
  // Up to 10 s: the suite can run while a real analysis keeps the machine busy.
  for (let attempt = 0; attempt < 1000; attempt += 1) { if ((await jobs.get(id))?.status === status) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail(`run ${id} never reached ${status}; it is ${(await jobs.get(id))?.status}`);
};

test("drafts first, waits for confirmation, then runs exactly the locked plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-confirmation-"));
  try {
    const calls: Array<Parameters<QuestionRunLauncher["launch"]>[0]> = [];
    const jobs = new QuestionRunJobService({ root, launcher: launcher(calls) });
    const record = await jobs.start({ question: "某药与死亡" });
    await settle(jobs, record.id, "awaiting_confirmation");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.mode, "draft");
    assert.equal((await jobs.plan(record.id))?.draft_id, "question-plan:test");
    await assert.rejects(jobs.confirm(record.id, { methods: { f1: "survival.cox" } }), /not one of the methods/u);

    const confirmed = await jobs.confirm(record.id, { methods: { f1: "regression.adjusted" } });
    assert.match(confirmed.lock_id ?? "", /^plan-lock:sha256:/u);
    await settle(jobs, record.id, "completed");
    assert.equal(calls[1]!.mode, "locked");
    const locked = JSON.parse(await readFile(calls[1]!.locked_file!, "utf8")) as { lock_id: string; confirmed_by: string; choices: { methods: Record<string, string> } };
    assert.equal(locked.lock_id, confirmed.lock_id);
    assert.equal(locked.confirmed_by, "user");
    assert.deepEqual(locked.choices.methods, { f1: "regression.adjusted" });
    await assert.rejects(jobs.confirm(record.id, {}), /awaiting confirmation/u, "a completed run cannot be confirmed again");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("auto-confirm locks the recommended methods and runs without waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-auto-confirm-"));
  try {
    const calls: Array<Parameters<QuestionRunLauncher["launch"]>[0]> = [];
    const jobs = new QuestionRunJobService({ root, launcher: launcher(calls) });
    const record = await jobs.start({ question: "某药与死亡", auto_confirm: true });
    await settle(jobs, record.id, "completed");
    assert.deepEqual(calls.map(({ mode }) => mode), ["draft", "locked"]);
    assert.equal((await jobs.get(record.id))?.confirmed_by, "automatic");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resumes unfinished runs after a restart: drafts are drafted again, confirmed runs run from their lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-resume-"));
  try {
    const hold: QuestionRunLauncher = { launch: () => new Promise(() => undefined) };
    const before = new QuestionRunJobService({ root, launcher: hold });
    const drafting = await before.start({ question: "某药与死亡" });
    const waiting = await before.start({ question: "另一个问题" });
    // Simulate a confirmed run that was running when the server stopped.
    await writeFile(join(root, waiting.id, "status.json"), JSON.stringify({ ...waiting, status: "running", lock_id: "plan-lock:sha256:x" }));
    const calls: Array<Parameters<QuestionRunLauncher["launch"]>[0]> = [];
    const after = new QuestionRunJobService({ root, launcher: launcher(calls) });
    await after.recover();
    await settle(after, waiting.id, "completed");
    await settle(after, drafting.id, "awaiting_confirmation");
    assert.deepEqual(calls.map(({ mode, directory }) => [mode, directory.endsWith(waiting.id) ? "confirmed" : "draft"]).sort(), [["draft", "draft"], ["locked", "confirmed"]]);
    assert.ok((await after.get(drafting.id))!.progress.some(({ stage }) => stage === "resumed"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("run without review still completes with a report when no analysis can run", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-unrunnable-"));
  try {
    const blocked = { ...draft, plans: [{ ...draft.plans[0], status: "blocked", manifest: undefined, blocked_outcome: { plan_id: "f1", frame_id: "f1", status: "blocked", stage_reached: "mapping", blockers: [] } }] };
    const calls: Array<Parameters<QuestionRunLauncher["launch"]>[0]> = [];
    const jobs = new QuestionRunJobService({ root, launcher: { launch: async (input) => { calls.push(input); if (input.mode === "draft") await writeFile(join(input.directory, "plan-draft.json"), JSON.stringify(blocked)); return { exit_code: 0, stderr: "" }; } } });
    const record = await jobs.start({ question: "某药与死亡", auto_confirm: true });
    await settle(jobs, record.id, "completed");
    assert.deepEqual(calls.map(({ mode }) => mode), ["draft", "locked"], "the locked run writes the report of why nothing could run");
    await assert.rejects(new QuestionRunJobService({ root, launcher: { launch: async () => ({ exit_code: 0, stderr: "" }) } }).confirm(record.id, {}), /awaiting confirmation/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("records the run's result summary once it completes, so the run list can tell a blocked run from a usable one", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-summary-"));
  try {
    const jobs = new QuestionRunJobService({ root, launcher: { launch: async (input) => {
      if (input.mode === "draft") { await writeFile(join(input.directory, "plan-draft.json"), JSON.stringify(draft)); return { exit_code: 0, stderr: "" }; }
      // The locked run's own entrypoint writes run.json before exiting; the job service never computes this itself.
      await writeFile(join(input.directory, "run.json"), JSON.stringify({ summary: { frames: 1, plans: 1, completed: 0, blocked: 1, failed: 0, needs_clarification: 0 } }));
      return { exit_code: 0, stderr: "" };
    } } });
    const record = await jobs.start({ question: "某药与死亡", auto_confirm: true });
    await settle(jobs, record.id, "completed");
    assert.deepEqual((await jobs.get(record.id))?.result_summary, { completed: 0, plans: 1 });
    // The run list reads status.json directly rather than re-parsing every run.json, so the summary must persist there.
    const persisted = JSON.parse(await readFile(join(root, record.id, "status.json"), "utf8")) as { result_summary?: unknown };
    assert.deepEqual(persisted.result_summary, { completed: 0, plans: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("leaves result_summary unset when a run completes without a readable run.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-summary-missing-"));
  try {
    const jobs = new QuestionRunJobService({ root, launcher: launcher([]) });
    const record = await jobs.start({ question: "某药与死亡", auto_confirm: true });
    await settle(jobs, record.id, "completed");
    assert.equal((await jobs.get(record.id))?.result_summary, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("records the cause of a crashed run, not its trailer, and says it is not a result", async () => {
  const { crashedAtStartup, mergeStderr } = await import("../index.js");
  const crash = "\n<--- Last few GCs --->\n[19308:0x1] 4103 ms: Mark-Compact 4090.5 (4132.0) -> 4088.2 MB\n\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n 1: 0x1 node::Abort()\n 2: 0x2 ...\n\nNode.js v26.7.0\n";
  assert.equal(crashedAtStartup(crash), true);
  assert.equal(crashedAtStartup("Study framing failed at study_frame_extraction.\n"), false);
  assert.equal(mergeStderr("abcdef", "cdef"), "abcdef", "an overlapping tail is not repeated");
  assert.equal(mergeStderr("abc", "xyz"), "abc\n…\nxyz");
  const root = await mkdtemp(join(tmpdir(), "plan-crash-"));
  try {
    const jobs = new QuestionRunJobService({ root, launcher: { launch: async (input) => {
      if (input.mode === "draft") { await writeFile(join(input.directory, "plan-draft.json"), JSON.stringify(draft)); return { exit_code: 0, stderr: "" }; }
      return { exit_code: 134, stderr: crash };
    } } });
    const record = await jobs.start({ question: "某药与死亡", auto_confirm: true });
    await settle(jobs, record.id, "failed");
    const error = (await jobs.get(record.id))!.error!;
    assert.match(error, /heap out of memory/u);
    assert.match(error, /not a result/u);
    assert.doesNotMatch(error, /^Node\.js v/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
