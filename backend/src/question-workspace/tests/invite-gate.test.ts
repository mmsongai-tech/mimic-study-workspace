import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createQuestionWorkspaceServer, QuestionRunJobService, type QuestionRunLauncher } from "../index.js";

const draft = { schema_version: "1.0.0", draft_id: "question-plan:test", question: "某问题", created_at: "2026-09-25T00:00:00.000Z",
  versions: { study_spec_compiler: "1.3.0", method_registry: "1.1.0", protocol: "1.0.0", model: "test" }, data_source: { id: "simulated", version: "test" },
  frame_set: { schema_version: "1.0.0", original_question: "某问题", frames: [] }, unanswered_frames: [], model_audit: [], plans: [] };

const launcher: QuestionRunLauncher = { launch: async (input) => {
  if (input.mode === "draft") await writeFile(join(input.directory, "plan-draft.json"), JSON.stringify(draft));
  return { exit_code: 0, stderr: "" };
} };

/** Starts a real server on an ephemeral port and returns a `fetch`-like helper plus a teardown. */
const startServer = async (invite_code?: string) => {
  const root = await mkdtemp(join(tmpdir(), "invite-gate-"));
  const jobs = new QuestionRunJobService({ root, launcher });
  const server = createQuestionWorkspaceServer({ jobs, static_root: root, ...(invite_code ? { invite_code } : {}) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { headers: { "content-type": "application/json" }, ...init });
  return {
    call,
    jobs,
    close: async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); },
  };
};

test("with no invite code configured, the gate is reported off and every route works without a token", async () => {
  const { call, close } = await startServer();
  try {
    const status = await call("/api/access/status");
    assert.deepEqual(await status.json(), { gate_enabled: false });
    const list = await call("/api/runs");
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).runs, []);
    const started = await call("/api/runs", { method: "POST", body: JSON.stringify({ question: "某问题" }) });
    assert.equal(started.status, 202);
    const { id } = await started.json() as { id: string };
    // Let the background drain() finish writing before the temp directory is removed.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const record = await (await call(`/api/runs/${id}`)).json() as { status: string };
      if (record.status !== "queued" && record.status !== "drafting") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally { await close(); }
});

test("with an invite code configured, /api/runs is refused without a valid session token", async () => {
  const { call, close } = await startServer("letmein");
  try {
    assert.deepEqual(await (await call("/api/access/status")).json(), { gate_enabled: true });
    const noToken = await call("/api/runs");
    assert.equal(noToken.status, 401);
    const wrongCode = await call("/api/access", { method: "POST", body: JSON.stringify({ code: "nope" }) });
    assert.equal(wrongCode.status, 401);
    const right = await call("/api/access", { method: "POST", body: JSON.stringify({ code: "letmein" }) });
    assert.equal(right.status, 200);
    const { token } = await right.json() as { token: string };
    assert.ok(token);
    const withToken = await call("/api/runs", { headers: { "x-session-token": token } });
    assert.equal(withToken.status, 200);
  } finally { await close(); }
});

test("two sessions behind the same invite code never see each other's runs", async () => {
  const { call, close } = await startServer("letmein");
  try {
    const issue = async () => {
      const response = await call("/api/access", { method: "POST", body: JSON.stringify({ code: "letmein" }) });
      return ((await response.json()) as { token: string }).token;
    };
    const tokenA = await issue();
    const tokenB = await issue();
    assert.notEqual(tokenA, tokenB);

    const startedA = await call("/api/runs", { method: "POST", headers: { "x-session-token": tokenA }, body: JSON.stringify({ question: "问题 A" }) });
    const runA = await startedA.json() as { id: string };

    // B's list is empty; A's list has exactly its own run.
    const listB = await (await call("/api/runs", { headers: { "x-session-token": tokenB } })).json() as { runs: unknown[] };
    assert.equal(listB.runs.length, 0);
    const listA = await (await call("/api/runs", { headers: { "x-session-token": tokenA } })).json() as { runs: Array<{ id: string }> };
    assert.deepEqual(listA.runs.map((r) => r.id), [runA.id]);

    // B cannot fetch A's run directly by id — reported not found, not forbidden.
    const blocked = await call(`/api/runs/${runA.id}`, { headers: { "x-session-token": tokenB } });
    assert.equal(blocked.status, 404);
    const allowed = await call(`/api/runs/${runA.id}`, { headers: { "x-session-token": tokenA } });
    assert.equal(allowed.status, 200);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const record = await (await call(`/api/runs/${runA.id}`, { headers: { "x-session-token": tokenA } })).json() as { status: string };
      if (record.status !== "queued" && record.status !== "drafting") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally { await close(); }
});

test("a plain file/image navigation can authenticate with ?token= and is still isolated per session", async () => {
  const { call, close } = await startServer("letmein");
  try {
    const issue = async () => ((await (await call("/api/access", { method: "POST", body: JSON.stringify({ code: "letmein" }) })).json()) as { token: string }).token;
    const tokenA = await issue();
    const tokenB = await issue();
    const started = await call("/api/runs", { method: "POST", headers: { "x-session-token": tokenA }, body: JSON.stringify({ question: "问题 A" }) });
    const { id } = await started.json() as { id: string };
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const record = await (await call(`/api/runs/${id}`, { headers: { "x-session-token": tokenA } })).json() as { status: string };
      if (record.status !== "queued" && record.status !== "drafting") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const path = `/api/runs/${id}/files/plan-draft.json`;
    assert.equal((await call(path)).status, 401);
    assert.equal((await call(`${path}?token=${tokenA}`)).status, 200);
    assert.equal((await call(`${path}?token=${tokenB}`)).status, 404);
    assert.equal((await call(`${path}?token=forged`)).status, 401);
  } finally { await close(); }
});
