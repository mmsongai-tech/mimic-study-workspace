import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DynamicLocalResearchWorkflow,
  GenericRAnalysisExecutor,
  type DynamicLocalRunBundle,
  LocalExecutionGraphRunner,
  LocalResearchRunService,
  SqliteLocalRunRepository,
} from "../clinical-data/index.js";
import { AnalysisPlanningService } from "../analysis-planning/index.js";
import { createConfiguredVariableMappingRuntime, createRepositoryProductPromptRegistry, resolveBackendRuntimeConfig } from "../runtime/index.js";
import { createSqliteDesignSessionRepository } from "../research-design/index.js";
import { FrozenStudyOutcomeObjectiveRunner, hasCompoundOutcomeObjectives, type FrozenStudyOutcomeObjectiveResult } from "../research-program/index.js";
import { SqliteVariableMappingRepository, type VariableMappingStatus } from "../variable-mapping/index.js";

interface SessionTarget {
  id: string;
  revision: number;
  label: string;
  evidence: "debug" | "formal";
}

const targets: SessionTarget[] = [
  {
    id: "0f2836a6-87dc-4c74-9096-900ba3116648",
    revision: 5,
    label: "糖尿病与院内死亡的关联",
    evidence: "debug",
  },
  {
    id: "4676487d-ddf1-4de2-b75e-38327bad0de9",
    revision: 2,
    label: "高血压人群美托洛尔与不用美托洛尔对比降压疗效及全因死亡结局差异",
    evidence: "formal",
  },
];

const toSafeFilename = (value: string): string => value.toLowerCase().replace(/[^a-z0-9-_]+/gu, "-").replace(/^-+|-+$/gu, "");
const reusableMappingStatuses: VariableMappingStatus[] = ["database_verified", "model_reviewed", "clinician_confirmed", "validated"];

const importFrozenMappings = async (sourcePath: string, targetPath: string): Promise<number> => {
  if (sourcePath === targetPath) return 0;
  const source = new SqliteVariableMappingRepository(sourcePath);
  const target = new SqliteVariableMappingRepository(targetPath);
  try {
    const records = await source.listByStatus(reusableMappingStatuses);
    let imported = 0;
    for (const record of records) if (await target.save(record)) imported += 1;
    return imported;
  } finally {
    source.close();
    target.close();
  }
};

const writeBundleArtifacts = async (session: SessionTarget, bundle: DynamicLocalRunBundle, outputDir: string): Promise<{ jsonPath: string; markdownPath: string }> => {
  await mkdir(outputDir, { recursive: true });
  const stem = `${toSafeFilename(session.label)}-${session.id}-${session.revision}-${session.evidence}`;
  const jsonPath = `${outputDir}/${stem}.json`;
  const markdownPath = `${outputDir}/${stem}.md`;
  const payload = JSON.stringify(bundle, null, 2);
  await writeFile(jsonPath, `${payload}\n`, { mode: 0o600 });
  const reportMarkdown = bundle.report_markdown;
  await writeFile(markdownPath, `${reportMarkdown}\n`, { mode: 0o600 });
  return { jsonPath, markdownPath };
};

const writeMultiObjectiveArtifacts = async (session: SessionTarget, result: FrozenStudyOutcomeObjectiveResult, outputDir: string): Promise<{ jsonPath: string; markdownPath: string }> => {
  await mkdir(outputDir, { recursive: true });
  const stem = `${toSafeFilename(session.label)}-${session.id}-${session.revision}-${session.evidence}-multi-objective`;
  const jsonPath = `${outputDir}/${stem}.json`;
  const markdownPath = `${outputDir}/${stem}.md`;
  await writeFile(jsonPath, `${JSON.stringify({ objective_list: result.objective_list, coverage_review: result.coverage_review, report: result.report.artifact }, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${result.report.report_markdown}\n`, "utf8");
  return { jsonPath, markdownPath };
};

const withTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> => {
  let timeout: NodeJS.Timeout;
  const timer = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout!));
};

