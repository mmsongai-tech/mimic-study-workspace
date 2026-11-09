import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type { ClinicalDatabaseCatalog } from "../../clinical-database/index.js";
import { compileExecutionManifest, type ExecutionManifest } from "../../execution-manifest/index.js";
import type { StudyVariableMappingReview, VariableMappingRecord } from "../../variable-mapping/index.js";
import { LocalExecutionGraphRunner } from "../index.js";

const gzipAsync = promisify(gzip);

test("executes a ready direct-field graph deterministically from a local archive", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-graph-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "release", "hosp"); await mkdir(memberDirectory, { recursive: true });
  await writeFile(join(memberDirectory, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,exposed,hospital_expire_flag,gender\n1,10,1,1,M\n2,20,0,0,F\n3,30,,1,F\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:test", study_integrity_id: "sha256:test", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: "mimiciv_hosp.admissions", column: "hadm_id" }, sources: [{ id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp", table: "admissions", required_columns: ["subject_id", "hadm_id", "exposed", "hospital_expire_flag", "gender"] }], joins: [], variables: [
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "admission", missingness_rule: "exclude", contrast: { kind: "binary_presence" } },
    { role: "covariate", condition_id: "cov-sex", requested_label: "sex", mapping_id: "sex", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "categorical", value_rule: { kind: "direct", column: "gender" }, effect_modifier: true, temporal_rule: "baseline", missingness_rule: "exclude" },
  ], time_windows: [], blockers: [] };
  const runner = new LocalExecutionGraphRunner(); const first = await runner.run(archive, manifest); const second = await runner.run(archive, manifest);
  assert.deepEqual(first.rows, [{ analysis_id: "10", exposure: true, outcome: true, effect_modifier_0: "M" }, { analysis_id: "20", exposure: false, outcome: false, effect_modifier_0: "F" }]);
  assert.equal(first.quality.analysis_units, 3); assert.equal(first.quality.complete_rows, 2); assert.equal(first.quality.excluded_rows, 1); assert.equal(first.cohort_integrity_id, second.cohort_integrity_id);
});

test("retains unexposed analysis units for reviewed binary record-presence variables", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-presence-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "release", "hosp"); await mkdir(memberDirectory, { recursive: true });
  await writeFile(join(memberDirectory, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,hospital_expire_flag\n1,10,1\n2,20,0\n3,30,0\n"));
  await writeFile(join(memberDirectory, "prescriptions.csv.gz"), await gzipAsync("subject_id,hadm_id,drug\n1,10,Target medicine\n2,20,Another medicine\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:presence", study_integrity_id: "sha256:presence", data_model: "MIMIC-IV", study_family: "treatment_effect", status: "ready", analysis_unit: { source_id: "mimiciv_hosp.admissions", column: "hadm_id" }, sources: [
    { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp", table: "admissions", required_columns: ["subject_id", "hadm_id", "hospital_expire_flag"] },
    { id: "mimiciv_hosp.prescriptions", schema: "mimiciv_hosp", table: "prescriptions", required_columns: ["subject_id", "hadm_id", "drug"] },
  ], joins: [{ left_source_id: "mimiciv_hosp.admissions", right_source_id: "mimiciv_hosp.prescriptions", left_column: "hadm_id", right_column: "hadm_id", cardinality: "many_to_one" }], variables: [
    { role: "exposure", condition_id: "exposure.recorded", semantic_condition: { condition_id: "exposure.recorded", source_text: "recorded target medicine", kind: "event_exists", concept: "target medicine", occurrence: "present" }, requested_label: "target medicine", mapping_id: "medicine", mapping_version: "1", source_id: "mimiciv_hosp.prescriptions", value_type: "binary", value_rule: { kind: "matching_values", column: "drug", values: ["Target medicine"] }, aggregation: "any", temporal_rule: "encounter", missingness_rule: "No matching reviewed record means no recorded exposure." },
    { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "encounter", missingness_rule: "exclude", contrast: { kind: "binary_presence" } },
  ], time_windows: [], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows, [
    { analysis_id: "10", exposure: true, outcome: true },
    { analysis_id: "20", exposure: false, outcome: false },
    { analysis_id: "30", exposure: false, outcome: false },
  ]);
  assert.equal(result.quality.complete_rows, 3);
  assert.equal(result.quality.excluded_rows, 0);
});

test("evaluates every leaf of a compound population predicate", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-condition-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "release-next", "hosp"); await mkdir(memberDirectory, { recursive: true });
  await writeFile(join(memberDirectory, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,age,ventilated,exposed,hospital_expire_flag\n1,10,70,1,1,1\n2,20,17,1,1,0\n3,30,65,0,0,1\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release-next"], { cwd: directory }).status, 0);
  const source = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "age", "ventilated", "exposed", "hospital_expire_flag"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:conditions", study_integrity_id: "sha256:test", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: source.id, column: "hadm_id" }, sources: [source], joins: [], population_predicate: { condition_id: "population.all", source_text: "ventilated adults", kind: "all", operands: [
    { condition_id: "population.adult", source_text: "adult", kind: "numeric_comparison", concept: "age", operator: "gte", value: 18 },
    { condition_id: "population.ventilation", source_text: "ventilated", kind: "event_exists", concept: "ventilation", occurrence: "present" },
  ] }, variables: [
    { role: "population", condition_id: "population.adult", requested_label: "age", mapping_id: "age", mapping_version: "1", source_id: source.id, value_type: "continuous", value_rule: { kind: "direct", column: "age" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "population", condition_id: "population.ventilation", requested_label: "ventilation", mapping_id: "ventilation", mapping_version: "1", source_id: source.id, value_type: "binary", value_rule: { kind: "direct", column: "ventilated" }, temporal_rule: "admission", missingness_rule: "absent" },
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: source.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: source.id, value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "admission", missingness_rule: "exclude" },
  ], time_windows: [], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows, [{ analysis_id: "10", exposure: true, outcome: true }]);
  assert.equal(result.quality.excluded_rows, 2);
});

test("executes a fixed measurement difference across baseline and follow-up windows", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-derived-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const hosp = join(directory, "release", "hosp"); const icu = join(directory, "release", "icu"); await mkdir(hosp, { recursive: true }); await mkdir(icu, { recursive: true });
  await writeFile(join(hosp, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,exposed\n1,10,2026-01-02T00:00:00Z,1\n"));
  await writeFile(join(icu, "chartevents.csv.gz"), await gzipAsync("subject_id,hadm_id,itemid,charttime,valuenum\n1,10,42,2026-01-01T12:00:00Z,100\n1,10,42,2026-01-03T12:00:00Z,90\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:derived", study_integrity_id: "sha256:test", data_model: "MIMIC-IV", study_family: "treatment_effect", status: "ready", analysis_unit: { source_id: "mimiciv_hosp.admissions", column: "hadm_id" }, sources: [{ id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp", table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "exposed"] }, { id: "mimiciv_icu.chartevents", schema: "mimiciv_icu", table: "chartevents", required_columns: ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"] }], joins: [{ left_source_id: "mimiciv_hosp.admissions", right_source_id: "mimiciv_icu.chartevents", left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" }], variables: [{ role: "index_time", requested_label: "admission", mapping_id: "index", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "date_time", value_rule: { kind: "direct", column: "admittime" }, temporal_rule: "admission", missingness_rule: "exclude" }, { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" }, { role: "outcome", requested_label: "change", mapping_id: "change", mapping_version: "1", source_id: "mimiciv_icu.chartevents", value_type: "continuous", value_rule: { kind: "item_ids", id_column: "itemid", ids: [42], value_column: "valuenum" }, time_column: "charttime", temporal_rule: "two windows", derivation: { schema_version: "1.0.0", operator: "difference", baseline: { purpose: "baseline", aggregation: "first" }, follow_up: { purpose: "follow_up", aggregation: "first" }, direction: "baseline_minus_follow_up" }, missingness_rule: "exclude" }], time_windows: [{ purpose: "baseline", anchor: "index_time", start_offset: -1, end_offset: 0, unit: "day" }, { purpose: "follow_up", anchor: "index_time", start_offset: 1, end_offset: 2, unit: "day" }], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows, [{ analysis_id: "10", exposure: true, outcome: 10 }]);
});

test("keeps descriptive cohorts without an exposure and reports which column holds each variable", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-descriptive-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "release", "hosp"); await mkdir(memberDirectory, { recursive: true });
  await writeFile(join(memberDirectory, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,hospital_expire_flag,gender\n1,10,1,M\n2,20,0,F\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const source = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "hospital_expire_flag", "gender"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:descriptive", study_integrity_id: "sha256:descriptive", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: source.id, column: "hadm_id" }, sources: [source], joins: [], variables: [
    { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: source.id, value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "covariate", requested_label: "Sex", mapping_id: "sex", mapping_version: "1", source_id: source.id, value_type: "categorical", value_rule: { kind: "direct", column: "gender" }, temporal_rule: "baseline", missingness_rule: "exclude" },
  ], time_windows: [], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows, [{ analysis_id: "10", outcome: true, covariate_0: "M" }, { analysis_id: "20", outcome: false, covariate_0: "F" }]);
  assert.deepEqual(result.columns?.map(({ column, requested_label }) => [column, requested_label]), [["outcome", "death"], ["covariate_0", "Sex"]]);
});

