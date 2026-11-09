import { pathToFileURL } from "node:url";
import { ClinicalDatabaseError, ClinicalDatabasePreflightService, PsqlMimicIvMetadataClient } from "../clinical-database/index.js";
import { resolveBackendRuntimeConfig } from "../runtime/index.js";

const cliValue = (arguments_: string[], name: string): string | undefined => {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
};

export const inspectClinicalDatabase = async (arguments_: string[] = [], environment: NodeJS.ProcessEnv = process.env) => {
  const service = cliValue(arguments_, "--service") ?? environment.PGSERVICE;
  const psqlBinary = cliValue(arguments_, "--psql-binary");
  const config = resolveBackendRuntimeConfig({
    environment: {
      clinical_database: {
        enabled: true,
        ...(service ? { service } : {}),
        ...(psqlBinary ? { psql_binary: psqlBinary } : {}),
      },
    },
  });
  const settings = config.clinical_database;
  return new ClinicalDatabasePreflightService(new PsqlMimicIvMetadataClient({
    service: settings.service,
    binary: settings.psql_binary,
    connect_timeout_seconds: settings.connect_timeout_seconds,
    statement_timeout_ms: settings.statement_timeout_ms,
  })).inspect();
};

const main = async (): Promise<void> => {
  const report = await inspectClinicalDatabase(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "ready") process.exitCode = 2;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const safeMessage = error instanceof ClinicalDatabaseError ? `${error.code}: ${error.message}` : "DATABASE_PREFLIGHT_FAILED: The database preflight failed.";
    process.stderr.write(`${safeMessage}\n`);
    process.exitCode = 1;
  });
}
