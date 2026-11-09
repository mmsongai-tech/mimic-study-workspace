import assert from "node:assert/strict";
import test from "node:test";
import {
  PsqlMimicIvLactateMortalityGateway,
  type PsqlLactateCohortRunner,
} from "../index.js";

test("loads only de-identified approved MIMIC-IV cohort fields", async () => {
  let invocation: Parameters<PsqlLactateCohortRunner["run"]>[0] | undefined;
  const runner: PsqlLactateCohortRunner = {
    run: async (input) => {
      invocation = input;
      return {
        exitCode: 0,
        stdout: [
          "BEGIN",
          "record_type,analysis_record_id,max_lactate_first_6h,hospital_expire_flag,age_years,gender,eligible_first_admissions,missing_lactate,excluded_measurements",
          "AUDIT,,,,,,5,3,1",
          "RECORD,ROW-000001,1.7,0,61,M,,",
          "RECORD,ROW-000002,3.4,1,72,F,,",
          "ROLLBACK",
        ].join("\n"),
      };
    },
  };
  const input = await new PsqlMimicIvLactateMortalityGateway({
    service: "mimic-iv",
    binary: "psql",
    connect_timeout_seconds: 5,
    query_path: "/approved/cohort.sql",
  }, runner, () => new Date("2026-09-01T09:00:00.000Z")).load();

  assert.equal(input.records.length, 2);
  assert.deepEqual(input.records[1], {
    synthetic_subject_id: "ROW-000002",
    max_lactate_first_6h: 3.4,
    in_hospital_death: true,
    age_years: 72,
    sex: "female",
  });
  assert.equal(input.provenance.data_source_id, "mimic-iv-company-readonly");
  assert.deepEqual(input.provenance.cohort_audit, {
    eligible_first_admissions: 5,
    missing_lactate: 3,
    excluded_measurements: 1,
  });
  assert.deepEqual(invocation?.arguments_.slice(0, 4), ["-X", "-w", "-v", "ON_ERROR_STOP=1"]);
  assert.equal(invocation?.environment.PGSERVICE, "mimic-iv");
  assert.doesNotMatch(JSON.stringify(input), /"(?:subject_id|hadm_id|stay_id)":/u);
});

test("fails closed when a cohort row violates the approved contract", async () => {
  const runner: PsqlLactateCohortRunner = {
    run: async () => ({
      exitCode: 0,
      stdout: "record_type,analysis_record_id,max_lactate_first_6h,hospital_expire_flag,age_years,gender,eligible_first_admissions,missing_lactate,excluded_measurements\nAUDIT,,,,,,1,0,0\nRECORD,ROW-000001,999,0,61,M,,,\n",
    }),
  };
  await assert.rejects(
    () => new PsqlMimicIvLactateMortalityGateway({
      service: "mimic-iv",
      binary: "psql",
      connect_timeout_seconds: 5,
      query_path: "/approved/cohort.sql",
    }, runner).load(),
    /approved contract/u,
  );
});
