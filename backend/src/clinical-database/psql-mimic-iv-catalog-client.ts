import { spawn } from "node:child_process";
import { isClinicalDatabaseRelation, type ClinicalDatabaseCatalogSource, type ClinicalDatabaseRelation } from "./database-catalog.js";
import { ClinicalDatabaseError } from "./database-preflight.js";

export interface PsqlCatalogRunner {
  run(input: { binary: string; arguments_: string[]; environment: NodeJS.ProcessEnv }): Promise<{ exitCode: number; stdout: string }>;
}

const defaultRunner: PsqlCatalogRunner = {
  run: async ({ binary, arguments_, environment }) => new Promise((resolve, reject) => {
    const child = spawn(binary, arguments_, { env: environment, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 1_000_000) chunks.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", () => reject(new ClinicalDatabaseError("DATABASE_CLIENT_UNAVAILABLE", "The PostgreSQL catalog client could not start.")));
    child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout: Buffer.concat(chunks).toString("utf8") }));
  }),
};

const fixedCatalogQuery = (statementTimeoutMs: number): string => `
BEGIN READ ONLY;
SET LOCAL statement_timeout = '${statementTimeoutMs}ms';
SELECT COALESCE(json_agg(relation ORDER BY relation->>'schema', relation->>'name'), '[]'::json)::text
FROM (
  SELECT json_build_object(
    'schema', table_schema,
    'name', table_name,
    'relation_type', CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END,
    'columns', (
      SELECT COALESCE(json_agg(json_build_object(
        'name', column_name,
        'data_type', data_type,
        'nullable', is_nullable = 'YES'
      ) ORDER BY ordinal_position), '[]'::json)
      FROM information_schema.columns column_catalog
      WHERE column_catalog.table_schema = relation_catalog.table_schema
        AND column_catalog.table_name = relation_catalog.table_name
    )
  ) AS relation
  FROM information_schema.tables relation_catalog
  WHERE table_schema IN ('mimiciv_hosp', 'mimiciv_icu', 'mimiciv_derived')
    AND table_type IN ('BASE TABLE', 'VIEW')
) catalog;
ROLLBACK;
`;

export class PsqlMimicIvCatalogClient implements ClinicalDatabaseCatalogSource {
  constructor(
    private readonly settings: { service: string; binary: string; connect_timeout_seconds: number; statement_timeout_ms: number },
    private readonly runner: PsqlCatalogRunner = defaultRunner,
  ) {}

  async inspect(): Promise<ClinicalDatabaseRelation[]> {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(this.settings.service)) throw new ClinicalDatabaseError("DATABASE_CONFIG_INVALID", "The PostgreSQL service name is invalid.");
    const result = await this.runner.run({
      binary: this.settings.binary,
      arguments_: ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-At", "-c", fixedCatalogQuery(this.settings.statement_timeout_ms)],
      environment: { ...process.env, PGSERVICE: this.settings.service, PGCONNECT_TIMEOUT: String(this.settings.connect_timeout_seconds) },
    });
    if (result.exitCode !== 0) throw new ClinicalDatabaseError("DATABASE_CONNECTION_FAILED", "The approved PostgreSQL catalog could not be read with non-interactive authentication.");
    const jsonLine = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.startsWith("["));
    if (!jsonLine) throw new ClinicalDatabaseError("DATABASE_RESPONSE_INVALID", "The PostgreSQL catalog response was missing.");
    let parsed: unknown;
    try { parsed = JSON.parse(jsonLine); } catch { throw new ClinicalDatabaseError("DATABASE_RESPONSE_INVALID", "The PostgreSQL catalog response was invalid."); }
    if (!Array.isArray(parsed) || !parsed.every(isClinicalDatabaseRelation)) throw new ClinicalDatabaseError("DATABASE_RESPONSE_INVALID", "The PostgreSQL catalog response did not match its contract.");
    return parsed;
  }
}