test("keeps each patient's first eligible admission and derives follow-up time from the date of death", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-survival-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "release", "hosp"); await mkdir(memberDirectory, { recursive: true });
  // Patient 1: two admissions, dies 10 days after the first. Patient 2: survives. Patient 3: dies on the admission day. Patient 4: dies after the horizon.
  await writeFile(join(memberDirectory, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,dischtime,exposed\n1,11,2150-01-01 08:00:00,2150-01-05 10:00:00,1\n1,12,2150-01-08 08:00:00,2150-01-09 10:00:00,0\n2,21,2150-02-01 08:00:00,2150-02-03 10:00:00,0\n3,31,2150-03-01 08:00:00,2150-03-01 20:00:00,1\n4,41,2150-04-01 08:00:00,2150-04-02 08:00:00,0\n"));
  await writeFile(join(memberDirectory, "patients.csv.gz"), await gzipAsync("subject_id,dod\n1,2150-01-11\n2,\n3,2150-03-01\n4,2150-06-01\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "dischtime", "exposed"] };
  const patients = { id: "mimiciv_hosp.patients", schema: "mimiciv_hosp" as const, table: "patients", required_columns: ["subject_id", "dod"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:survival", study_integrity_id: "sha256:survival", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, patients], joins: [{ left_source_id: admissions.id, right_source_id: patients.id, left_column: "subject_id", right_column: "subject_id", cardinality: "many_to_one" }], variables: [
    { role: "index_time", requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: admissions.id, value_type: "categorical", value_rule: { kind: "direct", column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "All-cause death", mapping_id: "death", mapping_version: "1", source_id: patients.id, value_type: "binary", value_rule: { kind: "direct", column: "dod" }, time_column: "dod", contrast: { kind: "binary_presence" }, aggregation: "first", temporal_rule: "death", missingness_rule: "alive" },
  ], time_windows: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 30, unit: "day" }], extraction: { unit_selection: "first_per_subject", outcome_timing: { kind: "time_to_event", horizon_days: 30, follow_up: "death_registry" } }, blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  const byId = Object.fromEntries(result.rows.map((row) => [row.analysis_id, row]));
  assert.deepEqual(Object.keys(byId).sort(), ["11", "21", "31", "41"]);
  assert.equal(result.quality.exclusion_reasons.not_first_eligible_unit_of_patient, 1);
  assert.equal(byId["11"]!.event, 1); assert.ok(Math.abs(Number(byId["11"]!.time) - 10.66) < 0.01);
  assert.equal(byId["21"]!.event, 0); assert.equal(byId["21"]!.time, 30); assert.equal(byId["21"]!.outcome, false);
  assert.equal(byId["31"]!.event, 1); assert.ok(Number(byId["31"]!.time) > 0 && Number(byId["31"]!.time) < 1);
  assert.equal(byId["41"]!.event, 0); assert.equal(byId["41"]!.time, 30);
});

test("applies the study outcome window to event outcomes that carry no window of their own", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-window-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "release", "hosp"); await mkdir(memberDirectory, { recursive: true });
  await writeFile(join(memberDirectory, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,dischtime,exposed\n1,11,2150-01-01 08:00:00,2150-01-05 10:00:00,1\n2,21,2150-02-01 08:00:00,2150-02-03 10:00:00,0\n"));
  await writeFile(join(memberDirectory, "patients.csv.gz"), await gzipAsync("subject_id,dod\n1,2150-01-03\n2,2150-09-01\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "dischtime", "exposed"] };
  const patients = { id: "mimiciv_hosp.patients", schema: "mimiciv_hosp" as const, table: "patients", required_columns: ["subject_id", "dod"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:window", study_integrity_id: "sha256:window", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, patients], joins: [{ left_source_id: admissions.id, right_source_id: patients.id, left_column: "subject_id", right_column: "subject_id", cardinality: "many_to_one" }], variables: [
    { role: "index_time", requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: admissions.id, value_type: "categorical", value_rule: { kind: "direct", column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", condition_id: "outcome.target", semantic_condition: { condition_id: "outcome.target", source_text: "death", kind: "event_exists", concept: "death", occurrence: "present" }, requested_label: "All-cause death", mapping_id: "death", mapping_version: "1", source_id: patients.id, value_type: "binary", value_rule: { kind: "direct", column: "dod" }, time_column: "dod", contrast: { kind: "binary_presence" }, temporal_rule: "death", missingness_rule: "alive" },
  ], time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  // Patient 2 died seven months after discharge, outside the in-encounter window.
  assert.deepEqual(result.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome]), [["11", true], ["21", false]]);
});

test("counts a date-only death on the discharge day as within the encounter", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-discharge-day-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "release", "hosp"); await mkdir(memberDirectory, { recursive: true });
  // The patient dies in hospital at 14:00; patients.dod carries only the date.
  await writeFile(join(memberDirectory, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,dischtime,exposed\n1,11,2150-01-01 08:00:00,2150-01-05 14:00:00,1\n"));
  await writeFile(join(memberDirectory, "patients.csv.gz"), await gzipAsync("subject_id,dod\n1,2150-01-05\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "dischtime", "exposed"] };
  const patients = { id: "mimiciv_hosp.patients", schema: "mimiciv_hosp" as const, table: "patients", required_columns: ["subject_id", "dod"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:discharge-day", study_integrity_id: "sha256:discharge-day", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, patients], joins: [{ left_source_id: admissions.id, right_source_id: patients.id, left_column: "subject_id", right_column: "subject_id", cardinality: "many_to_one" }], variables: [
    { role: "index_time", requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: admissions.id, value_type: "categorical", value_rule: { kind: "direct", column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "All-cause death", mapping_id: "death", mapping_version: "1", source_id: patients.id, value_type: "binary", value_rule: { kind: "direct", column: "dod" }, time_column: "dod", contrast: { kind: "binary_presence" }, temporal_rule: "death", missingness_rule: "alive" },
  ], time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.equal(result.rows[0]?.outcome, true);
});

test("with an ICU index, in-hospital death is followed to hospital discharge, not to ICU discharge", async (context) => {
  // 2026-10-27: 3.3 (first-day SOFA and in-hospital death) bounded the outcome by the ICU stay's outtime, so a death on the ward after
  // ICU discharge was counted as survival (in-hospital death 7.6%).
  const directory = await mkdtemp(join(tmpdir(), "mimic-icu-in-hospital-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true }); await mkdir(join(directory, "release", "icu"), { recursive: true });
  // Synthetic. 1: dies in the ICU; 2: leaves the ICU on day 3 and dies on the ward on day 6; 3: survives; 4: dies a week after a later admission;
  // 5: dies in hospital with the death time recorded five hours after the discharge time (as MIMIC-IV records for some in-hospital deaths).
  await writeFile(join(directory, "release", "icu", "icustays.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,intime,outtime,sofa\n1,11,101,2150-01-01 08:00:00,2150-01-02 08:00:00,9\n2,21,201,2150-02-01 08:00:00,2150-02-03 08:00:00,6\n3,31,301,2150-03-01 08:00:00,2150-03-02 08:00:00,2\n4,41,401,2150-04-01 08:00:00,2150-04-02 08:00:00,4\n5,51,501,2150-06-01 08:00:00,2150-06-03 08:00:00,7\n"));
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,dischtime,deathtime,hospital_expire_flag\n1,11,2150-01-02 07:00:00,2150-01-02 07:00:00,1\n2,21,2150-02-06 09:00:00,2150-02-06 09:00:00,1\n3,31,2150-03-08 09:00:00,,0\n4,41,2150-04-05 09:00:00,,0\n4,42,2150-05-10 09:00:00,2150-05-10 09:00:00,1\n5,51,2150-06-04 00:00:00,2150-06-04 05:00:00,1\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const icustays = { id: "mimiciv_icu.icustays", schema: "mimiciv_icu" as const, table: "icustays", required_columns: ["subject_id", "hadm_id", "stay_id", "intime", "outtime", "sofa"] };
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "dischtime", "deathtime", "hospital_expire_flag"] };
  const manifest = (survival: boolean): ExecutionManifest => ({ schema_version: "2.0.0", manifest_id: `manifest:icu-in-hospital-${survival}`, study_integrity_id: "sha256:icu-in-hospital", data_model: "MIMIC-IV", study_family: "association", status: "ready",
    analysis_unit: { source_id: icustays.id, column: "stay_id" }, sources: [icustays, admissions],
    joins: [{ left_source_id: icustays.id, right_source_id: admissions.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "many_to_one" }], variables: [
    { role: "index_time", requested_label: "ICU admission", mapping_id: "icu", mapping_version: "1", source_id: icustays.id, value_type: "categorical", value_rule: { kind: "direct", column: "intime" }, time_column: "intime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "exposure", requested_label: "SOFA", mapping_id: "sofa", mapping_version: "1", source_id: icustays.id, value_type: "continuous", value_rule: { kind: "direct", column: "sofa" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "In-hospital death", mapping_id: "death", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, time_column: "deathtime", contrast: { kind: "binary_presence" }, temporal_rule: "Outcome is attached to the eligible hospital admission.", missingness_rule: "absent" },
  ], time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }],
    extraction: { unit_selection: "first_per_subject", ...(survival ? { outcome_timing: { kind: "time_to_event" as const, horizon_days: 30, follow_up: "encounter" as const } } : {}) }, blockers: [] });
  const [binary, timed] = await new LocalExecutionGraphRunner().runMany(archive, [manifest(false), manifest(true)]);
  assert.deepEqual(binary!.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome ?? false]), [["101", true], ["201", true], ["301", false], ["401", false], ["501", true]], "the ward death after ICU discharge is an in-hospital death, so is a death timed after the discharge time; a death in a later admission is not");
  const byId = Object.fromEntries(timed!.rows.map((row) => [row.analysis_id, row]));
  assert.equal(byId["201"]!.event, 1, "the ward death on day 5 is an event, not censored at ICU discharge on day 2");
  assert.equal(byId["501"]!.event, 1, "a death timed after the discharge time is still an event");
  // Censored at the end of the hospital discharge day (7 days 16 hours after ICU admission), not at ICU discharge (1 day 16 hours).
  assert.ok(Math.abs(Number(byId["301"]!.time) - (7 + 16 / 24)) < 1e-6, `a survivor is censored at hospital discharge (time ${byId["301"]!.time})`);
});

test("time-to-event follow-up counts events and censors event-free units at the same end", async (context) => {
  // Review of bab8ffe: counting events to the horizon while event-free units were censored at the index encounter's end inflated event
  // rates, and an outcome read from ICU-stay rows cut a hospital admission's follow-up short at ICU discharge.
  const directory = await mkdtemp(join(tmpdir(), "mimic-follow-up-end-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true }); await mkdir(join(directory, "release", "icu"), { recursive: true });
  // ICU index, outcome from a table without an encounter end. 1: event on the ward on day 3 after ICU discharge on day 1; 2: no event.
  await writeFile(join(directory, "release", "icu", "icustays.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,intime,outtime,exposed\n1,11,101,2150-01-01 08:00:00,2150-01-02 08:00:00,1\n2,21,201,2150-02-01 08:00:00,2150-02-02 08:00:00,0\n"));
  await writeFile(join(directory, "release", "hosp", "labevents.csv.gz"), await gzipAsync("subject_id,hadm_id,itemid,charttime,valuenum\n1,11,1,2150-01-04 08:00:00,5\n"));
  // Hospital index, outcome from ICU-stay rows (flagged or not). 3: an ICU stay on days 2-3 without the event, discharged on day 8.
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,dischtime,exposed\n3,31,2150-03-01 08:00:00,2150-03-08 08:00:00,1\n"));
  await writeFile(join(directory, "release", "icu", "flagged.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,intime,outtime,flag\n3,31,301,2150-03-02 08:00:00,2150-03-03 08:00:00,0\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const timing = { unit_selection: "first_per_subject" as const, outcome_timing: { kind: "time_to_event" as const, horizon_days: 7, follow_up: "encounter" as const } };
  const icustays = { id: "mimiciv_icu.icustays", schema: "mimiciv_icu" as const, table: "icustays", required_columns: ["subject_id", "hadm_id", "stay_id", "intime", "outtime", "exposed"] };
  const labs = { id: "mimiciv_hosp.labevents", schema: "mimiciv_hosp" as const, table: "labevents", required_columns: ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"] };
  const icu: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:icu-lab-survival", study_integrity_id: "sha256:icu-lab-survival", data_model: "MIMIC-IV", study_family: "association", status: "ready",
    analysis_unit: { source_id: icustays.id, column: "stay_id" }, sources: [icustays, labs], joins: [{ left_source_id: icustays.id, right_source_id: labs.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "many_to_one" }], variables: [
    { role: "index_time", requested_label: "ICU admission", mapping_id: "icu", mapping_version: "1", source_id: icustays.id, value_type: "categorical", value_rule: { kind: "direct", column: "intime" }, time_column: "intime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: icustays.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "lab event", mapping_id: "lab", mapping_version: "1", source_id: labs.id, value_type: "binary", value_rule: { kind: "item_ids", id_column: "itemid", ids: [1], value_column: "valuenum" }, time_column: "charttime", contrast: { kind: "binary_presence" }, aggregation: "any", temporal_rule: "event", missingness_rule: "absent" },
  ], time_windows: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 7, unit: "day" }], extraction: timing, blockers: [] };
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "dischtime", "exposed"] };
  const flagged = { id: "mimiciv_icu.flagged", schema: "mimiciv_icu" as const, table: "flagged", required_columns: ["subject_id", "hadm_id", "stay_id", "intime", "outtime", "flag"] };
  const hospital: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:hospital-icu-row-survival", study_integrity_id: "sha256:hospital-icu-row-survival", data_model: "MIMIC-IV", study_family: "association", status: "ready",
    analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, flagged], joins: [{ left_source_id: admissions.id, right_source_id: flagged.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "many_to_one" }], variables: [
    { role: "index_time", requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: admissions.id, value_type: "categorical", value_rule: { kind: "direct", column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "flagged ICU stay", mapping_id: "flag", mapping_version: "1", source_id: flagged.id, value_type: "binary", value_rule: { kind: "direct", column: "flag" }, time_column: "intime", contrast: { kind: "binary_presence" }, temporal_rule: "event", missingness_rule: "absent" },
  ], time_windows: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 7, unit: "day" }], extraction: timing, blockers: [] };
  const [icuResult, hospitalResult] = await new LocalExecutionGraphRunner().runMany(archive, [icu, hospital]);
  const icuRows = Object.fromEntries(icuResult!.rows.map((row) => [row.analysis_id, row]));
  assert.equal(icuRows["101"]!.event, 0, "an event after follow-up ends is not counted, as an event-free unit is censored there");
  assert.equal(icuRows["101"]!.time, icuRows["201"]!.time, "both are followed to the end of the ICU discharge day");
  // 2150-03-08 08:00 discharge: censored at the end of that day, 7 days 16 hours after admission, capped at the 7-day horizon.
  assert.equal(hospitalResult!.rows[0]!.time, 7, "an ICU-stay row does not cut a hospital admission's follow-up short");
});

test("scores weighted code groups once per group and applies superseding groups", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-score-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "release", "hosp"); await mkdir(memberDirectory, { recursive: true });
  await writeFile(join(memberDirectory, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,exposed,hospital_expire_flag\n1,11,1,0\n2,21,0,0\n"));
  // Admission 11: two MI codes (counted once), cancer and metastasis (metastasis supersedes cancer). Admission 21: none.
  await writeFile(join(memberDirectory, "diagnoses_icd.csv.gz"), await gzipAsync("subject_id,hadm_id,icd_code,icd_version\n1,11,I214,10\n1,11,I219,10\n1,11,C509,10\n1,11,C787,10\n2,21,J189,10\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "exposed", "hospital_expire_flag"] };
  const diagnoses = { id: "mimiciv_hosp.diagnoses_icd", schema: "mimiciv_hosp" as const, table: "diagnoses_icd", required_columns: ["subject_id", "hadm_id", "icd_code", "icd_version"] };
  const groups = [
    { group_id: "mi", weight: 1, code_prefixes: [{ prefix: "I21", version: 10 as const }] },
    { group_id: "malignancy", weight: 2, code_prefixes: [{ prefix: "C50", version: 10 as const }] },
    { group_id: "metastatic", weight: 6, code_prefixes: [{ prefix: "C78", version: 10 as const }], supersedes: ["malignancy"] },
  ];
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:score", study_integrity_id: "sha256:score", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, diagnoses], joins: [{ left_source_id: admissions.id, right_source_id: diagnoses.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "many_to_one" }], variables: [
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "covariate", requested_label: "Charlson comorbidity index", mapping_id: "cci", mapping_version: "1", source_id: diagnoses.id, value_type: "continuous", value_rule: { kind: "code_score", code_column: "icd_code", version_column: "icd_version", groups }, temporal_rule: "admission", missingness_rule: "0" },
  ], time_windows: [], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, covariate_0 }) => [analysis_id, covariate_0]), [["11", 7], ["21", 0]]);
});

