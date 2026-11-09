import assert from "node:assert/strict";
import test from "node:test";
import { ClinicalDatabaseError, ClinicalDatabasePreflightService, PsqlMimicIvMetadataClient, type PsqlRunner } from "../index.js";

const metadata = {
  database: "mimiciv",
  database_user: "read_only_role",
  server_version: "16.4",
  transaction_read_only: true,
  available_schemas: ["mimiciv_derived", "mimiciv_hosp", "mimiciv_icu"],
  writable_mimic_table_privilege_count: 0,
  can_create_in_database: false,
  can_create_in_mimic_schemas: false,
};

test("uses a PostgreSQL service without placing credentials in process arguments", async () => {
  let observed: Parameters<PsqlRunner["run"]>[0] | undefined;
  const runner: PsqlRunner = {
    run: async (input) => {
      observed = input;
      return { exitCode: 0, stdout: `${JSON.stringify(metadata)}\n` };
    },
  };
  const result = await new PsqlMimicIvMetadataClient({ service: "mimic-iv", binary: "psql", connect_timeout_seconds: 5, statement_timeout_ms: 5_000 }, runner).inspect();
  assert.equal(result.database, "mimiciv");
  assert.equal(observed?.environment.PGSERVICE, "mimic-iv");
  assert.equal(observed?.environment.PGCONNECT_TIMEOUT, "5");
  assert.doesNotMatch(JSON.stringify(observed?.arguments_), /password|patient|select\s+\*/iu);
  assert.match(JSON.stringify(observed?.arguments_), /BEGIN READ ONLY/u);
});

test("accepts only a non-writing role with required MIMIC-IV schemas", async () => {
  const report = await new ClinicalDatabasePreflightService({ inspect: async () => metadata }).inspect();
  assert.equal(report.status, "ready");
  assert.deepEqual(report.blocking_reasons, []);
});

test("blocks write privileges and missing core schemas", async () => {
  const report = await new ClinicalDatabasePreflightService({
    inspect: async () => ({ ...metadata, available_schemas: ["mimiciv_hosp"], writable_mimic_table_privilege_count: 1 }),
  }).inspect();
  assert.equal(report.status, "blocked");
  assert.ok(report.blocking_reasons.some((reason) => reason.includes("write privileges")));
  assert.ok(report.blocking_reasons.some((reason) => reason.includes("mimiciv_icu")));
});

test("fails safely without exposing psql error output", async () => {
  const runner: PsqlRunner = { run: async () => ({ exitCode: 2, stdout: "" }) };
  await assert.rejects(
    () => new PsqlMimicIvMetadataClient({ service: "mimic-iv", binary: "psql", connect_timeout_seconds: 5, statement_timeout_ms: 5_000 }, runner).inspect(),
    (error: unknown) => error instanceof ClinicalDatabaseError && error.code === "DATABASE_CONNECTION_FAILED" && !error.message.includes("host"),
  );
});
