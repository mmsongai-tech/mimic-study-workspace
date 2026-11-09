import { spawn } from "node:child_process";
import type { ClinicalDatabaseMetadata } from "./database-preflight.js";
import { ClinicalDatabaseError } from "./database-preflight.js";

export interface PsqlRunner {
  run(input: { binary: string; arguments_: string[]; environment: NodeJS.ProcessEnv }): Promise<{ exitCode: number; stdout: string }>;
}

const defaultRunner: PsqlRunner = {
  run: async ({ binary, arguments_, environment }) => new Promise((resolve, reject) => {
    const child = spawn(binary, arguments_, { env: environment, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64_000) chunks.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", () => reject(new ClinicalDatabaseError("DATABASE_CLIENT_UNAVAILABLE", "The PostgreSQL client could not start.")));
    child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout: Buffer.concat(chunks).toString("utf8") }));
  }),
};

const fixedMetadataQuery = (statementTimeoutMs: number): string => `
BEGIN READ ONLY;
SET LOCAL statement_timeout = '${statementTimeoutMs}ms';
SELECT json_build_object(
  'database', current_database(),
  'database_user', current_user,
  'server_version', current_setting('server_version'),
  'transaction_read_only', current_setting('transaction_read_only') = 'on',
  'available_schemas', COALESCE((
    SELECT json_agg(nspname ORDER BY nspname)
    FROM pg_namespace
    WHERE nspname IN ('mimiciv_hosp', 'mimiciv_icu', 'mimiciv_derived')
  ), '[]'::json),
  'writable_mimic_table_privilege_count', (
    SELECT count(*)
    FROM information_schema.tables
    WHERE table_schema IN ('mimiciv_hosp', 'mimiciv_icu', 'mimiciv_derived')
      AND (
        has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'INSERT')
        OR has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'UPDATE')
        OR has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'DELETE')
        OR has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'TRUNCATE')
      )
  ),
  'can_create_in_database', has_database_privilege(current_user, current_database(), 'CREATE'),
  'can_create_in_mimic_schemas', EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname IN ('mimiciv_hosp', 'mimiciv_icu', 'mimiciv_derived')
      AND has_schema_privilege(current_user, oid, 'CREATE')
  )
)::text;
ROLLBACK;
`;

const isMetadata = (value: unknown): value is ClinicalDatabaseMetadata => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.database === "string"
    && typeof item.database_user === "string"
    && typeof item.server_version === "string"
    && typeof item.transaction_read_only === "boolean"
    && Array.isArray(item.available_schemas)
    && item.available_schemas.every((schema) => typeof schema === "string")
    && Number.isInteger(item.writable_mimic_table_privilege_count)
    && typeof item.can_create_in_database === "boolean"
    && typeof item.can_create_in_mimic_schemas === "boolean";
};

export class PsqlMimicIvMetadataClient {
  constructor(
    private readonly settings: { service: string; binary: string; connect_timeout_seconds: number; statement_timeout_ms: number },
    private readonly runner: PsqlRunner = defaultRunner,
  ) {}

  async inspect(): Promise<ClinicalDatabaseMetadata> {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(this.settings.service)) {
      throw new ClinicalDatabaseError("DATABASE_CONFIG_INVALID", "The PostgreSQL service name is invalid.");
    }
    const result = await this.runner.run({
      binary: this.settings.binary,
      arguments_: ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-At", "-c", fixedMetadataQuery(this.settings.statement_timeout_ms)],
      environment: {
        ...process.env,
        PGSERVICE: this.settings.service,
        PGCONNECT_TIMEOUT: String(this.settings.connect_timeout_seconds),
      },
    });
    if (result.exitCode !== 0) {
      throw new ClinicalDatabaseError("DATABASE_CONNECTION_FAILED", "The approved PostgreSQL service could not be reached with non-interactive authentication.");
    }
    const jsonLine = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.startsWith("{"));
    if (!jsonLine) throw new ClinicalDatabaseError("DATABASE_RESPONSE_INVALID", "The PostgreSQL metadata response was missing.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonLine);
    } catch {
      throw new ClinicalDatabaseError("DATABASE_RESPONSE_INVALID", "The PostgreSQL metadata response was invalid.");
    }
    if (!isMetadata(parsed)) throw new ClinicalDatabaseError("DATABASE_RESPONSE_INVALID", "The PostgreSQL metadata response did not match its contract.");
    return parsed;
  }
}