test("ignores recorded values outside the mapping's plausible range", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-range-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "release", "hosp"); await mkdir(memberDirectory, { recursive: true });
  await writeFile(join(memberDirectory, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,exposed\n1,11,1\n"));
  await writeFile(join(memberDirectory, "labevents.csv.gz"), await gzipAsync("subject_id,hadm_id,itemid,charttime,valuenum\n1,11,5,2150-01-01 09:00:00,120\n1,11,5,2150-01-01 10:00:00,1200\n1,11,5,2150-01-01 11:00:00,0\n1,11,5,2150-01-01 12:00:00,140\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "exposed"] };
  const labs = { id: "mimiciv_hosp.labevents", schema: "mimiciv_hosp" as const, table: "labevents", required_columns: ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:range", study_integrity_id: "sha256:range", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, labs], joins: [{ left_source_id: admissions.id, right_source_id: labs.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "many_to_one" }], variables: [
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "SBP", mapping_id: "sbp", mapping_version: "1", source_id: labs.id, value_type: "continuous", value_rule: { kind: "item_ids", id_column: "itemid", ids: [5], value_column: "valuenum" }, aggregation: "mean", valid_range: { min: 0, max: 400 }, temporal_rule: "charted", missingness_rule: "missing" },
  ], time_windows: [], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.equal(result.rows[0]?.outcome, 130);
});

test("runs several manifests over one scan per table with results identical to separate runs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-many-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const memberDirectory = join(directory, "release", "hosp"); await mkdir(memberDirectory, { recursive: true });
  await writeFile(join(memberDirectory, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,dischtime,exposed,other,age\n1,11,2150-01-01 08:00:00,2150-01-05 10:00:00,1,0,70\n1,12,2150-01-08 08:00:00,2150-01-09 10:00:00,0,1,70\n2,21,2150-02-01 08:00:00,2150-02-03 10:00:00,0,1,40\n3,31,2150-03-01 08:00:00,2150-03-01 20:00:00,1,1,17\n4,41,2150-04-01 08:00:00,2150-04-02 08:00:00,0,0,60\n"));
  await writeFile(join(memberDirectory, "patients.csv.gz"), await gzipAsync("subject_id,dod\n1,2150-01-11\n2,\n3,2150-03-01\n4,2150-06-01\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "dischtime", "exposed", "other", "age"] };
  const patients = { id: "mimiciv_hosp.patients", schema: "mimiciv_hosp" as const, table: "patients", required_columns: ["subject_id", "dod"] };
  const index = { role: "index_time" as const, requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: admissions.id, value_type: "categorical" as const, value_rule: { kind: "direct" as const, column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" };
  const death = { role: "outcome" as const, requested_label: "All-cause death", mapping_id: "death", mapping_version: "1", source_id: patients.id, value_type: "binary" as const, value_rule: { kind: "direct" as const, column: "dod" }, time_column: "dod", contrast: { kind: "binary_presence" as const }, aggregation: "first" as const, temporal_rule: "death", missingness_rule: "alive" };
  const base = { schema_version: "2.0.0" as const, study_integrity_id: "sha256:many", data_model: "MIMIC-IV" as const, study_family: "association" as const, status: "ready" as const, analysis_unit: { source_id: admissions.id, column: "hadm_id" as const }, sources: [admissions, patients], joins: [{ left_source_id: admissions.id, right_source_id: patients.id, left_column: "subject_id", right_column: "subject_id", cardinality: "many_to_one" as const }], blockers: [] };
  const exposure = (column: string) => ({ role: "exposure" as const, requested_label: column, mapping_id: column, mapping_version: "1", source_id: admissions.id, value_type: "binary" as const, value_rule: { kind: "direct" as const, column }, temporal_rule: "admission", missingness_rule: "exclude" });
  // Survival to 30 days; in-encounter death with another exposure; and a population restricted by the same condition id to adults.
  const survival: ExecutionManifest = { ...base, manifest_id: "manifest:many-survival", variables: [index, exposure("exposed"), death], time_windows: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 30, unit: "day" }], extraction: { unit_selection: "first_per_subject", outcome_timing: { kind: "time_to_event", horizon_days: 30, follow_up: "death_registry" } } };
  const encounter: ExecutionManifest = { ...base, manifest_id: "manifest:many-encounter", variables: [index, exposure("other"), death], time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }] };
  const adults: ExecutionManifest = { ...base, manifest_id: "manifest:many-adults", population_predicate: { condition_id: "population.target", source_text: "adults", kind: "numeric_comparison", concept: "age", operator: "gte", value: 18 },
    variables: [{ role: "population", condition_id: "population.target", requested_label: "age", mapping_id: "age", mapping_version: "1", source_id: admissions.id, value_type: "continuous", value_rule: { kind: "direct", column: "age" }, temporal_rule: "admission", missingness_rule: "exclude" }, index, exposure("exposed"), death],
    time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }] };
  const scans: string[] = [];
  const together = await new LocalExecutionGraphRunner({ on_progress: ({ source_id, done }) => { if (done) scans.push(source_id); } }).runMany(archive, [survival, encounter, adults]);
  assert.deepEqual(scans, [admissions.id, patients.id], "each table is read once for all three manifests");
  const alone = await Promise.all([survival, encounter, adults].map((manifest) => new LocalExecutionGraphRunner().run(archive, manifest)));
  assert.deepEqual(together, alone);
  assert.ok(together[2]!.rows.every(({ analysis_id }) => analysis_id !== "31"), "the adult population excludes the 17-year-old");
});

test("counts a record only when every filter of a multi-column rule holds", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-filters-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true }); await mkdir(join(directory, "release", "icu"), { recursive: true });
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,exposed\n1,11,1\n2,21,0\n3,31,1\n"));
  // Patient 1 has a positive assessment; patient 2 only negative ones; patient 3 a positive value on a different item.
  await writeFile(join(directory, "release", "icu", "chartevents.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,itemid,charttime,value\n1,11,111,228332,2150-01-01 10:00:00,Positive\n2,21,211,228332,2150-01-01 10:00:00,Negative\n3,31,311,220045,2150-01-01 10:00:00,Positive\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "exposed"] };
  const chart = { id: "mimiciv_icu.chartevents", schema: "mimiciv_icu" as const, table: "chartevents", required_columns: ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "value"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:filters", study_integrity_id: "sha256:filters", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, chart], joins: [{ left_source_id: admissions.id, right_source_id: chart.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" }], variables: [
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "Delirium", mapping_id: "delirium", mapping_version: "1", source_id: chart.id, value_type: "binary", value_rule: { kind: "matching_values", column: "value", values: ["positive"], also: [{ column: "itemid", values: ["228332"] }] }, contrast: { kind: "binary_presence" }, aggregation: "any", temporal_rule: "stay", missingness_rule: "absent" },
  ], time_windows: [], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome]), [["11", true], ["21", false], ["31", false]]);
});

test("starts follow-up at the landmark and excludes units that ended before it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-landmark-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true });
  // 11: died at hour 5 (ended before the landmark); 21: died on day 3; 31: survived; 41: death timed at hour 10 although the
  // discharge time is day 5 (the 3.3 case: deaths before the landmark were counted as survivors before 2026-11-04).
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,dischtime,deathtime,exposed\n1,11,2150-01-01 08:00:00,2150-01-01 13:00:00,2150-01-01 13:00:00,0\n2,21,2150-02-01 08:00:00,2150-02-04 08:00:00,2150-02-04 08:00:00,1\n3,31,2150-03-01 08:00:00,2150-03-05 08:00:00,,1\n4,41,2150-04-01 08:00:00,2150-04-06 08:00:00,2150-04-01 18:00:00,0\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "dischtime", "deathtime", "exposed"] };
  const manifest = (landmark?: number): ExecutionManifest => ({ schema_version: "2.0.0", manifest_id: `manifest:landmark-${landmark ?? 0}`, study_integrity_id: "sha256:landmark", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions], joins: [], variables: [
    { role: "index_time", requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: admissions.id, value_type: "categorical", value_rule: { kind: "direct", column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "deathtime" }, time_column: "deathtime", contrast: { kind: "binary_presence" }, temporal_rule: "death", missingness_rule: "alive" },
  ], time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], ...(landmark ? { extraction: { landmark_hours: landmark } } : {}), blockers: [] });
  const [plain, landmark] = await new LocalExecutionGraphRunner().runMany(archive, [manifest(), manifest(24)]);
  assert.deepEqual(plain!.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome]), [["11", true], ["21", true], ["31", false], ["41", true]]);
  assert.deepEqual(landmark!.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome]), [["21", true], ["31", false]], "a unit dead before hour 24 is not followed from it, whatever its discharge time");
  assert.deepEqual(landmark!.quality.exclusion_reasons, { ended_before_landmark: 1, outcome_before_landmark: 1 });
  flowReconciles(landmark!);
});

test("a landmark design excludes a unit whose event outcome is recorded before the landmark; another admission's record is history", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-landmark-event-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true });
  // Synthetic, events joined by patient. 1: the event at hour 10; 2: at hour 48; 3: months before, in another admission; 4: none.
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,dischtime,exposed\n1,11,2150-01-01 08:00:00,2150-01-06 08:00:00,1\n2,21,2150-02-01 08:00:00,2150-02-06 08:00:00,0\n3,31,2150-03-01 08:00:00,2150-03-06 08:00:00,1\n4,41,2150-04-01 08:00:00,2150-04-06 08:00:00,0\n"));
  await writeFile(join(directory, "release", "hosp", "events.csv.gz"), await gzipAsync("subject_id,itemid,charttime,valuenum\n1,7,2150-01-01 18:00:00,3\n2,7,2150-02-03 08:00:00,3\n3,7,2149-06-01 08:00:00,3\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "dischtime", "exposed"] };
  const events = { id: "mimiciv_hosp.events", schema: "mimiciv_hosp" as const, table: "events", required_columns: ["subject_id", "itemid", "charttime", "valuenum"] };
  const manifest = (valueType: "binary" | "continuous"): ExecutionManifest => ({ schema_version: "2.0.0", manifest_id: `manifest:landmark-event-${valueType}`, study_integrity_id: "sha256:landmark-event", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" },
    sources: [admissions, events], joins: [{ left_source_id: admissions.id, right_source_id: events.id, left_column: "subject_id", right_column: "subject_id", cardinality: "one_to_many" }], variables: [
    { role: "index_time", requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: admissions.id, value_type: "categorical", value_rule: { kind: "direct", column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "event", mapping_id: "event", mapping_version: "1", source_id: events.id, value_type: valueType, value_rule: { kind: "item_ids", id_column: "itemid", ids: [7], value_column: "valuenum" }, time_column: "charttime", ...(valueType === "binary" ? { contrast: { kind: "binary_presence" as const } } : { aggregation: "maximum" as const }), temporal_rule: "event", missingness_rule: valueType === "binary" ? "absent" : "exclude" },
  ], time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], extraction: { landmark_hours: 24 }, blockers: [] });
  const [event, value] = await new LocalExecutionGraphRunner().runMany(archive, [manifest("binary"), manifest("continuous")]);
  assert.deepEqual(event!.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome ?? false]), [["21", true], ["31", false], ["41", false]], "the event at hour 10 was already there at the landmark; the record of an earlier admission is not this admission's outcome");
  assert.deepEqual(event!.quality.exclusion_reasons, { outcome_before_landmark: 1 });
  flowReconciles(event!);
  assert.deepEqual(value!.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome]), [["21", 3]], "a measured outcome is read after the landmark and excludes no one");
});

