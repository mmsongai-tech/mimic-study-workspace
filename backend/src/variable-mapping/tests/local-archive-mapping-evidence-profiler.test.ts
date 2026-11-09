import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { LocalArchiveMappingEvidenceProfiler, type VariableMappingRecord } from "../index.js";

const gzipAsync = promisify(gzip);

test("profiles only aggregate evidence for frozen dictionary identifiers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "mapping-profile-")); context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "unknown-release", "hosp"); await mkdir(directory, { recursive: true });
  const rows = ["subject_id,hadm_id,itemid,valuenum,valueuom", ...Array.from({ length: 25 }, (_, index) => `${index},${index},50813,${index + 1},mmol/L`), "99,99,99999,999,mg/dL"].join("\n");
  await writeFile(join(directory, "labevents.csv.gz"), await gzipAsync(`${rows}\n`));
  const archive = join(root, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "unknown-release"], { cwd: root }).status, 0);
  const mapping: VariableMappingRecord = { schema_version: "1.0.0", mapping_id: "lactate", concept_id: "lactate", mapping_version: "1", labels: { en: "Lactate" }, synonyms: [], category: "laboratory", value_type: "continuous", definition: { summary: "Lactate", temporal_rule: "window", value_rule: "recorded", missingness_rule: "missing" }, sources: [{ kind: "dictionary_item", schema: "mimiciv_hosp", table: "labevents", columns: ["subject_id","hadm_id","itemid","valuenum","valueuom"], dictionary_table: "d_labitems", item_ids: [50813] }], status: "database_verified", provenance: "realtime_discovery", evidence: {}, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
  const profile = await new LocalArchiveMappingEvidenceProfiler(archive, () => "2026-09-08T00:00:00.000Z").profile(mapping);
  assert.equal(profile.matched_record_count, 25); assert.equal(profile.numeric?.minimum, 1); assert.equal(profile.numeric?.maximum, 25);
  assert.deepEqual(profile.units, [{ value: "mmol/L", count: 25 }]); assert.equal(profile.top_values.length, 0);
  assert.doesNotMatch(JSON.stringify(profile), /subject_id|hadm_id/u);
  await assert.rejects(new LocalArchiveMappingEvidenceProfiler(archive, () => "2026-09-08T00:00:00.000Z", 1).profile(mapping), /scan budget/u);

  const cacheDirectory=join(root,"cache");
  const persisted=await new LocalArchiveMappingEvidenceProfiler(archive,{now:()=>"2026-09-08T00:00:00.000Z",cacheDirectory}).profile(mapping);
  const reused=await new LocalArchiveMappingEvidenceProfiler(archive,{cacheDirectory,maxOnlineScanBytes:1}).profile(mapping);
  assert.deepEqual(reused,persisted);
});
