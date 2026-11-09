import assert from "node:assert/strict";
import test from "node:test";
import { ClinicalDatabaseCatalogService, ClinicalDatabaseError, PsqlMimicIvCatalogClient, type PsqlCatalogRunner } from "../index.js";

const relations = [{ schema: "mimiciv_hosp", name: "admissions", relation_type: "table", columns: [{ name: "hadm_id", data_type: "bigint", nullable: false }] }] as const;

test("reads only the MIMIC-IV information-schema catalog in a read-only transaction", async () => {
  let observed: Parameters<PsqlCatalogRunner["run"]>[0] | undefined;
  const runner: PsqlCatalogRunner = { run: async (input) => { observed = input; return { exitCode: 0, stdout: `${JSON.stringify(relations)}\n` }; } };
  const source = new PsqlMimicIvCatalogClient({ service: "mimic-iv", binary: "psql", connect_timeout_seconds: 5, statement_timeout_ms: 5_000 }, runner);
  const catalog = await new ClinicalDatabaseCatalogService(source, { service: "mimic-iv", now: () => new Date("2026-09-01T00:00:00.000Z") }).inspect();
  assert.equal(catalog.relation_count, 1);
  assert.equal(catalog.column_count, 1);
  assert.equal(catalog.relations[0]?.columns[0]?.name, "hadm_id");
  assert.match(JSON.stringify(observed?.arguments_), /BEGIN READ ONLY/u);
  assert.match(JSON.stringify(observed?.arguments_), /information_schema\.columns/u);
  assert.doesNotMatch(JSON.stringify(observed?.arguments_), /SELECT\s+\*/iu);
});

test("rejects malformed catalog output and does not expose client output", async () => {
  const runner: PsqlCatalogRunner = { run: async () => ({ exitCode: 0, stdout: "[{\"schema\":\"private\"}]\n" }) };
  await assert.rejects(
    () => new PsqlMimicIvCatalogClient({ service: "mimic-iv", binary: "psql", connect_timeout_seconds: 5, statement_timeout_ms: 5_000 }, runner).inspect(),
    (error: unknown) => error instanceof ClinicalDatabaseError && error.code === "DATABASE_RESPONSE_INVALID" && !error.message.includes("private"),
  );
});