test("reads a yes/no item variable as present when a record exists, whatever its amount", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-presence-items-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true }); await mkdir(join(directory, "release", "icu"), { recursive: true });
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,exposed,hospital_expire_flag\n1,11,1,0\n2,21,0,1\n3,31,1,0\n"));
  await writeFile(join(directory, "release", "icu", "inputevents.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,itemid,starttime,amount\n1,11,111,221906,2150-01-01 10:00:00,0.5\n2,21,211,221906,2150-01-01 10:00:00,2.4\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "exposed", "hospital_expire_flag"] };
  const inputs = { id: "mimiciv_icu.inputevents", schema: "mimiciv_icu" as const, table: "inputevents", required_columns: ["subject_id", "hadm_id", "stay_id", "itemid", "starttime", "amount"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:presence-items", study_integrity_id: "sha256:x", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, inputs], joins: [{ left_source_id: admissions.id, right_source_id: inputs.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" }], variables: [
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "covariate", requested_label: "Vasopressors", mapping_id: "vaso", mapping_version: "1", source_id: inputs.id, value_type: "binary", value_rule: { kind: "item_ids", id_column: "itemid", ids: [221906], value_column: "amount" }, aggregation: "any", temporal_rule: "stay", missingness_rule: "absent" },
  ], time_windows: [], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map((row) => [row.analysis_id, row.covariate_0]), [["11", true], ["21", true], ["31", false]]);
});

test("sums amounts converted by item and unit (morphine equivalents) and ignores unlisted units and implausible records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-weighted-amount-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true }); await mkdir(join(directory, "release", "icu"), { recursive: true });
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,exposed,hospital_expire_flag\n1,11,1,0\n2,21,0,1\n3,31,1,0\n4,41,1,0\n"));
  // 11: morphine 5 mg + fentanyl 100 mcg + fentanyl 0.1 mg -> 5 + 10 + 10; 21: only an unlisted unit; 31: hydromorphone 500 mg is above the plausible record range; 41: no opioid record.
  await writeFile(join(directory, "release", "icu", "inputevents.csv.gz"), await gzipAsync([
    "subject_id,hadm_id,stay_id,itemid,starttime,amount,amountuom",
    "1,11,111,225154,2150-01-01 10:00:00,5,mg", "1,11,111,221744,2150-01-01 11:00:00,100,mcg", "1,11,111,221744,2150-01-01 12:00:00,0.1,mg",
    "2,21,211,221744,2150-01-01 10:00:00,50,dose", "3,31,311,221833,2150-01-01 10:00:00,500,mg", "3,31,311,221833,2150-01-01 11:00:00,1.5,mg",
  ].join("\n") + "\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "exposed", "hospital_expire_flag"] };
  const inputs = { id: "mimiciv_icu.inputevents", schema: "mimiciv_icu" as const, table: "inputevents", required_columns: ["subject_id", "hadm_id", "stay_id", "itemid", "starttime", "amount", "amountuom"] };
  const conversions = [{ item_id: 225154, unit: "mg", factor: 1 }, { item_id: 221833, unit: "mg", factor: 6.67 }, { item_id: 221744, unit: "mcg", factor: 0.1 }, { item_id: 221744, unit: "mg", factor: 100 }];
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:weighted", study_integrity_id: "sha256:x", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, inputs], joins: [{ left_source_id: admissions.id, right_source_id: inputs.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" }], variables: [
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "covariate", requested_label: "Opioid MME", mapping_id: "mme", mapping_version: "1", source_id: inputs.id, value_type: "continuous", value_rule: { kind: "weighted_amount", id_column: "itemid", value_column: "amount", unit_column: "amountuom", conversions }, aggregation: "sum", valid_range: { min: 0, max: 1000 }, temporal_rule: "stay", missingness_rule: "absent" },
  ], time_windows: [], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  const doses = new Map(result.rows.map((row) => [row.analysis_id, row.covariate_0]));
  assert.ok(Math.abs(Number(doses.get("11")) - 25) < 1e-9);
  assert.equal(doses.get("21") ?? null, null);
  assert.ok(Math.abs(Number(doses.get("31")) - 1.5 * 6.67) < 1e-9);
  assert.equal(doses.get("41") ?? null, null);
});

