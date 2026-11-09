import { pathToFileURL } from "node:url";
import { ClinicalDatabaseCatalogService, ClinicalDatabaseCatalogSnapshotService, ClinicalDatabaseError, ClinicalDatabasePreflightService, FileClinicalDatabaseCatalogSnapshotRepository, PsqlMimicIvCatalogClient, PsqlMimicIvMetadataClient } from "../clinical-database/index.js";
import { resolveBackendRuntimeConfig } from "../runtime/index.js";

const cliValue = (arguments_: string[], name: string): string | undefined => {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
};

export const inspectClinicalDatabaseCatalog = async (arguments_: string[] = [], environment: NodeJS.ProcessEnv = process.env) => {
  const service = cliValue(arguments_, "--service") ?? environment.PGSERVICE;
  const psqlBinary = cliValue(arguments_, "--psql-binary");
  const config = resolveBackendRuntimeConfig({ environment: { clinical_database: { enabled: true, ...(service ? { service } : {}), ...(psqlBinary ? { psql_binary: psqlBinary } : {}) } } });
  const settings = config.clinical_database;
  const connection = { service: settings.service, binary: settings.psql_binary, connect_timeout_seconds: settings.connect_timeout_seconds, statement_timeout_ms: settings.statement_timeout_ms };
  const preflight = await new ClinicalDatabasePreflightService(new PsqlMimicIvMetadataClient(connection)).inspect();
  if (preflight.status !== "ready") throw new ClinicalDatabaseError("DATABASE_CONNECTION_FAILED", "The MIMIC-IV catalog is blocked because the database preflight did not pass.");
  const catalog = await new ClinicalDatabaseCatalogService(new PsqlMimicIvCatalogClient(connection), { service: settings.service }).inspect();
  await new ClinicalDatabaseCatalogSnapshotService(
    new FileClinicalDatabaseCatalogSnapshotRepository(settings.catalog_snapshot_path),
  ).store(catalog);
  return catalog;
};

const main = async (): Promise<void> => { process.stdout.write(`${JSON.stringify(await inspectClinicalDatabaseCatalog(process.argv.slice(2)), null, 2)}\n`); };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof ClinicalDatabaseError ? `${error.code}: ${error.message}` : "DATABASE_CATALOG_FAILED: The MIMIC-IV catalog inspection failed.";
    process.stderr.write(`${message}\n`); process.exitCode = 1;
  });
}
