import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AssociationAnalysisError, SqliteSafetyLactateMortalityGateway } from "../index.js";

const mapping = {
  table: "analysis_cohort",
  subject_id: "person_id",
  lactate: "lactate_max_6h",
  in_hospital_death: "hospital_death",
  age: "age_years",
  sex: "sex",
};

test("loads only mapped fields from an approved SQLite database in read-only mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "safety-gateway-test-"));
  const filename = join(directory, "safety.sqlite");
  const database = new DatabaseSync(filename);
  database.exec("CREATE TABLE analysis_cohort (person_id TEXT, lactate_max_6h REAL, hospital_death INTEGER, age_years REAL, sex TEXT, private_note TEXT)");
  database.prepare("INSERT INTO analysis_cohort VALUES (?, ?, ?, ?, ?, ?)").run("P-001", 3.4, 1, 67, "female", "must-not-leave-database");
  database.close();
  try {
    const gateway = new SqliteSafetyLactateMortalityGateway({
      database_path: filename,
      data_source_id: "approved-safety-cohort",
      data_source_version: "1.0.0",
      mapping,
      now: () => new Date("2026-08-31T12:00:00.000Z"),
    });
    const input = await gateway.load();
    assert.deepEqual(input.records, [{
      synthetic_subject_id: "P-001",
      max_lactate_first_6h: 3.4,
      in_hospital_death: true,
      age_years: 67,
      sex: "female",
    }]);
    assert.equal(input.provenance.data_mode, "approved_safety_database");
    assert.doesNotMatch(JSON.stringify(input), /must-not-leave/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unsafe identifiers before opening the safety database", async () => {
  const gateway = new SqliteSafetyLactateMortalityGateway({
    database_path: "/not/opened.sqlite",
    data_source_id: "approved-safety-cohort",
    data_source_version: "1.0.0",
    mapping: { ...mapping, table: "analysis_cohort; DROP TABLE users" },
  });
  await assert.rejects(
    gateway.load(),
    (error: unknown) => error instanceof AssociationAnalysisError && error.code === "ANALYSIS_INPUT_INVALID",
  );
});