const sources = (extra: ExecutionManifest["sources"]): ExecutionManifest["sources"] => [{ id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp", table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "hospital_expire_flag"] }, ...extra];

test("reads the standard deviation of repeated measurements inside the exposure window", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-sd-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const hosp = join(directory, "release", "hosp"); const icu = join(directory, "release", "icu"); await mkdir(hosp, { recursive: true }); await mkdir(icu, { recursive: true });
  await writeFile(join(hosp, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,hospital_expire_flag\n1,10,2026-01-01T00:00:00Z,1\n2,20,2026-01-01T00:00:00Z,0\n"));
  await writeFile(join(icu, "chartevents.csv.gz"), await gzipAsync("subject_id,hadm_id,itemid,charttime,valuenum\n1,10,42,2026-01-01T01:00:00Z,100\n1,10,42,2026-01-01T02:00:00Z,120\n1,10,42,2026-01-01T03:00:00Z,140\n1,10,42,2026-01-03T03:00:00Z,500\n2,20,42,2026-01-01T01:00:00Z,110\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:sd", study_integrity_id: "sha256:test", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: "mimiciv_hosp.admissions", column: "hadm_id" },
    sources: sources([{ id: "mimiciv_icu.chartevents", schema: "mimiciv_icu", table: "chartevents", required_columns: ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"] }]),
    joins: [{ left_source_id: "mimiciv_hosp.admissions", right_source_id: "mimiciv_icu.chartevents", left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" }],
    variables: [
      { role: "index_time", requested_label: "admission", mapping_id: "index", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "date_time", value_rule: { kind: "direct", column: "admittime" }, temporal_rule: "admission", missingness_rule: "exclude" },
      { role: "exposure", requested_label: "variability", mapping_id: "sd", mapping_version: "1", source_id: "mimiciv_icu.chartevents", value_type: "continuous", value_rule: { kind: "item_ids", id_column: "itemid", ids: [42], value_column: "valuenum" }, time_column: "charttime", aggregation: "standard_deviation", temporal_rule: "first day", missingness_rule: "exclude" },
      { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "admission", missingness_rule: "exclude" },
    ], time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows, [{ analysis_id: "10", exposure: 20, outcome: true }], "the sample SD of 100, 120, 140 is 20; the reading on day 3 is outside the window; one reading has no SD, so that admission is incomplete");
});

test("reads a derived concept from the derived archive that sits next to the archive", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-derived-layer-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const hosp = join(directory, "release", "hosp"); await mkdir(hosp, { recursive: true });
  await writeFile(join(hosp, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,hospital_expire_flag\n1,10,2026-01-01T00:00:00Z,1\n2,20,2026-01-01T00:00:00Z,0\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const layer = join(directory, "layer", "derived"); await mkdir(layer, { recursive: true });
  await writeFile(join(layer, "derived_events.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,itemid,charttime,valuenum\n1,10,,9000001,2026-01-02T00:00:00Z,2\n"));
  assert.equal(spawnSync("zip", ["-q", "-r", join(directory, "mimic-derived.zip"), "derived"], { cwd: join(directory, "layer") }).status, 0);
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:layer", study_integrity_id: "sha256:test", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: "mimiciv_hosp.admissions", column: "hadm_id" },
    sources: sources([{ id: "mimiciv_derived.derived_events", schema: "mimiciv_derived", table: "derived_events", required_columns: ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"] }]),
    joins: [{ left_source_id: "mimiciv_hosp.admissions", right_source_id: "mimiciv_derived.derived_events", left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" }],
    variables: [
      { role: "index_time", requested_label: "admission", mapping_id: "index", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "date_time", value_rule: { kind: "direct", column: "admittime" }, temporal_rule: "admission", missingness_rule: "exclude" },
      { role: "exposure", requested_label: "kidney injury", mapping_id: "aki", mapping_version: "1", source_id: "mimiciv_derived.derived_events", value_type: "binary", value_rule: { kind: "item_ids", id_column: "itemid", ids: [9000001], value_column: "valuenum" }, time_column: "charttime", contrast: { kind: "binary_presence" }, temporal_rule: "stay", missingness_rule: "exclude" },
      { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "admission", missingness_rule: "exclude" },
    ], time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 10, unit: "day" }], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, exposure }) => [analysis_id, exposure]), [["10", true], ["20", false]]);
  await rm(join(directory, "mimic-derived.zip"));
  await assert.rejects(() => new LocalExecutionGraphRunner().run(archive, manifest), /derived-variable layer was not found/u);
});

test("an ICU-stay analysis reads a derived event of the whole admission through the admission", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-derived-stay-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const icu = join(directory, "release", "icu"); await mkdir(icu, { recursive: true });
  await writeFile(join(icu, "icustays.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,intime,died\n1,10,100,2026-01-01T00:00:00Z,1\n2,20,200,2026-01-01T00:00:00Z,0\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const layer = join(directory, "layer", "derived"); await mkdir(layer, { recursive: true });
  await writeFile(join(layer, "derived_events.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,itemid,charttime,valuenum\n1,10,,9000001,2026-01-02T00:00:00Z,2\n1,10,100,9000020,2026-01-01T06:00:00Z,4\n"));
  assert.equal(spawnSync("zip", ["-q", "-r", join(directory, "mimic-derived.zip"), "derived"], { cwd: join(directory, "layer") }).status, 0);
  const variable = (label: string, itemId: number): ExecutionManifest["variables"][number] => ({ role: "exposure", requested_label: label, mapping_id: label, mapping_version: "1", source_id: "mimiciv_derived.derived_events", value_type: "binary", value_rule: { kind: "item_ids", id_column: "itemid", ids: [itemId], value_column: "valuenum" }, time_column: "charttime", contrast: { kind: "binary_presence" }, temporal_rule: "stay", missingness_rule: "exclude" });
  const manifest = (itemId: number): ExecutionManifest => ({ schema_version: "2.0.0", manifest_id: "manifest:stay", study_integrity_id: "sha256:test", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: "mimiciv_icu.icustays", column: "stay_id" },
    sources: [{ id: "mimiciv_icu.icustays", schema: "mimiciv_icu", table: "icustays", required_columns: ["subject_id", "hadm_id", "stay_id", "intime", "died"] }, { id: "mimiciv_derived.derived_events", schema: "mimiciv_derived", table: "derived_events", required_columns: ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"] }],
    joins: [{ left_source_id: "mimiciv_icu.icustays", right_source_id: "mimiciv_derived.derived_events", left_column: "stay_id", right_column: "stay_id", cardinality: "one_to_many" }],
    variables: [
      { role: "index_time", requested_label: "ICU admission", mapping_id: "index", mapping_version: "1", source_id: "mimiciv_icu.icustays", value_type: "date_time", value_rule: { kind: "direct", column: "intime" }, temporal_rule: "stay", missingness_rule: "exclude" },
      variable("derived", itemId),
      { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: "mimiciv_icu.icustays", value_type: "binary", value_rule: { kind: "direct", column: "died" }, temporal_rule: "stay", missingness_rule: "exclude" },
    ], time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 10, unit: "day" }], blockers: [] });
  const admissionLevel = await new LocalExecutionGraphRunner().run(archive, manifest(9000001));
  assert.deepEqual(admissionLevel.rows.map(({ analysis_id, exposure }) => [analysis_id, exposure]), [["100", true], ["200", false]], "the acute kidney injury row has no stay, so it reaches the stay of its admission");
  const stayLevel = await new LocalExecutionGraphRunner().run(archive, manifest(9000020));
  assert.deepEqual(stayLevel.rows.map(({ analysis_id, exposure }) => [analysis_id, exposure]), [["100", true], ["200", false]], "a stay-level row still joins on the stay");
});

test("a derived layer built from other diagnosis definitions than the current ones is refused", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-derived-guard-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const hosp = join(directory, "release", "hosp"); await mkdir(hosp, { recursive: true });
  await writeFile(join(hosp, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,hospital_expire_flag\n1,10,2026-01-01T00:00:00Z,1\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const build = async (layer: unknown) => {
    const folder = join(directory, "layer"); await rm(folder, { recursive: true, force: true }); await mkdir(join(folder, "derived"), { recursive: true });
    await writeFile(join(folder, "derived", "derived_events.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,itemid,charttime,valuenum\n1,10,,9000001,2026-01-02T00:00:00Z,2\n"));
    if (layer !== undefined) await writeFile(join(folder, "derived", "layer.json"), JSON.stringify(layer));
    await rm(join(directory, "mimic-derived.zip"), { force: true });
    assert.equal(spawnSync("zip", ["-q", "-r", join(directory, "mimic-derived.zip"), "derived"], { cwd: folder }).status, 0);
  };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:guard", study_integrity_id: "sha256:test", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: "mimiciv_hosp.admissions", column: "hadm_id" },
    sources: sources([{ id: "mimiciv_derived.derived_events", schema: "mimiciv_derived", table: "derived_events", required_columns: ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"] }]),
    joins: [{ left_source_id: "mimiciv_hosp.admissions", right_source_id: "mimiciv_derived.derived_events", left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" }],
    variables: [
      { role: "index_time", requested_label: "admission", mapping_id: "index", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "date_time", value_rule: { kind: "direct", column: "admittime" }, temporal_rule: "admission", missingness_rule: "exclude" },
      { role: "exposure", requested_label: "kidney injury", mapping_id: "aki", mapping_version: "1", source_id: "mimiciv_derived.derived_events", value_type: "binary", value_rule: { kind: "item_ids", id_column: "itemid", ids: [9000001], value_column: "valuenum" }, time_column: "charttime", contrast: { kind: "binary_presence" }, temporal_rule: "stay", missingness_rule: "exclude" },
      { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: "mimiciv_hosp.admissions", value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "admission", missingness_rule: "exclude" },
    ], time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 10, unit: "day" }], blockers: [] };
  await build({ diagnosis_fingerprint: "aaaa", items: [9000001] });
  assert.equal((await new LocalExecutionGraphRunner({ expected_layer: { fingerprint: "aaaa", items: [9000001] } }).run(archive, manifest)).rows.length, 1, "the matching layer is read");
  await assert.rejects(() => new LocalExecutionGraphRunner({ expected_layer: { fingerprint: "aaaa", items: [9000001, 9000050] } }).run(archive, manifest), /lacks 1 derived item/u);
  await assert.rejects(() => new LocalExecutionGraphRunner({ expected_layer: { fingerprint: "bbbb", items: [] } }).run(archive, manifest), /other diagnosis definitions/u);
  await build(undefined);
  await assert.rejects(() => new LocalExecutionGraphRunner({ expected_layer: { fingerprint: "aaaa", items: [] } }).run(archive, manifest), /no record of the definitions/u);
  assert.equal((await new LocalExecutionGraphRunner().run(archive, manifest)).rows.length, 1, "without an expectation the layer is read as before");
});

test("a drug record summed over the window counts records: none is 0, one is 1, two is 2 (never a mix of true, false and counts)", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-summed-presence-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true }); await mkdir(join(directory, "release", "icu"), { recursive: true });
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,exposed,hospital_expire_flag\n1,11,1,0\n2,21,0,1\n3,31,1,0\n"));
  await writeFile(join(directory, "release", "icu", "inputevents.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,itemid,starttime,amount\n1,11,111,221906,2150-01-01 10:00:00,0.5\n1,11,111,221906,2150-01-01 12:00:00,0.5\n2,21,211,221906,2150-01-01 10:00:00,2.4\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "exposed", "hospital_expire_flag"] };
  const inputs = { id: "mimiciv_icu.inputevents", schema: "mimiciv_icu" as const, table: "inputevents", required_columns: ["subject_id", "hadm_id", "stay_id", "itemid", "starttime", "amount"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:summed-presence", study_integrity_id: "sha256:x", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, inputs], joins: [{ left_source_id: admissions.id, right_source_id: inputs.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" }], variables: [
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "covariate", requested_label: "Drug records", mapping_id: "drug", mapping_version: "1", source_id: inputs.id, value_type: "binary", value_rule: { kind: "item_ids", id_column: "itemid", ids: [221906], value_column: "amount" }, aggregation: "sum", temporal_rule: "stay", missingness_rule: "absent" },
  ], time_windows: [], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map((row) => [row.analysis_id, row.covariate_0]), [["11", 2], ["21", 1], ["31", 0]]);
});

test("an outcome window is applied from an ICU admission even when the outcome's table comes before the ICU stays in the manifest", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-icu-window-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true }); await mkdir(join(directory, "release", "icu"), { recursive: true });
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,dischtime\n1,11,2150-01-01 08:00:00,2150-01-20 10:00:00\n2,21,2150-01-01 08:00:00,2150-01-20 10:00:00\n3,31,2150-01-01 08:00:00,2150-01-20 10:00:00\n"));
  // Patient 1 dies on day 10 after the ICU admission, patient 2 on day 100, patient 3 does not die.
  await writeFile(join(directory, "release", "hosp", "patients.csv.gz"), await gzipAsync("subject_id,dod\n1,2150-01-12\n2,2150-04-12\n3,\n"));
  await writeFile(join(directory, "release", "icu", "icustays.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,intime,outtime\n1,11,111,2150-01-02 08:00:00,2150-01-05 08:00:00\n2,21,211,2150-01-02 08:00:00,2150-01-05 08:00:00\n3,31,311,2150-01-02 08:00:00,2150-01-05 08:00:00\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "dischtime"] };
  const patients = { id: "mimiciv_hosp.patients", schema: "mimiciv_hosp" as const, table: "patients", required_columns: ["subject_id", "dod"] };
  const stays = { id: "mimiciv_icu.icustays", schema: "mimiciv_icu" as const, table: "icustays", required_columns: ["subject_id", "hadm_id", "stay_id", "intime", "outtime"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:icu-window", study_integrity_id: "sha256:icu-window", data_model: "MIMIC-IV", study_family: "association", status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" },
    // patients is listed before the ICU stays, as the readers of the archive see them.
    sources: [admissions, patients, stays], joins: [
      { left_source_id: admissions.id, right_source_id: patients.id, left_column: "subject_id", right_column: "subject_id", cardinality: "many_to_one" },
      { left_source_id: admissions.id, right_source_id: stays.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" },
    ], variables: [
      { role: "index_time", requested_label: "ICU admission", mapping_id: "icu", mapping_version: "1", source_id: stays.id, value_type: "categorical", value_rule: { kind: "direct", column: "intime" }, time_column: "intime", temporal_rule: "ICU admission", missingness_rule: "exclude" },
      { role: "outcome", condition_id: "outcome.target", semantic_condition: { condition_id: "outcome.target", source_text: "28-day mortality", kind: "event_exists", concept: "28-day mortality", occurrence: "present" }, requested_label: "28-day mortality", mapping_id: "death", mapping_version: "1", source_id: patients.id, value_type: "binary", value_rule: { kind: "direct", column: "dod" }, time_column: "dod", contrast: { kind: "binary_presence" }, temporal_rule: "death", missingness_rule: "alive" },
    ], time_windows: [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 28, unit: "day" }], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome]), [["11", true], ["21", false], ["31", false]]);
});

// --- Proposed regression tests: unit selection is fixed on eligibility (time-zero information) before missing exposure/outcome. ---
const orderArchive = async (context: { after: (fn: () => Promise<void>) => void }, admissions: string, chartevents?: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-order-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true }); await mkdir(join(directory, "release", "icu"), { recursive: true });
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync(admissions));
  if (chartevents) await writeFile(join(directory, "release", "icu", "chartevents.csv.gz"), await gzipAsync(chartevents));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  return archive;
};
const orderAdmissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "dischtime", "deathtime", "exposed", "htn", "creat"] };
const orderChart = { id: "mimiciv_icu.chartevents", schema: "mimiciv_icu" as const, table: "chartevents", required_columns: ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"] };
const orderIndex = { role: "index_time" as const, requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: orderAdmissions.id, value_type: "categorical" as const, value_rule: { kind: "direct" as const, column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" };
const orderExposure = { role: "exposure" as const, requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: orderAdmissions.id, value_type: "binary" as const, value_rule: { kind: "direct" as const, column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" };
const orderHypertension = { role: "population" as const, condition_id: "population.target", requested_label: "hypertension", mapping_id: "htn", mapping_version: "1", source_id: orderAdmissions.id, value_type: "continuous" as const, value_rule: { kind: "direct" as const, column: "htn" }, temporal_rule: "admission", missingness_rule: "exclude" };
const hypertensionPredicate = { condition_id: "population.target", source_text: "hypertension", kind: "numeric_comparison" as const, concept: "hypertension", operator: "eq" as const, value: 1 };
const bpChange = { role: "outcome" as const, requested_label: "blood pressure change", mapping_id: "sbp-change", mapping_version: "1", source_id: orderChart.id, value_type: "continuous" as const, value_rule: { kind: "item_ids" as const, id_column: "itemid", ids: [42], value_column: "valuenum" }, time_column: "charttime", aggregation: "mean" as const, temporal_rule: "two windows", derivation: { schema_version: "1.0.0" as const, operator: "difference" as const, baseline: { purpose: "baseline" as const, aggregation: "mean" as const }, follow_up: { purpose: "follow_up" as const, aggregation: "mean" as const }, direction: "follow_up_minus_baseline" as const }, valid_range: { min: 0, max: 400 }, missingness_rule: "exclude" };
const bpWindows = [{ purpose: "exposure" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 24, unit: "hour" as const }, { purpose: "baseline" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 24, unit: "hour" as const }, { purpose: "follow_up" as const, anchor: "index_time" as const, start_offset: 24, end_offset: 72, unit: "hour" as const }];
const orderBase = { schema_version: "2.0.0" as const, study_integrity_id: "sha256:order", data_model: "MIMIC-IV" as const, study_family: "treatment_effect" as const, status: "ready" as const, analysis_unit: { source_id: orderAdmissions.id, column: "hadm_id" as const }, blockers: [] };
const flowReconciles = (result: { rows: unknown[]; quality: { analysis_units: number; exclusion_reasons: Record<string, number> } }): void => {
  const steps = ["no_time_zero", "ended_before_landmark", "outcome_before_landmark", "outcome_before_prediction_time", "not_in_population", "not_first_eligible_unit_of_patient", "incomplete_required_variables"];
  assert.equal(result.quality.analysis_units - steps.reduce((sum, key) => sum + (result.quality.exclusion_reasons[key] ?? 0), 0), result.rows.length, "the flow steps land on the cohort");
};

test("a patient whose first eligible admission lacks the outcome is excluded, not moved to a later admission that has it", async (context) => {
  // 1: first admission has a baseline but no follow-up blood pressure, the later one has both. 2: one admission.
  // 3: two complete admissions. 4: the first admission is outside the population, so the second is the first eligible one.
  const archive = await orderArchive(context,
    "subject_id,hadm_id,admittime,dischtime,deathtime,exposed,htn,creat\n1,11,2150-01-01 08:00:00,2150-01-05 08:00:00,,1,1,1\n1,12,2150-03-01 08:00:00,2150-03-05 08:00:00,,0,1,1\n2,21,2150-01-01 08:00:00,2150-01-05 08:00:00,,0,1,1\n3,31,2150-01-01 08:00:00,2150-01-05 08:00:00,,1,1,1\n3,32,2150-02-01 08:00:00,2150-02-05 08:00:00,,1,1,1\n4,41,2150-01-01 08:00:00,2150-01-05 08:00:00,,0,0,1\n4,42,2150-02-01 08:00:00,2150-02-05 08:00:00,,1,1,1\n",
    "subject_id,hadm_id,itemid,charttime,valuenum\n1,11,42,2150-01-01 12:00:00,150\n1,12,42,2150-03-01 12:00:00,160\n1,12,42,2150-03-02 20:00:00,140\n2,21,42,2150-01-01 12:00:00,150\n2,21,42,2150-01-02 20:00:00,145\n3,31,42,2150-01-01 12:00:00,170\n3,31,42,2150-01-02 20:00:00,150\n3,32,42,2150-02-01 12:00:00,150\n3,32,42,2150-02-02 20:00:00,150\n4,41,42,2150-01-01 12:00:00,150\n4,41,42,2150-01-02 20:00:00,140\n4,42,42,2150-02-01 12:00:00,155\n4,42,42,2150-02-02 20:00:00,150\n");
  const manifest: ExecutionManifest = { ...orderBase, manifest_id: "manifest:order-bp", sources: [orderAdmissions, orderChart], joins: [{ left_source_id: orderAdmissions.id, right_source_id: orderChart.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" }],
    population_predicate: hypertensionPredicate, variables: [orderHypertension, orderIndex, orderExposure, bpChange], time_windows: bpWindows, extraction: { unit_selection: "first_per_subject" } };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome]), [["21", -5], ["31", -20], ["42", -5]], "admission 12 is not used in place of patient 1's first admission");
  assert.deepEqual(result.quality.exclusion_reasons, { not_in_population: 1, not_first_eligible_unit_of_patient: 2, incomplete_required_variables: 1 });
  flowReconciles(result);
});

test("a missing baseline adjustment variable keeps the patient at the first eligible admission and is counted after the cohort", async (context) => {
  // 1: first admission lacks creatinine, the later one has it; the first admission is still the patient's unit.
  const archive = await orderArchive(context, "subject_id,hadm_id,admittime,dischtime,deathtime,exposed,htn,creat\n1,11,2150-01-01 08:00:00,2150-01-05 08:00:00,,1,1,\n1,12,2150-03-01 08:00:00,2150-03-05 08:00:00,2150-03-05 08:00:00,0,1,1.2\n2,21,2150-01-01 08:00:00,2150-01-05 08:00:00,,0,1,0.9\n");
  const death = { role: "outcome" as const, requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: orderAdmissions.id, value_type: "binary" as const, value_rule: { kind: "direct" as const, column: "deathtime" }, time_column: "deathtime", contrast: { kind: "binary_presence" as const }, temporal_rule: "death", missingness_rule: "alive" };
  const creatinine = { role: "covariate" as const, requested_label: "creatinine", mapping_id: "creat", mapping_version: "1", source_id: orderAdmissions.id, value_type: "continuous" as const, value_rule: { kind: "direct" as const, column: "creat" }, temporal_rule: "baseline", missingness_rule: "exclude" };
  const manifest: ExecutionManifest = { ...orderBase, manifest_id: "manifest:order-covariate", sources: [orderAdmissions], joins: [], population_predicate: hypertensionPredicate, variables: [orderHypertension, orderIndex, orderExposure, death, creatinine],
    time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], extraction: { unit_selection: "first_per_subject" } };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id }) => analysis_id), ["11", "21"]);
  assert.deepEqual(result.quality.exclusion_reasons, { not_first_eligible_unit_of_patient: 1, incomplete_model_variables: 1 });
  assert.equal(result.quality.complete_rows, 1);
  flowReconciles(result);
});

