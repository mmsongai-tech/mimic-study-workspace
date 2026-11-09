import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GuardedRunEvidenceBundle } from "../index.js";
import { SqliteGuardedRunEvidenceRepository } from "../index.js";

const bundle = {
  artifact: {
    run_id: "run-1", integrity_id: "sha256:artifact", study: { integrity_id: "sha256:study" },
  },
  report_markdown: "# Evidence",
} as GuardedRunEvidenceBundle;

test("persists guarded aggregate evidence immutably across repository instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guarded-evidence-test-"));
  const filename = join(directory, "runs.sqlite");
  const writer = new SqliteGuardedRunEvidenceRepository(filename);
  assert.equal(await writer.save(bundle), true);
  assert.equal(await writer.save(bundle), false);
  writer.close();

  const reader = new SqliteGuardedRunEvidenceRepository(filename);
  assert.deepEqual(await reader.findByRunId("run-1"), bundle);
  reader.close();
});
