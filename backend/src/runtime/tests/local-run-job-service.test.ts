import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmedStudySpec } from "../../research-design/index.js";
import {
  PersistentLocalRunJobService,
  SqliteLocalRunJobRepository,
  type LocalRunJobExecutor,
} from "../local-run-job-service.js";

const study: ConfirmedStudySpec = {
  schema_version: "1.0.0",
  session_id: "session-1",
  revision: 1,
  confirmed_at: "2026-09-16T00:00:00.000Z",
  integrity_id: "sha256:study-1",
  spec: { schema_version: "1.0.0", intent_family: "association", research_question: "Synthetic contract question" },
};

for (const status of ["completed", "failed"] as const) {
  test(`freezes elapsed time after a job is ${status}`, async () => {
    const jobs = new SqliteLocalRunJobRepository(":memory:");
    let now = new Date("2026-09-16T00:00:00.000Z");
    const service = new PersistentLocalRunJobService({
      jobs,
      executor: { execute: async () => "unused" },
      getResult: async (id) => ({ report_id: id }),
      now: () => now,
    });
    jobs.claim("job:elapsed", study.session_id, study.integrity_id, now.toISOString());
    now = new Date("2026-09-16T00:00:05.000Z");
    assert.equal((await service.get("job:elapsed"))?.elapsed_ms, 5000);
    if (status === "completed") jobs.complete("job:elapsed", "report:one", now.toISOString());
    else jobs.fail("job:elapsed", "FAILED", "Test failure", true, now.toISOString());
    now = new Date("2026-09-16T01:00:00.000Z");
    assert.equal((await service.get("job:elapsed"))?.elapsed_ms, 5000);
    service.close();
  });
}

test("persists interruption as an explicit retryable terminal state", () => {
  const jobs = new SqliteLocalRunJobRepository(":memory:");
  const claimed = jobs.claim("job:one", study.session_id, study.integrity_id, "2026-09-16T00:00:00.000Z");
  assert.equal(claimed.record.status, "running");
  jobs.recoverInterrupted("2026-09-16T00:01:00.000Z");
  const recovered = jobs.find("job:one");
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.phase, "interrupted");
  assert.equal(recovered?.error?.code, "LOCAL_RUN_INTERRUPTED");
  assert.equal(recovered?.error?.retryable, true);
  jobs.close();
});

test("deduplicates a running job and hydrates its persisted result after completion", async () => {
  const jobs = new SqliteLocalRunJobRepository(":memory:");
  let executions = 0;
  let finish!: (id: string) => void;
  const executor: LocalRunJobExecutor = {
    execute: async (_sessionId, onPhase) => {
      executions += 1;
      onPhase("mapping_and_execution");
      return new Promise<string>((resolve) => { finish = resolve; });
    },
  };
  const service = new PersistentLocalRunJobService({
    jobs,
    executor,
    getResult: async (id) => id === "report:one" ? { report_id: id } : undefined,
    now: () => new Date("2026-09-16T00:00:10.000Z"),
    heartbeatIntervalMs: 60_000,
  });
  const first = await service.start(study);
  const duplicate = await service.start(study);
  assert.equal(first.job_id, duplicate.job_id);
  assert.equal(executions, 1);
  finish("report:one");
  await new Promise((resolve) => setImmediate(resolve));
  const completed = await service.get(first.job_id);
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.result, { report_id: "report:one" });
  service.close();
});
