import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ClinicalDatabaseCatalog } from "../clinical-database/index.js";
import type { AnalysisPlan, AnalysisPlanningService } from "../analysis-planning/index.js";
import type { MimicMappingResult } from "../mimic-concept-mapping/index.js";
import { assessResearchProtocol, type ConfirmedStudySpec } from "../research-design/index.js";
import { isCandidateExecutable, type StudyVariableMappingService } from "../variable-mapping/index.js";
import type { DynamicLocalResearchWorkflow, DynamicLocalRunBundle } from "./dynamic-local-research-workflow.js";

interface JsonRow { json: string }

export class SqliteLocalRunRepository {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_run_evidence (
        run_id TEXT PRIMARY KEY,
        integrity_id TEXT NOT NULL UNIQUE,
        json TEXT NOT NULL
      ) STRICT
    `);
  }

  close(): void { this.database.close(); }

  async save(bundle: DynamicLocalRunBundle): Promise<boolean> {
    const result = this.database.prepare(
      "INSERT OR IGNORE INTO local_run_evidence (run_id, integrity_id, json) VALUES (?, ?, ?)",
    ).run(bundle.artifact.run_id, bundle.artifact.integrity_id, JSON.stringify(bundle));
    return result.changes === 1;
  }

  async findByRunId(runId: string): Promise<DynamicLocalRunBundle | undefined> {
    const row = this.database.prepare("SELECT json FROM local_run_evidence WHERE run_id = ?").get(runId) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as DynamicLocalRunBundle : undefined;
  }
}

const hashFile = async (path: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.once("error", reject);
  stream.once("end", () => resolve(`sha256:${hash.digest("hex")}`));
});

const hasExecutableMapping = (review: Awaited<ReturnType<StudyVariableMappingService["assess"]>>): boolean =>
  review.variables.length > 0 && review.variables.every(({ candidates }) =>
    candidates.some((candidate) => isCandidateExecutable(candidate, true)));

/** Owns one fail-closed browser run against the configured local MIMIC archive. */
export class LocalResearchRunService {
  private archiveSha256?: string;

  constructor(private readonly dependencies: {
    archive_path: string;
    archive_version: string;
    catalog: ClinicalDatabaseCatalog;
    mappings: Pick<StudyVariableMappingService, "assess">;
    planning?: Pick<AnalysisPlanningService, "plan">;
    workflow: Pick<DynamicLocalResearchWorkflow, "run">;
    runs: Pick<SqliteLocalRunRepository, "save" | "findByRunId">;
  }) {}

  async createAnalysisPlan(study: ConfirmedStudySpec): Promise<AnalysisPlan> {
    if (!this.dependencies.planning) throw new Error("Local analysis planning is unavailable.");
    const review = await this.dependencies.mappings.assess(study.spec, false);
    const protocol = assessResearchProtocol(study.spec);
    const protocolBlockers = protocol.requirements
      .filter(({ severity }) => severity === "required")
      .map(({ code, field_path, reason }) => `${code} ${field_path}: ${reason}`);
    const mapping: MimicMappingResult = {
      schema_version: "1.0.0",
      data_model: "MIMIC-IV",
      matches: review.variables.map((variable) => {
        const selectedCandidate = variable.status === "resolved"
          ? variable.candidates.find((candidate) => isCandidateExecutable(candidate, true))
          : undefined;
        const selected = selectedCandidate?.mapping ?? variable.candidates[0]?.mapping;
        const status = selectedCandidate ? "mapped" as const
          : variable.status === "needs_confirmation" ? "requires_dictionary_resolution" as const
          : "unmapped" as const;
        return {
          requested: { role: variable.role, text: variable.requested_term },
          status,
          ...(selected ? { concept_id: selected.concept_id, label: selected.labels.en } : {}),
          field_candidates: selected?.sources.map((source) => ({
            module: source.schema === "mimiciv_hosp" ? "hosp" as const : source.schema === "mimiciv_icu" ? "icu" as const : "derived" as const,
            table: source.table,
            columns: source.columns,
            ...(source.dictionary_table ? { dictionary_table: source.dictionary_table } : {}),
          })) ?? [],
          warnings: status === "mapped" ? [] : [variable.reason ?? `Mapping review is required for ${variable.requested_term}.`],
        };
      }),
      blocking_requirements: review.variables.filter(({ status }) => status !== "resolved").map((variable) =>
        variable.status === "needs_confirmation"
          ? `Confirm ${variable.role} mapping: ${variable.requested_term}`
          : `Unmapped ${variable.role}: ${variable.requested_term}`),
    };
    // The formal UI and executor share the same evidence gate. Database
    // verification may be accepted only when the candidate itself no longer
    // requires clinical confirmation.
    const ready = protocol.status === "complete" && (review.status === "ready" || hasExecutableMapping(review));
    const method = ready ? `local.manifest.r.${study.spec.intent_family}.${study.spec.outcome_structure ?? "binary"}.v1` : undefined;
    return this.dependencies.planning.plan({
      study_spec: study.spec,
      mapping,
      clinical_concepts: {
        status: protocol.status === "complete" ? "ready_for_source_mapping" : "needs_clarification",
        resolutions: [],
        blocking_requirements: protocolBlockers,
      },
      ...(method ? { registered_capability_id: method } : {}),
      // Local manifest execution is a registered generic R path; keep the planner
      // from adding the unrelated model-generated-code capability blocker.
      generated_execution_enabled: true,
    });
  }

  async execute(study: ConfirmedStudySpec): Promise<DynamicLocalRunBundle> {
    const mapping = await this.dependencies.mappings.assess(study.spec, true);
    const archiveSha256 = this.archiveSha256 ??= await hashFile(this.dependencies.archive_path);
    const bundle = await this.dependencies.workflow.run({
      study: study.spec,
      mapping,
      catalog: this.dependencies.catalog,
      archive_path: this.dependencies.archive_path,
      provenance: {
        data_source_id: "local-mimic-archive",
        data_source_version: this.dependencies.archive_version,
        archive_sha256: archiveSha256,
      },
      allow_database_verified: true,
    });
    if (!await this.dependencies.runs.save(bundle)) {
      const existing = await this.dependencies.runs.findByRunId(bundle.artifact.run_id);
      if (existing?.artifact.reproducibility_id === bundle.artifact.reproducibility_id) return existing;
      throw new Error("The local run artifact could not be saved.");
    }
    return bundle;
  }

  async getRun(runId: string): Promise<DynamicLocalRunBundle | undefined> {
    return this.dependencies.runs.findByRunId(runId);
  }
}
