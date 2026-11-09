import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvidenceBundle } from "../domain/run-artifact.js";
import { InMemoryRunEvidenceRepository } from "./in-memory-run-evidence-repository.js";
import { SqliteRunEvidenceRepository } from "./sqlite-run-evidence-repository.js";

const bundle = (runId: string, integrityId: string, studyIntegrityId = "sha256:study-one"): RunEvidenceBundle => ({
  artifact: {
    run_id: runId,
    integrity_id: integrityId,
    study: { integrity_id: studyIntegrityId },
  } as RunEvidenceBundle["artifact"],
  report_markdown: "synthetic aggregate report",
});

test("keeps run and integrity identifiers immutable", async () => {
  const repository = new InMemoryRunEvidenceRepository();
  assert.equal(await repository.save(bundle("run-1", "sha256:one")), true);
  assert.equal(await repository.save(bundle("run-1", "sha256:two")), false);
  assert.equal(await repository.save(bundle("run-2", "sha256:one")), false);
  assert.deepEqual(await repository.findByRunId("run-1"), bundle("run-1", "sha256:one"));
});

const verifyStudyLookup = async (repository: InMemoryRunEvidenceRepository | SqliteRunEvidenceRepository): Promise<void> => {
  const first = bundle("run-1", "sha256:run-one");
  const second = bundle("run-2", "sha256:run-two");
  const revised = bundle("run-3", "sha256:run-three", "sha256:study-two");
  await repository.save(first);
  await repository.save(second);
  await repository.save(revised);

  assert.deepEqual(await repository.findByStudyIntegrityId("sha256:study-one"), [first, second]);
  assert.deepEqual(await repository.findByStudyIntegrityId("sha256:study-two"), [revised]);
  assert.deepEqual(await repository.findByStudyIntegrityId("sha256:unknown"), []);
};

test("finds only immutable runs belonging to one confirmed study in memory", async () => {
  await verifyStudyLookup(new InMemoryRunEvidenceRepository());
});

test("finds only immutable runs belonging to one confirmed study in SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-run-study-lookup-"));
  const repository = new SqliteRunEvidenceRepository(join(directory, "runs.sqlite"));
  try {
    await verifyStudyLookup(repository);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