test("a baseline measurement declared as an eligibility criterion selects the first admission that has it; a missing follow-up does not", async (context) => {
  // 1: first admission has no baseline blood pressure (not eligible), the later one does. 2: first admission has a baseline
  // but no follow-up value: it stays the patient's unit and is excluded for the missing outcome; admission 22 is not used.
  const archive = await orderArchive(context,
    "subject_id,hadm_id,admittime,dischtime,deathtime,exposed,htn,creat\n1,11,2150-01-01 08:00:00,2150-01-05 08:00:00,,1,1,1\n1,12,2150-03-01 08:00:00,2150-03-05 08:00:00,,0,1,1\n2,21,2150-01-01 08:00:00,2150-01-05 08:00:00,,0,1,1\n2,22,2150-02-01 08:00:00,2150-02-05 08:00:00,,1,1,1\n3,31,2150-01-01 08:00:00,2150-01-05 08:00:00,,1,1,1\n",
    "subject_id,hadm_id,itemid,charttime,valuenum\n1,11,42,2150-01-02 20:00:00,140\n1,12,42,2150-03-01 12:00:00,160\n1,12,42,2150-03-02 20:00:00,140\n2,21,42,2150-01-01 12:00:00,150\n2,22,42,2150-02-01 12:00:00,150\n2,22,42,2150-02-02 20:00:00,130\n3,31,42,2150-01-01 12:00:00,170\n3,31,42,2150-01-02 20:00:00,150\n");
  const baselineRecorded = { role: "population" as const, condition_id: "population.baseline_bp", semantic_condition: { condition_id: "population.baseline_bp", source_text: "blood pressure recorded in the first 24 hours", kind: "event_exists" as const, concept: "systolic blood pressure", occurrence: "present" as const, window: { purpose: "baseline" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 24, unit: "hour" as const } }, requested_label: "baseline blood pressure", mapping_id: "sbp", mapping_version: "1", source_id: orderChart.id, value_type: "binary" as const, value_rule: { kind: "item_ids" as const, id_column: "itemid", ids: [42], value_column: "valuenum" }, time_column: "charttime", temporal_rule: "baseline", missingness_rule: "absent" };
  const manifest: ExecutionManifest = { ...orderBase, manifest_id: "manifest:order-baseline-eligibility", sources: [orderAdmissions, orderChart], joins: [{ left_source_id: orderAdmissions.id, right_source_id: orderChart.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "one_to_many" }],
    population_predicate: { condition_id: "population.all", source_text: "hypertension with a baseline blood pressure", kind: "all", operands: [hypertensionPredicate, baselineRecorded.semantic_condition] },
    variables: [orderHypertension, baselineRecorded, orderIndex, orderExposure, bpChange], time_windows: bpWindows, extraction: { unit_selection: "first_per_subject" } };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome]), [["12", -20], ["31", -20]]);
  assert.deepEqual(result.quality.exclusion_reasons, { not_in_population: 1, not_first_eligible_unit_of_patient: 1, incomplete_required_variables: 1 });
  flowReconciles(result);
});

test("a mortality design with no missing outcome keeps exactly the same cohort and exclusion counts", async (context) => {
  // 1: first admission ends before the landmark, the second is the first eligible. 2: first admission outside the population.
  // 3: two eligible admissions. 4: dies on day 3.
  const archive = await orderArchive(context, "subject_id,hadm_id,admittime,dischtime,deathtime,exposed,htn,creat\n1,11,2150-01-01 08:00:00,2150-01-01 18:00:00,,1,1,1\n1,12,2150-02-01 08:00:00,2150-02-05 08:00:00,,0,1,1\n2,21,2150-01-01 08:00:00,2150-01-05 08:00:00,,0,0,1\n2,22,2150-02-01 08:00:00,2150-02-05 08:00:00,,1,1,1\n3,31,2150-01-01 08:00:00,2150-01-05 08:00:00,,1,1,1\n3,32,2150-02-01 08:00:00,2150-02-05 08:00:00,2150-02-05 08:00:00,0,1,1\n4,41,2150-01-01 08:00:00,2150-01-04 08:00:00,2150-01-04 08:00:00,0,1,1\n");
  const death = { role: "outcome" as const, requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: orderAdmissions.id, value_type: "binary" as const, value_rule: { kind: "direct" as const, column: "deathtime" }, time_column: "deathtime", contrast: { kind: "binary_presence" as const }, temporal_rule: "death", missingness_rule: "alive" };
  const manifest: ExecutionManifest = { ...orderBase, manifest_id: "manifest:order-mortality", sources: [orderAdmissions], joins: [], population_predicate: hypertensionPredicate, variables: [orderHypertension, orderIndex, orderExposure, death],
    time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }, { purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], extraction: { unit_selection: "first_per_subject", landmark_hours: 24 } };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, exposure, outcome }) => [analysis_id, exposure, outcome]), [["12", false, false], ["22", true, false], ["31", true, false], ["41", false, true]]);
  assert.deepEqual(result.quality.exclusion_reasons, { ended_before_landmark: 1, not_in_population: 1, not_first_eligible_unit_of_patient: 1 });
  assert.equal(result.quality.analysis_units, 7); assert.equal(result.quality.complete_rows, 4);
  flowReconciles(result);
});

test("windows include their start and exclude their end, so a value charted at 24 hours is follow-up only", async (context) => {
  // Admitted 08:00; SBP 150 at 12:00, 140 at exactly 08:00 the next day (24 h), 130 at 20:00 the next day.
  const archive = await orderArchive(context,
    "subject_id,hadm_id,admittime,dischtime,deathtime,exposed,htn,creat\n1,11,2150-01-01 08:00:00,2150-01-05 08:00:00,,1,1,1\n",
    "subject_id,hadm_id,itemid,charttime,valuenum\n1,11,42,2150-01-01 12:00:00,150\n1,11,42,2150-01-02 08:00:00,140\n1,11,42,2150-01-02 20:00:00,130\n");
  const manifest: ExecutionManifest = { ...orderBase, manifest_id: "manifest:order-half-open", sources: [orderAdmissions, orderChart], joins: [{ left_source_id: orderAdmissions.id, right_source_id: orderChart.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "many_to_one" }],
    population_predicate: hypertensionPredicate, variables: [orderHypertension, orderIndex, orderExposure, bpChange], time_windows: bpWindows, extraction: { unit_selection: "first_per_subject" } };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ outcome }) => outcome), [-15], "baseline 150 (0-24 h), follow-up mean of 140 and 130 (24-72 h)");
});

test("an event without a usable time is not placed in a window, and a unit without a time zero is not eligible", async (context) => {
  // 1: the only charted exposure event has no time. 2: exposure charted at 10:00 on the admission day. 3: no admission time.
  const archive = await orderArchive(context,
    "subject_id,hadm_id,admittime,dischtime,deathtime,exposed,htn,creat\n1,11,2150-01-01 08:00:00,2150-01-05 08:00:00,,0,1,1\n2,21,2150-01-01 08:00:00,2150-01-05 08:00:00,,0,1,1\n3,31,,2150-01-05 08:00:00,,0,1,1\n",
    "subject_id,hadm_id,itemid,charttime,valuenum\n1,11,99,,1\n2,21,99,2150-01-01 10:00:00,1\n3,31,99,2150-01-01 10:00:00,1\n");
  const charted = { role: "exposure" as const, requested_label: "charted drug", mapping_id: "charted", mapping_version: "1", source_id: orderChart.id, value_type: "binary" as const, value_rule: { kind: "item_ids" as const, id_column: "itemid", ids: [99], value_column: "valuenum" }, time_column: "charttime", contrast: { kind: "binary_presence" as const }, aggregation: "any" as const, temporal_rule: "exposure window", missingness_rule: "absent means not given" };
  const death = { role: "outcome" as const, requested_label: "death", mapping_id: "death", mapping_version: "1", source_id: orderAdmissions.id, value_type: "binary" as const, value_rule: { kind: "direct" as const, column: "deathtime" }, time_column: "deathtime", contrast: { kind: "binary_presence" as const }, temporal_rule: "death", missingness_rule: "alive" };
  const manifest: ExecutionManifest = { ...orderBase, manifest_id: "manifest:order-time", sources: [orderAdmissions, orderChart], joins: [{ left_source_id: orderAdmissions.id, right_source_id: orderChart.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "many_to_one" }],
    population_predicate: hypertensionPredicate, variables: [orderHypertension, orderIndex, charted, death],
    time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }, { purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], extraction: { unit_selection: "first_per_subject" } };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, exposure }) => [analysis_id, exposure]), [["11", false], ["21", true]]);
  assert.deepEqual(result.quality.exclusion_reasons, { no_time_zero: 1 });
  flowReconciles(result);
});