const runTargets = async (): Promise<void> => {
  const archivePath = process.env.MIMIC_LOCAL_ARCHIVE?.trim();
  if (!archivePath) throw new Error("MIMIC_LOCAL_ARCHIVE is required for local evidence execution.");
  const designSessionDbPath = process.env.MIMIC_DESIGN_SESSION_DB ?? "/tmp/mimic-claude-frontend.sqlite";
  const outputDir = process.env.CONFIRMED_SESSION_OUTPUT_DIR ?? `${process.cwd()}/.local/confirmed-sessions-reports`;
  const runtimeConfigPath = process.env.MIMIC_RUNTIME_DB ?? `${process.cwd()}/.local/confirmed-session-local-run.sqlite`;
  const mappingSourceDbPath = process.env.MIMIC_MAPPING_SOURCE_DB ?? designSessionDbPath;
  const outputStatsPath = `${outputDir}/run-summary.json`;
  const targetTimeoutMs = Number(process.env.CONFIRMED_SESSION_TIMEOUT_MS ?? "600000");
  const targetsToRun = process.env.CONFIRMED_SESSION_IDS?.trim()
    ? targets.filter((target) => process.env.CONFIRMED_SESSION_IDS!.split(",").includes(target.id))
    : targets;
  if (targetsToRun.length === 0) throw new Error("No target session remains after filtering CONFIRMED_SESSION_IDS.");

  const config = resolveBackendRuntimeConfig({
    environment: {
      storage: { database_path: runtimeConfigPath },
      clinical_database: {
        local_evidence_scan_timeout_ms: 1_200_000,
      },
    },
  });
  const importedMappings = await importFrozenMappings(mappingSourceDbPath, runtimeConfigPath);
  process.stdout.write(`${JSON.stringify({ event: "frozen_mappings_imported", source: "configured_mapping_database", count: importedMappings })}\n`);
  const prompts = createRepositoryProductPromptRegistry();
  const mappingRuntime = await createConfiguredVariableMappingRuntime({
    config,
    prompts,
    localArchivePath: archivePath,
    profileEvidence: true,
  });
  const designSessionRepository = createSqliteDesignSessionRepository(designSessionDbPath);
  const localRunRepository = new SqliteLocalRunRepository(runtimeConfigPath);
  if (!mappingRuntime.catalog) throw new Error("Clinical database catalog unavailable from local archive.");
  const localRuns = new LocalResearchRunService({
    archive_path: archivePath,
    archive_version: basename(archivePath),
    catalog: mappingRuntime.catalog!,
    mappings: mappingRuntime.service,
    planning: new AnalysisPlanningService(),
    workflow: new DynamicLocalResearchWorkflow({
      runner: new LocalExecutionGraphRunner(),
      statistics: new GenericRAnalysisExecutor({
        rscript_binary: config.statistical_execution.rscript_binary,
        script_path: fileURLToPath(new URL("../clinical-data/runtimes/r/generic_manifest_analysis.R", import.meta.url)),
        timeout_ms: config.statistical_execution.timeout_ms,
      }),
      now: () => new Date(),
    }),
    runs: localRunRepository,
  });
  const outcomeObjectives = new FrozenStudyOutcomeObjectiveRunner({ mappings: mappingRuntime.service, local_runs: localRuns, now: () => new Date() });

  const summary: Array<Record<string, unknown>> = [];
  for (const target of targetsToRun) {
    const begin = performance.now();
    process.stdout.write(`${JSON.stringify({ event: "session_started", session_id: target.id, revision: target.revision })}\n`);
    const snapshot = await designSessionRepository.findById(target.id);
    const confirmed = snapshot?.confirmation?.result;
    if (!confirmed) throw new Error(`Session ${target.id} is not confirmed.`);
    if (snapshot.revision !== target.revision) {
      throw new Error(`Session ${target.id} revision mismatch: expected ${target.revision}, found ${snapshot.revision}.`);
    }
    if (hasCompoundOutcomeObjectives(confirmed.spec)) {
      const result = await withTimeout(outcomeObjectives.run(confirmed), `run:${target.id}:outcomes`, targetTimeoutMs);
      const durationMs = Math.round(performance.now() - begin);
      const { jsonPath, markdownPath } = await writeMultiObjectiveArtifacts(target, result, outputDir);
      process.stdout.write(`${JSON.stringify({ event: "session_completed", session_id: target.id, status: result.report.artifact.status, report_id: result.report.artifact.report_id })}\n`);
      summary.push({ session_id: target.id, revision: target.revision, evidence: target.evidence, status: result.report.artifact.status, report_id: result.report.artifact.report_id, reproducibility_id: result.report.artifact.reproducibility_id, integrity_id: result.report.artifact.integrity_id, duration_ms: durationMs, objective_counts: result.report.artifact.objective_counts, markdown_path: markdownPath, json_path: jsonPath, question: confirmed.spec.research_question });
      continue;
    }
    const bundle: DynamicLocalRunBundle = await withTimeout(localRuns.execute(confirmed), `run:${target.id}`, targetTimeoutMs);
    const durationMs = Math.round(performance.now() - begin);
    const { jsonPath, markdownPath } = await writeBundleArtifacts(target, bundle, outputDir);
    process.stdout.write(`${JSON.stringify({ event: "session_completed", session_id: target.id, status: bundle.artifact.status, run_id: bundle.artifact.run_id })}\n`);
    summary.push({
      session_id: target.id,
      revision: target.revision,
      evidence: target.evidence,
      status: bundle.artifact.status,
      run_id: bundle.artifact.run_id,
      reproducibility_id: bundle.artifact.reproducibility_id,
      integrity_id: bundle.artifact.integrity_id,
      duration_ms: durationMs,
      blockers: bundle.artifact.blockers.map((blocker) => `${blocker.stage}:${blocker.code}`),
      markdown_path: markdownPath,
      json_path: jsonPath,
      question: confirmed.spec.research_question ?? "Unnamed study",
    });
  }
  await writeFile(outputStatsPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: "completed", outputDir, count: summary.length, summary }, null, 2)}\n`);

  mappingRuntime.close();
  localRunRepository.close();
  designSessionRepository.close();
};

runTargets().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "failed to run confirmed local sessions"}\n`);
  process.exitCode = 1;
});
