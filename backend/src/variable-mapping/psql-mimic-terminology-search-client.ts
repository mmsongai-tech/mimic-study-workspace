import { spawn } from "node:child_process";
import { VariableMappingError } from "./variable-mapping.js";
import type { MimicTerminologyMatch, MimicTerminologySearchGateway } from "./terminology-gateway.js";

export interface PsqlTerminologyRunner {
  run(input: { binary: string; arguments_: string[]; environment: NodeJS.ProcessEnv }): Promise<{ exitCode: number; stdout: string }>;
}

const defaultRunner: PsqlTerminologyRunner = {
  run: async ({ binary, arguments_, environment }) => new Promise((resolve, reject) => {
    const child = spawn(binary, arguments_, { env: environment, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = []; let size = 0;
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 500_000) chunks.push(chunk); else child.kill("SIGKILL"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") }));
  }),
};

const query = (statementTimeoutMs: number): string => `
BEGIN READ ONLY;
SET LOCAL statement_timeout = '${statementTimeoutMs}ms';
SELECT COALESCE(json_agg(match ORDER BY match->>'dictionary', match->>'label'), '[]'::json)::text
FROM (
  SELECT json_build_object('dictionary','d_labitems','identifier',itemid::text,'label',label,'category',category) AS match
  FROM mimiciv_hosp.d_labitems WHERE label ILIKE '%' || :'search' || '%' LIMIT 20
  UNION ALL
  SELECT json_build_object('dictionary','d_items','identifier',itemid::text,'label',label,'category',category)
  FROM mimiciv_icu.d_items WHERE label ILIKE '%' || :'search' || '%' LIMIT 20
  UNION ALL
  SELECT json_build_object('dictionary','d_icd_diagnoses','identifier',icd_code,'label',long_title,'code_version',icd_version)
  FROM mimiciv_hosp.d_icd_diagnoses WHERE long_title ILIKE '%' || :'search' || '%' LIMIT 20
  UNION ALL
  SELECT json_build_object('dictionary','d_icd_procedures','identifier',icd_code,'label',long_title,'code_version',icd_version)
  FROM mimiciv_hosp.d_icd_procedures WHERE long_title ILIKE '%' || :'search' || '%' LIMIT 20
) matches;
ROLLBACK;`;

export class PsqlMimicTerminologySearchClient implements MimicTerminologySearchGateway {
  constructor(
    private readonly settings: { service: string; binary: string; connect_timeout_seconds: number; statement_timeout_ms: number },
    private readonly runner: PsqlTerminologyRunner = defaultRunner,
  ) {}

  async search(term: string): Promise<MimicTerminologyMatch[]> {
    const cleaned = term.normalize("NFKC").trim();
    if (cleaned.length < 2 || cleaned.length > 120 || /[\u0000-\u001f]/u.test(cleaned)) throw new VariableMappingError("MAPPING_INVALID", "The terminology search term is invalid.");
    let result: { exitCode: number; stdout: string };
    try {
      result = await this.runner.run({
        binary: this.settings.binary,
        arguments_: ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-v", `search=${cleaned}`, "-At", "-c", query(this.settings.statement_timeout_ms)],
        environment: { ...process.env, PGSERVICE: this.settings.service, PGCONNECT_TIMEOUT: String(this.settings.connect_timeout_seconds) },
      });
    } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The MIMIC terminology search client could not start."); }
    if (result.exitCode !== 0) throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The MIMIC terminology dictionaries are unavailable.");
    const line = result.stdout.split(/\r?\n/u).map((item) => item.trim()).find((item) => item.startsWith("["));
    if (!line) throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The MIMIC terminology search returned no valid response.");
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The MIMIC terminology search response was invalid."); }
    if (!Array.isArray(parsed)) throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The MIMIC terminology search response was invalid.");
    return parsed.filter((item): item is MimicTerminologyMatch => Boolean(item && typeof item === "object" && typeof (item as MimicTerminologyMatch).identifier === "string" && typeof (item as MimicTerminologyMatch).label === "string"));
  }
}