test("a prediction is made when its predictor window ends: units that left or already had the outcome by then are excluded", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-prediction-time-")); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "release", "hosp"), { recursive: true }); await mkdir(join(directory, "release", "icu"), { recursive: true });
  // Synthetic. 11: ventilated at hour 2 and again at hour 20; 21: discharged at hour 4; 31: ventilated at hour 10; 41: never
  // ventilated; 51: ventilation coded without a time (a diagnosis-code style record).
  await writeFile(join(directory, "release", "hosp", "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,dischtime,heart_rate\n1,11,2150-01-01 08:00:00,2150-01-05 08:00:00,90\n2,21,2150-02-01 08:00:00,2150-02-01 12:00:00,80\n3,31,2150-03-01 08:00:00,2150-03-05 08:00:00,110\n4,41,2150-04-01 08:00:00,2150-04-05 08:00:00,70\n5,51,2150-05-01 08:00:00,2150-05-05 08:00:00,100\n"));
  await writeFile(join(directory, "release", "icu", "procedureevents.csv.gz"), await gzipAsync("subject_id,hadm_id,itemid,starttime\n1,11,225792,2150-01-01 10:00:00\n1,11,225792,2150-01-02 04:00:00\n3,31,225792,2150-03-01 18:00:00\n"));
  await writeFile(join(directory, "release", "hosp", "diagnoses_icd.csv.gz"), await gzipAsync("subject_id,hadm_id,icd_code,icd_version\n5,51,5A1955Z,10\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "dischtime", "heart_rate"] };
  const procedures = { id: "mimiciv_icu.procedureevents", schema: "mimiciv_icu" as const, table: "procedureevents", required_columns: ["subject_id", "hadm_id", "itemid", "starttime"] };
  const diagnoses = { id: "mimiciv_hosp.diagnoses_icd", schema: "mimiciv_hosp" as const, table: "diagnoses_icd", required_columns: ["subject_id", "hadm_id", "icd_code", "icd_version"] };
  const windows = [
    { purpose: "exposure" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 6, unit: "hour" as const },
    { purpose: "baseline" as const, anchor: "index_time" as const, start_offset: 0, end_offset: 6, unit: "hour" as const },
    { purpose: "outcome" as const, anchor: "index_time" as const, start_offset: 6, end_offset: 48, unit: "hour" as const },
  ];
  const manifest = (family: ExecutionManifest["study_family"], outcomeWindowStart: number): ExecutionManifest => ({ schema_version: "2.0.0", manifest_id: `manifest:prediction-time-${family}-${outcomeWindowStart}`, study_integrity_id: "sha256:prediction-time", data_model: "MIMIC-IV", study_family: family, status: "ready", analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, procedures, diagnoses],
    joins: [{ left_source_id: admissions.id, right_source_id: procedures.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "many_to_one" }, { left_source_id: admissions.id, right_source_id: diagnoses.id, left_column: "hadm_id", right_column: "hadm_id", cardinality: "many_to_one" }], variables: [
    { role: "index_time", requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: admissions.id, value_type: "categorical", value_rule: { kind: "direct", column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: family === "prediction" ? "predictor" : "exposure", requested_label: "heart rate", mapping_id: "hr", mapping_version: "1", source_id: admissions.id, value_type: "continuous", value_rule: { kind: "direct", column: "heart_rate" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "invasive ventilation", mapping_id: "imv", mapping_version: "1", source_id: procedures.id, value_type: "binary", value_rule: { kind: "item_ids", id_column: "itemid", ids: [225792], value_column: "itemid" }, time_column: "starttime", contrast: { kind: "binary_presence" }, aggregation: "any", temporal_rule: "event", missingness_rule: "absent" },
    { role: "outcome", requested_label: "invasive ventilation (coded)", mapping_id: "imv-code", mapping_version: "1", source_id: diagnoses.id, value_type: "binary", value_rule: { kind: "codes", code_column: "icd_code", version_column: "icd_version", codes: [{ code: "5A1955Z", version: 10 }] }, contrast: { kind: "binary_presence" }, aggregation: "any", temporal_rule: "admission", missingness_rule: "absent" },
  ], time_windows: windows.map((window) => window.purpose === "outcome" ? { ...window, start_offset: outcomeWindowStart } : window), extraction: { unit_selection: "first_per_subject" }, blockers: [] });
  const [prediction, olderPrediction, association] = await new LocalExecutionGraphRunner().runMany(archive, [manifest("prediction", 6), manifest("prediction", 0), manifest("association", 0)]);
  assert.deepEqual(prediction!.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome]), [["31", true], ["41", false], ["51", true]], "an undated record cannot be placed before the prediction time, so it is not excluded");
  assert.deepEqual(prediction!.quality.exclusion_reasons, { ended_before_landmark: 1, outcome_before_prediction_time: 1 });
  flowReconciles(prediction!);
  assert.deepEqual(olderPrediction!.rows, prediction!.rows, "a plan compiled before the outcome window moved is enforced the same way");
  assert.deepEqual(association!.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome]), [["11", true], ["21", false], ["31", true], ["41", false], ["51", true]], "other designs are unchanged");
  assert.deepEqual(association!.quality.exclusion_reasons, {});
});

