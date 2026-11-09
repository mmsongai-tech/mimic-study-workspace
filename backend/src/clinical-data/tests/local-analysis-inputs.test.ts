import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { buildCoxRecords, buildContinuousGroups, buildPredictionRecords, buildTreatmentRecords, collectManifestRows, streamArchiveRows, streamDelimitedRows } from "../index.js";
const gzipAsync = promisify(gzip);

const base = { subject_id: "stay_id", exposure: "exposed", outcome: "outcome", time_origin: "start", time_end: "end", strata: ["sex"] } as const;
const rows = [
  { stay_id: 1, exposed: true, outcome: 4, start: "2026-01-01", end: "2026-01-03", sex: "female", age: 60, respiratory_rate: 20, spo2_fio2_ratio: 200, gcs: 14, sofa: 5, lactate: 2, treatment: true },
  { stay_id: 2, exposed: false, outcome: 2, start: "2026-01-01", end: "2026-01-02", sex: "male", age: 55, respiratory_rate: 18, spo2_fio2_ratio: 250, gcs: 15, sofa: 3, lactate: 1, treatment: false },
  { stay_id: 3, exposed: true, outcome: 1, start: "2026-01-01", end: "2025-12-31", sex: "female", age: 70, respiratory_rate: 25, spo2_fio2_ratio: 180, gcs: 12, sofa: 7, lactate: 4, treatment: true },
];

test("streams extracted CSV.GZ rows without loading the table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-local-stream-")); const filename = join(directory, "table.csv.gz");
  try { await writeFile(filename, await gzipAsync("stay_id,exposed,outcome\n1,true,1\n2,false,0\n")); const streamed = []; for await (const row of streamDelimitedRows(filename)) streamed.push(row); assert.deepEqual(streamed, [{ stay_id: "1", exposed: "true", outcome: "1" }, { stay_id: "2", exposed: "false", outcome: "0" }]); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects unsafe archive members before starting a subprocess", async () => {
  await assert.rejects(async () => { for await (const _row of streamArchiveRows("/missing.zip", "../etc/passwd")) { /* unreachable */ } }, /relative CSV.GZ archive members/u);
});

test("completes when an archive subprocess exits before row consumption finishes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-local-archive-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "mimic-iv-3.1", "hosp"); await mkdir(memberDirectory, { recursive: true });
  await writeFile(join(memberDirectory, "small.csv.gz"), await gzipAsync("id,value\n1,a\n"));
  const archive = join(directory, "small.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "mimic-iv-3.1"], { cwd: directory }).status, 0);
  const rows = []; for await (const row of streamArchiveRows(archive, "mimic-iv-3.1/hosp/small.csv.gz")) rows.push(row);
  assert.deepEqual(rows, [{ id: "1", value: "a" }]);
});

test("filters reversed windows and preserves stratum quality counts", async () => {
  const result = await collectManifestRows(rows, base);
  assert.equal(result.quality.rows_seen, 3);
  assert.equal(result.quality.complete_rows, 2);
  assert.equal(result.quality.exclusion_reasons.time_window_reversed, 1);
  assert.equal(result.quality.strata_counts.female, 1);
});

test("converts the same local rows into continuous and survival inputs", async () => {
  const continuous = await buildContinuousGroups(rows, base);
  assert.equal(continuous.groups.exposed.n, 1);
  assert.equal(continuous.groups.unexposed.n, 1);
  const survival = await buildCoxRecords([{ ...rows[0], outcome: true, duration: 3 }, { ...rows[1], outcome: false, duration: 2 }], { subject_id: base.subject_id, exposure: base.exposure, outcome: base.outcome, time_end: "duration", strata: base.strata });
  assert.equal(survival.records.length, 2);
});

test("converts predictor and treatment manifests while excluding incomplete records", async () => {
  const prediction = await buildPredictionRecords(rows, { ...base, outcome: "ventilated", predictors: { age: "age", respiratory_rate: "respiratory_rate", spo2_fio2_ratio: "spo2_fio2_ratio", gcs: "gcs" } });
  assert.equal(prediction.records.length, 0);
  const treatment = await buildTreatmentRecords(rows.map((row) => ({ ...row, outcome: row.exposed, sex: row.sex })), { ...base, treatment: "treatment", predictors: { age: "age", sofa_score: "sofa", baseline_lactate: "lactate", sex: "sex" } });
  assert.equal(treatment.records.length, 2);
});
