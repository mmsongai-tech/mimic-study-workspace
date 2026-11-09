import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ClinicalDatabaseCatalogSnapshotService, ClinicalDatabaseError, FileClinicalDatabaseCatalogSnapshotRepository, type ClinicalDatabaseCatalog } from "../index.js";

const catalog: ClinicalDatabaseCatalog = {
  schema_version: "1.0.0",
  data_model: "MIMIC-IV",
  source_service: "approved-mimic-service",
  relations: [{
    schema: "mimiciv_hosp",
    name: "admissions",
    relation_type: "table",
    columns: [
      { name: "hadm_id", data_type: "bigint", nullable: false },
      { name: "hospital_expire_flag", data_type: "integer", nullable: false },
    ],
  }],
  relation_count: 1,
  column_count: 2,
  inspected_at: "2026-09-02T00:00:00.000Z",
};

test("stores and loads an integrity-checked catalog without a database connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-catalog-snapshot-"));
  const filename = join(directory, "catalog.json");
  const service = new ClinicalDatabaseCatalogSnapshotService(
    new FileClinicalDatabaseCatalogSnapshotRepository(filename),
  );
  try {
    const stored = await service.store(catalog);
    assert.match(stored.integrity_id, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(await service.load(), stored);
    assert.equal((await readFile(filename, "utf8")).includes("hadm_id"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when the local catalog is missing or has been changed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-catalog-snapshot-"));
  const filename = join(directory, "catalog.json");
  const service = new ClinicalDatabaseCatalogSnapshotService(
    new FileClinicalDatabaseCatalogSnapshotRepository(filename),
  );
  try {
    await assert.rejects(
      () => service.load(),
      (error: unknown) => error instanceof ClinicalDatabaseError && error.code === "DATABASE_SNAPSHOT_NOT_FOUND",
    );
    await service.store(catalog);
    const changed = JSON.parse(await readFile(filename, "utf8")) as { catalog: ClinicalDatabaseCatalog };
    changed.catalog.relations[0]!.columns[0]!.name = "changed_column";
    await writeFile(filename, JSON.stringify(changed));
    await assert.rejects(
      () => service.load(),
      (error: unknown) => error instanceof ClinicalDatabaseError && error.code === "DATABASE_SNAPSHOT_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads the shipped MIMIC-IV catalog snapshot through its integrity check", async () => {
  const shipped = fileURLToPath(new URL("../../../../config/mimic-iv-catalog/mimic-iv-catalog.snapshot.json", import.meta.url));
  const snapshot = await new ClinicalDatabaseCatalogSnapshotService(new FileClinicalDatabaseCatalogSnapshotRepository(shipped)).load();
  assert.equal(snapshot.catalog.data_model, "MIMIC-IV");
  assert.equal(snapshot.catalog.source_service, "mimic-iv");
  assert.equal(snapshot.catalog.relation_count > 0, true);
});