test("a prediction from ICU admission excludes a stay with the outcome recorded earlier in the same admission", async (context) => {
  // 2026-11-04: 4.3 (first-day creatinine and urine output, AKI from 24 to 168 hours) analysed first eligible stays with acute
  // kidney injury already recorded on the ward before the ICU stay, and counted many of them as new outcomes.
  const directory = await mkdtemp(join(tmpdir(), "mimic-prediction-before-icu-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const icu = join(directory, "release", "icu"); await mkdir(icu, { recursive: true });
  // Synthetic. 1: AKI on the ward 10 hours before the ICU stay, and again on ICU day 2; 2: AKI at 36 hours; 3: none; 4: two stays
  // of one admission, AKI during the first (which lasts 12 hours), so the second already has it.
  await writeFile(join(icu, "icustays.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,intime,outtime,creat\n1,10,100,2150-01-02 00:00:00,2150-01-05 00:00:00,1.0\n2,20,200,2150-02-02 00:00:00,2150-02-05 00:00:00,1.1\n3,30,300,2150-03-02 00:00:00,2150-03-05 00:00:00,0.9\n4,40,400,2150-04-02 00:00:00,2150-04-02 12:00:00,1.2\n4,40,401,2150-04-04 00:00:00,2150-04-07 00:00:00,1.3\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const layer = join(directory, "layer", "derived"); await mkdir(layer, { recursive: true });
  await writeFile(join(layer, "derived_events.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,itemid,charttime,valuenum\n1,10,,9000001,2150-01-01 14:00:00,1\n1,10,,9000001,2150-01-03 12:00:00,1\n2,20,,9000001,2150-02-03 12:00:00,1\n4,40,,9000001,2150-04-02 06:00:00,1\n"));
  assert.equal(spawnSync("zip", ["-q", "-r", join(directory, "mimic-derived.zip"), "derived"], { cwd: join(directory, "layer") }).status, 0);
  const icustays = { id: "mimiciv_icu.icustays", schema: "mimiciv_icu" as const, table: "icustays", required_columns: ["subject_id", "hadm_id", "stay_id", "intime", "outtime", "creat"] };
  const derived = { id: "mimiciv_derived.derived_events", schema: "mimiciv_derived" as const, table: "derived_events", required_columns: ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:prediction-before-icu", study_integrity_id: "sha256:prediction-before-icu", data_model: "MIMIC-IV", study_family: "prediction", status: "ready",
    analysis_unit: { source_id: icustays.id, column: "stay_id" }, sources: [icustays, derived],
    joins: [{ left_source_id: icustays.id, right_source_id: derived.id, left_column: "stay_id", right_column: "stay_id", cardinality: "one_to_many" }], variables: [
    { role: "index_time", requested_label: "ICU admission", mapping_id: "icu", mapping_version: "1", source_id: icustays.id, value_type: "categorical", value_rule: { kind: "direct", column: "intime" }, time_column: "intime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "predictor", requested_label: "creatinine", mapping_id: "creat", mapping_version: "1", source_id: icustays.id, value_type: "continuous", value_rule: { kind: "direct", column: "creat" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "acute kidney injury", mapping_id: "aki", mapping_version: "1", source_id: derived.id, value_type: "binary", value_rule: { kind: "item_ids", id_column: "itemid", ids: [9000001], value_column: "valuenum" }, time_column: "charttime", contrast: { kind: "binary_presence" }, temporal_rule: "event", missingness_rule: "absent" },
  ], time_windows: [{ purpose: "baseline", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }, { purpose: "outcome", anchor: "index_time", start_offset: 24, end_offset: 168, unit: "hour" }],
    extraction: { unit_selection: "first_per_subject" }, blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome ?? false]), [["200", true], ["300", false]], "AKI already recorded in the admission is not a new outcome of its ICU stay");
  assert.deepEqual(result.quality.exclusion_reasons, { ended_before_landmark: 1, outcome_before_prediction_time: 2 });
  flowReconciles(result);
});

test("a stay-keyed outcome record of an earlier ICU stay excludes the later stays of the same admission, as an admission-keyed one does", async (context) => {
  // Review of 43ab060: ventilation charted in stay 100 excluded stay 100 but let stay 101 of the same admission in as event-free,
  // while the same record in an admission-keyed table excluded both.
  const directory = await mkdtemp(join(tmpdir(), "mimic-later-stay-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const icu = join(directory, "release", "icu"); await mkdir(icu, { recursive: true });
  // Synthetic. 1: two stays of admission 10, ventilated at hour 2 of the first; 2: one stay, ventilated at hour 30;
  // 3: two stays of admission 30, ventilated at hour 10 of the second only: the first stay is analysed, the second is excluded.
  await writeFile(join(icu, "icustays.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,intime,outtime,exposed\n1,10,100,2150-01-01 00:00:00,2150-01-04 00:00:00,1\n1,10,101,2150-01-10 00:00:00,2150-01-14 00:00:00,0\n2,20,200,2150-02-01 00:00:00,2150-02-05 00:00:00,1\n3,30,300,2150-03-01 00:00:00,2150-03-03 00:00:00,0\n3,30,301,2150-03-06 00:00:00,2150-03-09 00:00:00,1\n"));
  await writeFile(join(icu, "procedureevents.csv.gz"), await gzipAsync("subject_id,hadm_id,stay_id,itemid,starttime\n1,10,100,225792,2150-01-01 02:00:00\n2,20,200,225792,2150-02-02 06:00:00\n3,30,301,225792,2150-03-06 10:00:00\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const icustays = { id: "mimiciv_icu.icustays", schema: "mimiciv_icu" as const, table: "icustays", required_columns: ["subject_id", "hadm_id", "stay_id", "intime", "outtime", "exposed"] };
  const procedures = { id: "mimiciv_icu.procedureevents", schema: "mimiciv_icu" as const, table: "procedureevents", required_columns: ["subject_id", "hadm_id", "stay_id", "itemid", "starttime"] };
  const manifest = (landmark?: number): ExecutionManifest => ({ schema_version: "2.0.0", manifest_id: `manifest:later-stay-${landmark ?? 0}`, study_integrity_id: "sha256:later-stay", data_model: "MIMIC-IV", study_family: "association", status: "ready",
    analysis_unit: { source_id: icustays.id, column: "stay_id" }, sources: [icustays, procedures],
    joins: [{ left_source_id: icustays.id, right_source_id: procedures.id, left_column: "stay_id", right_column: "stay_id", cardinality: "one_to_many" }], variables: [
    { role: "index_time", requested_label: "ICU admission", mapping_id: "icu", mapping_version: "1", source_id: icustays.id, value_type: "categorical", value_rule: { kind: "direct", column: "intime" }, time_column: "intime", temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "exposure", requested_label: "exposure", mapping_id: "exposure", mapping_version: "1", source_id: icustays.id, value_type: "binary", value_rule: { kind: "direct", column: "exposed" }, temporal_rule: "admission", missingness_rule: "exclude" },
    { role: "outcome", requested_label: "invasive ventilation", mapping_id: "imv", mapping_version: "1", source_id: procedures.id, value_type: "binary", value_rule: { kind: "item_ids", id_column: "itemid", ids: [225792], value_column: "itemid" }, time_column: "starttime", contrast: { kind: "binary_presence" }, temporal_rule: "event", missingness_rule: "absent" },
  ], time_windows: [{ purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }], extraction: { unit_selection: "first_per_subject", ...(landmark ? { landmark_hours: landmark } : {}) }, blockers: [] });
  const [landmark, plain] = await new LocalExecutionGraphRunner().runMany(archive, [manifest(24), manifest()]);
  assert.deepEqual(landmark!.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome ?? false]), [["200", true], ["300", false]], "stay 101 had ventilation earlier in its admission; stay 300 is not touched by its later stay's record");
  assert.deepEqual(landmark!.quality.exclusion_reasons, { outcome_before_landmark: 3 }, "stays 100 and 101, and stay 301 ventilated before its own landmark");
  flowReconciles(landmark!);
  assert.deepEqual(plain!.rows.map(({ analysis_id, outcome }) => [analysis_id, outcome ?? false]), [["100", true], ["200", true], ["300", false]], "without a follow-up start nothing changes");
});

test("an ICU-admission study compiled from its mappings analyses each patient's first ICU stay with that stay's own time zero", async (context) => {
  // MIMIC question 3.3 (2026-10-26) was compiled per hospital admission: an admission with two ICU stays took the time zero
  // of whichever stay its file listed first, so a "first-day" value could come from the later stay.
  const directory = await mkdtemp(join(tmpdir(), "mimic-icu-unit-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const tables: Array<[ClinicalDatabaseCatalog["relations"][number]["schema"], string, string]> = [
    ["mimiciv_hosp", "admissions", "subject_id,hadm_id,admittime,dischtime,hospital_expire_flag\n1,10,2150-01-01 00:00:00,2150-01-20 00:00:00,0\n2,20,2150-01-01 00:00:00,2150-01-20 00:00:00,1\n"],
    ["mimiciv_hosp", "diagnoses_icd", "subject_id,hadm_id,icd_code,icd_version\n1,10,I10,10\n"],
    ["mimiciv_hosp", "patients", "subject_id,anchor_age\n1,70\n2,60\n"],
    // Patient 1's admission has two ICU stays, the later one listed first.
    ["mimiciv_icu", "icustays", "subject_id,hadm_id,stay_id,intime,outtime\n1,10,102,2150-01-10 00:00:00,2150-01-12 00:00:00\n1,10,101,2150-01-02 00:00:00,2150-01-05 00:00:00\n2,20,201,2150-01-02 00:00:00,2150-01-05 00:00:00\n"],
    ["mimiciv_icu", "chartevents", "subject_id,hadm_id,stay_id,itemid,charttime,valuenum\n1,10,101,220045,2150-01-02 06:00:00,80\n1,10,102,220045,2150-01-10 06:00:00,130\n2,20,201,220045,2150-01-02 06:00:00,95\n"],
  ];
  for (const [schema, table, rows] of tables) { const folder = join(directory, "release", schema === "mimiciv_icu" ? "icu" : "hosp"); await mkdir(folder, { recursive: true }); await writeFile(join(folder, `${table}.csv.gz`), await gzipAsync(rows)); }
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const catalog: ClinicalDatabaseCatalog = { schema_version: "1.0.0", data_model: "MIMIC-IV", source_service: "local", inspected_at: "2026-10-27T00:00:00.000Z", relation_count: tables.length, column_count: 0,
    relations: tables.map(([schema, name, rows]) => ({ schema, name, relation_type: "table" as const, columns: rows.split("\n")[0]!.split(",").map((column) => ({ name: column, data_type: "text", nullable: true })) })) };
  const variable = (role: StudyVariableMappingReview["variables"][number]["role"], table: string, columns: string[], value_type: VariableMappingRecord["value_type"], source: Partial<VariableMappingRecord["sources"][number]> = {}, aggregation?: "maximum"): StudyVariableMappingReview["variables"][number] => {
    const mapping: VariableMappingRecord = { schema_version: "1.0.0", mapping_id: table, concept_id: table, mapping_version: "1", labels: { en: table }, synonyms: [], category: "outcome", value_type, definition: { summary: table, temporal_rule: "-", value_rule: "-", missingness_rule: "-", ...(aggregation ? { aggregation } : {}) }, sources: [{ kind: "direct_field", schema: tables.find(([, name]) => name === table)![0], table, columns, ...source }], status: "validated", provenance: "team_validation", evidence: {}, created_at: "2026-10-27T00:00:00.000Z", updated_at: "2026-10-27T00:00:00.000Z" };
    return { schema_version: "1.0.0", requested_term: table, role, status: "resolved", candidates: [{ candidate_id: table, requested_term: table, normalized_term: table, role, mapping, match_basis: ["validated_mapping"], confidence: "high", requires_clinician_confirmation: false, explanation: "-" }] };
  };
  const variables = [
    variable("index_time", "icustays", ["subject_id", "hadm_id", "stay_id", "intime", "outtime"], "date_time"),
    variable("exposure", "chartevents", ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"], "continuous", { kind: "dictionary_item", dictionary_table: "d_items", item_ids: [220045] }, "maximum"),
    variable("outcome", "admissions", ["subject_id", "hadm_id", "hospital_expire_flag"], "binary"),
    variable("covariate", "diagnoses_icd", ["subject_id", "hadm_id", "icd_code", "icd_version"], "binary", { codes: [{ code: "I10", version: 10 }] }),
    variable("covariate", "patients", ["subject_id", "anchor_age"], "continuous"),
  ];
  const manifest = compileExecutionManifest({ catalog, mapping: { schema_version: "1.0.0", status: "ready", summary: { resolved: variables.length, needs_confirmation: 0, unmapped: 0 }, verification_available: true, variables },
    study: { schema_version: "1.0.0", intent_family: "association", index_time: { event: "ICU admission", selection_rule: "first ICU stay per patient" }, time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }] } });
  assert.equal(manifest.status, "ready", JSON.stringify(manifest.blockers));
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, exposure, outcome }) => [analysis_id, exposure, outcome]), [["101", 80, false], ["201", 95, true]], "the first stay of patient 1 with its own first-day value");
  assert.deepEqual(result.quality.exclusion_reasons, { not_first_eligible_unit_of_patient: 1 });
});

test("a description keeps every first eligible unit, with its characteristics where recorded, and reads a yes/no characteristic as a presence", async (context) => {
  // Cover audit 2026-11-04 C3: a manifest without an outcome dropped every unit ("row.outcome === undefined"), so a description had 0 rows.
  // 1: first admission survives (later admission 11 dies, not the unit); creatinine at 2 h and again at 28 h (outside the first 24 h);
  // the drug only on day 3. 2: dies in hospital, creatinine and the drug in the first 24 h. 3: neither creatinine nor drug. 4: no heart failure.
  const directory = await mkdtemp(join(tmpdir(), "mimic-description-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const hosp = join(directory, "release", "hosp"); await mkdir(hosp, { recursive: true });
  await writeFile(join(hosp, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,dischtime,deathtime,hospital_expire_flag\n1,10,2150-01-01 08:00:00,2150-01-05 08:00:00,,0\n1,11,2150-03-01 08:00:00,2150-03-05 08:00:00,2150-03-04 08:00:00,1\n2,20,2150-01-01 08:00:00,2150-01-03 08:00:00,2150-01-03 07:00:00,1\n3,30,2150-01-01 08:00:00,2150-01-04 08:00:00,,0\n4,40,2150-01-01 08:00:00,2150-01-04 08:00:00,,0\n"));
  await writeFile(join(hosp, "diagnoses_icd.csv.gz"), await gzipAsync("subject_id,hadm_id,icd_code,icd_version\n1,10,I509,10\n1,11,I509,10\n2,20,I509,10\n3,30,I509,10\n4,40,J189,10\n"));
  await writeFile(join(hosp, "labevents.csv.gz"), await gzipAsync("subject_id,hadm_id,itemid,charttime,valuenum\n1,10,50912,2150-01-01 10:00:00,1.1\n1,10,50912,2150-01-02 12:00:00,4.0\n2,20,50912,2150-01-01 09:00:00,2.3\n"));
  await writeFile(join(hosp, "prescriptions.csv.gz"), await gzipAsync("subject_id,hadm_id,drug,starttime\n2,20,Metoprolol,2150-01-01 12:00:00\n1,10,Metoprolol,2150-01-03 12:00:00\n"));
  await writeFile(join(hosp, "patients.csv.gz"), await gzipAsync("subject_id,gender,anchor_age\n1,M,70\n2,F,80\n3,F,60\n4,M,50\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const source = (table: string, required_columns: string[]) => ({ id: `mimiciv_hosp.${table}`, schema: "mimiciv_hosp" as const, table, required_columns });
  const admissions = source("admissions", ["subject_id", "hadm_id", "admittime", "dischtime", "deathtime", "hospital_expire_flag"]);
  const diagnoses = source("diagnoses_icd", ["subject_id", "hadm_id", "icd_code", "icd_version"]);
  const labs = source("labevents", ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"]);
  const drugs = source("prescriptions", ["subject_id", "hadm_id", "drug", "starttime"]);
  const patients = source("patients", ["subject_id", "gender", "anchor_age"]);
  const join_ = (right: { id: string }, column: string) => ({ left_source_id: admissions.id, right_source_id: right.id, left_column: column, right_column: column, cardinality: "one_to_many" as const });
  const heartFailure = { condition_id: "population.target", source_text: "心衰", kind: "concept" as const, concept: "Heart failure", assertion: "present" as const };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:description", study_integrity_id: "sha256:description", data_model: "MIMIC-IV", study_family: "association", status: "ready",
    analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions, diagnoses, labs, drugs, patients], joins: [join_(diagnoses, "hadm_id"), join_(labs, "hadm_id"), join_(drugs, "hadm_id"), join_(patients, "subject_id")],
    population_predicate: heartFailure, extraction: { unit_selection: "first_per_subject" },
    time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }, { purpose: "baseline", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }, { purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" }],
    variables: [
      { role: "population", condition_id: "population.target", semantic_condition: heartFailure, requested_label: "Heart failure", mapping_id: "hf", mapping_version: "1", source_id: diagnoses.id, value_type: "binary", value_rule: { kind: "codes", code_column: "icd_code", version_column: "icd_version", codes: [{ code: "I509", version: 10 }] }, temporal_rule: "admission", missingness_rule: "absent" },
      { role: "index_time", requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: admissions.id, value_type: "categorical", value_rule: { kind: "direct", column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" },
      { role: "exposure", requested_label: "Beta blockers", mapping_id: "bb", mapping_version: "1", source_id: drugs.id, value_type: "binary", value_rule: { kind: "matching_values", column: "drug", values: ["Metoprolol"] }, time_column: "starttime", contrast: { kind: "binary_presence" }, aggregation: "any", temporal_rule: "exposure window", missingness_rule: "absent" },
      { role: "outcome", characteristic: true, condition_id: "characteristic.1", requested_label: "In-hospital mortality", mapping_id: "death", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "direct", column: "hospital_expire_flag" }, time_column: "deathtime", contrast: { kind: "binary_presence" }, aggregation: "any", temporal_rule: "encounter", missingness_rule: "alive" },
      { role: "covariate", characteristic: true, condition_id: "characteristic.2", requested_label: "Creatinine", mapping_id: "creat", mapping_version: "1", source_id: labs.id, value_type: "continuous", value_rule: { kind: "item_ids", id_column: "itemid", ids: [50912], value_column: "valuenum" }, time_column: "charttime", aggregation: "first", temporal_rule: "first 24 h", missingness_rule: "missing" },
      { role: "covariate", requested_label: "Sex", mapping_id: "sex", mapping_version: "1", source_id: patients.id, value_type: "categorical", value_rule: { kind: "direct", column: "gender" }, temporal_rule: "baseline", missingness_rule: "exclude" },
    ], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows, [
    { analysis_id: "10", exposure: false, characteristic_0: false, characteristic_1: 1.1, covariate_0: "M" },
    { analysis_id: "20", exposure: true, characteristic_0: true, characteristic_1: 2.3, covariate_0: "F" },
    { analysis_id: "30", exposure: false, characteristic_0: false, covariate_0: "F" },
  ], "every first eligible admission is kept; a survivor is 'no', a missing creatinine stays missing");
  assert.deepEqual(result.quality.exclusion_reasons, { not_in_population: 1, not_first_eligible_unit_of_patient: 1 }, "nothing is excluded for a missing characteristic or grouping");
  assert.equal(result.quality.complete_rows, 3);
  assert.deepEqual(result.columns?.map(({ column, role, characteristic }) => [column, role, Boolean(characteristic)]), [["exposure", "exposure", false], ["characteristic_0", "outcome", true], ["characteristic_1", "covariate", true], ["covariate_0", "covariate", false]]);
});

test("a description with no outcome-type characteristic and no grouping still keeps every unit (the C3 zero-row case)", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-description-plain-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const hosp = join(directory, "release", "hosp"); await mkdir(hosp, { recursive: true });
  await writeFile(join(hosp, "admissions.csv.gz"), await gzipAsync("subject_id,hadm_id,admittime,admission_type\n1,10,2150-01-01 08:00:00,EW EMER.\n2,20,2150-01-01 08:00:00,ELECTIVE\n3,30,2150-01-01 08:00:00,\n"));
  const archive = join(directory, "mimic.zip"); assert.equal(spawnSync("zip", ["-q", "-r", archive, "release"], { cwd: directory }).status, 0);
  const admissions = { id: "mimiciv_hosp.admissions", schema: "mimiciv_hosp" as const, table: "admissions", required_columns: ["subject_id", "hadm_id", "admittime", "admission_type"] };
  const manifest: ExecutionManifest = { schema_version: "2.0.0", manifest_id: "manifest:description-plain", study_integrity_id: "sha256:plain", data_model: "MIMIC-IV", study_family: "association", status: "ready",
    analysis_unit: { source_id: admissions.id, column: "hadm_id" }, sources: [admissions], joins: [], extraction: { unit_selection: "first_per_subject" }, time_windows: [{ purpose: "baseline", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" }],
    variables: [
      { role: "index_time", requested_label: "hospital admission", mapping_id: "adm", mapping_version: "1", source_id: admissions.id, value_type: "categorical", value_rule: { kind: "direct", column: "admittime" }, time_column: "admittime", temporal_rule: "admission", missingness_rule: "exclude" },
      { role: "covariate", characteristic: true, condition_id: "characteristic.1", requested_label: "Emergency admission", mapping_id: "emergency", mapping_version: "1", source_id: admissions.id, value_type: "binary", value_rule: { kind: "matching_values", column: "admission_type", values: ["EW EMER."] }, contrast: { kind: "binary_presence" }, aggregation: "any", temporal_rule: "admission", missingness_rule: "absent" },
    ], blockers: [] };
  const result = await new LocalExecutionGraphRunner().run(archive, manifest);
  assert.deepEqual(result.rows.map(({ analysis_id, characteristic_0 }) => [analysis_id, characteristic_0]), [["10", true], ["20", false], ["30", false]]);
  assert.deepEqual(result.quality.exclusion_reasons, {});
});
