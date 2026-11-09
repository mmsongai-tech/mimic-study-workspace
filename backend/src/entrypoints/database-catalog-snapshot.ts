import { pathToFileURL } from "node:url";
import { ClinicalDatabaseCatalogSnapshotService, ClinicalDatabaseError, FileClinicalDatabaseCatalogSnapshotRepository } from "../clinical-database/index.js";
import { resolveBackendRuntimeConfig } from "../runtime/index.js";

export const loadClinicalDatabaseCatalogSnapshot = async (filename?: string) => {
  const config = resolveBackendRuntimeConfig(
    filename ? { cli: { clinical_database: { catalog_snapshot_path: filename } } } : {},
  );
  return new ClinicalDatabaseCatalogSnapshotService(
    new FileClinicalDatabaseCatalogSnapshotRepository(config.clinical_database.catalog_snapshot_path),
  ).load();
};

const main = async (): Promise<void> => {
  const filenameIndex = process.argv.indexOf("--snapshot");
  const filename = filenameIndex >= 0 ? process.argv[filenameIndex + 1] : undefined;
  process.stdout.write(`${JSON.stringify(await loadClinicalDatabaseCatalogSnapshot(filename), null, 2)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof ClinicalDatabaseError ? `${error.code}: ${error.message}` : "DATABASE_SNAPSHOT_INVALID: The local MIMIC-IV catalog snapshot could not be loaded.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
