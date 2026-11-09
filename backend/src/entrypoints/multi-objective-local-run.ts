import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicLocalResearchWorkflow, GenericRAnalysisExecutor, LocalExecutionGraphRunner, LocalResearchRunService, SqliteLocalRunRepository } from "../clinical-data/index.js";
import { MultiObjectiveResearchOrchestrator } from "../research-program/index.js";
import { loadSavedObjectiveInterpretation, OpenAiCompatibleObjectiveStudySpecCompiler, OpenAiCompatibleResearchObjectiveModel, SavedObjectiveStudySpecCompiler } from "../research-objectives/index.js";
import { SqliteModelAuditRepository } from "../model-audit/index.js";
import { createConfiguredVariableMappingRuntime, createRepositoryProductPromptRegistry, loadRouterApiKey, requireRouterBaseUrl, resolveBackendRuntimeConfig, routerEnvironmentLayer } from "../runtime/index.js";

const isEnabled = (value: string | undefined): boolean => ["1", "true", "enabled", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");

const main = async (): Promise<void> => {
  const idea = process.env.MIMIC_RESEARCH_IDEA?.trim();
  const archivePath = process.env.MIMIC_LOCAL_ARCHIVE;
  if (!idea) throw new Error("MIMIC_RESEARCH_IDEA is required.");
  if (!archivePath) throw new Error("MIMIC_LOCAL_ARCHIVE is required; this command has no synthetic fallback.");
  const localMode = isEnabled(process.env.MIMIC_LOCAL_MODEL_ENABLED);
  const apiKey = localMode ? undefined : loadRouterApiKey({ environment: process.env });
  if (!localMode && !apiKey) throw new Error("Router Virtual Key is not configured.");
  const model = localMode ? (process.env.MIMIC_LOCAL_MODEL_PROFILE ?? "llama3.1:8b-instruct-q4_K_M") : process.env.OPENROUTER_MODEL ?? "ora/claude-sonnet-4-6";
  const timeout = Number(process.env.OBJECTIVE_MODEL_TIMEOUT_MS ?? "300000");
  const databasePath = process.env.MULTI_OBJECTIVE_DATABASE_PATH ?? ".local/multi-objective-run.sqlite";
  const outputPath = process.env.MULTI_OBJECTIVE_OUTPUT_PATH ?? ".local/multi-objective-report.json";
  const savedInterpretationPath = process.env.MULTI_OBJECTIVE_INTERPRETATION_PATH;
  const savedStudySpecsPath = process.env.MULTI_OBJECTIVE_STUDY_SPECS_PATH;
  await mkdir(dirname(databasePath), { recursive: true }); await mkdir(dirname(outputPath), { recursive: true });
  const config = resolveBackendRuntimeConfig({ environment: { storage: { database_path: databasePath }, research_design: { model: { profile: model, timeout_ms: timeout }, ...routerEnvironmentLayer(process.env) } } });
  const prompts = createRepositoryProductPromptRegistry();
  const [objectivePrompt, coveragePrompt, compilerPrompt] = await Promise.all([
    prompts.load({ id: "research-objectives", version: "1.1.0" }),
    prompts.load({ id: "research-objective-coverage", version: "1.0.0" }),
    prompts.load({ id: "research-objective-study-spec", version: "1.1.0" }),
  ]);
  const provider = { base_url: localMode ? (process.env.MIMIC_LOCAL_MODEL_BASE_URL ?? "http://127.0.0.1:11434/v1") : requireRouterBaseUrl(config), ...(apiKey ? { api_key: apiKey } : {}), provider: localMode ? "local" : "router", model, timeout_ms: timeout, max_output_tokens: localMode ? 1_200 : config.research_design.model.max_output_tokens };
  const liveObjectives = new OpenAiCompatibleResearchObjectiveModel({ ...provider, objective_prompt: { id: objectivePrompt.id, version: objectivePrompt.version, content: objectivePrompt.body }, coverage_prompt: { id: coveragePrompt.id, version: coveragePrompt.version, content: coveragePrompt.body } });
  const objectives = savedInterpretationPath
    ? { analyze: async (question: string) => loadSavedObjectiveInterpretation(await readFile(savedInterpretationPath, "utf8"), question) }
    : liveObjectives;
  const compiler = savedStudySpecsPath
    ? new SavedObjectiveStudySpecCompiler(await readFile(savedStudySpecsPath, "utf8"), idea)
    : new OpenAiCompatibleObjectiveStudySpecCompiler({ ...provider, ...(localMode ? { max_output_tokens: 900 } : {}), prompt: { id: compilerPrompt.id, version: compilerPrompt.version, content: compilerPrompt.body } });
  const mappingRuntime = await createConfiguredVariableMappingRuntime({ config, prompts, localArchivePath: archivePath, profileEvidence: true, planner: { base_url: provider.base_url, model, ...(apiKey ? { api_key: apiKey } : {}) } });
  const runRepository = new SqliteLocalRunRepository(databasePath);
  const auditRepository = new SqliteModelAuditRepository(databasePath);
  try {
    if (!mappingRuntime.catalog) throw new Error("The clinical database catalog is unavailable.");
    const localRuns = new LocalResearchRunService({ archive_path: archivePath, archive_version: basename(archivePath), catalog: mappingRuntime.catalog, mappings: mappingRuntime.service, workflow: new DynamicLocalResearchWorkflow({ runner: new LocalExecutionGraphRunner(), statistics: new GenericRAnalysisExecutor({ rscript_binary: config.statistical_execution.rscript_binary, script_path: fileURLToPath(new URL("../clinical-data/runtimes/r/generic_manifest_analysis.R", import.meta.url)), timeout_ms: config.statistical_execution.timeout_ms }), now: () => new Date() }), runs: runRepository });
    const result = await new MultiObjectiveResearchOrchestrator({
      objectives,
      compiler,
      local_runs: localRuns,
      shared_context: {
        data_source: "MIMIC-IV hospital and ICU encounter data",
        supported_analysis_units: ["hospital admission", "ICU stay", "patient"],
        supported_index_events: ["hospital admission", "ICU admission"],
        supported_follow_up_ends: ["end of hospital encounter", "end of ICU stay"],
        supported_outcome_structures: ["binary", "continuous"],
        execution_policy: "Do not invent outpatient history or follow-up beyond the selected MIMIC encounter. Leave unsupported semantics explicit for downstream blocking.",
      },
      now: () => new Date(),
    }).run(idea);
    const reportIntegrityId = result.report.artifact.integrity_id;
    auditRepository.append([
      ...result.interpretation_audit.map((record) => ({ ...record, report_integrity_id: reportIntegrityId })),
      ...result.objective_traces.flatMap((trace) => trace.compilation_audit.map((record) => {
        return {
          ...record,
          ...(trace.study_spec_integrity_id ? { study_spec_integrity_id: trace.study_spec_integrity_id } : {}),
          ...(trace.manifest_integrity_id ? { manifest_integrity_id: trace.manifest_integrity_id } : {}),
          ...(trace.method_integrity_id ? { method_integrity_id: trace.method_integrity_id } : {}),
          report_integrity_id: reportIntegrityId,
        };
      })),
    ]);
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    const markdownPath = outputPath.replace(/\.json$/u, ".md"); await writeFile(markdownPath, `${result.report.report_markdown}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ status: result.report.artifact.status, report_id: result.report.artifact.report_id, objective_counts: result.report.artifact.objective_counts, reproducibility_id: result.report.artifact.reproducibility_id, output_path: outputPath, markdown_path: markdownPath, model })}\n`);
  } finally { auditRepository.close(); runRepository.close(); mappingRuntime.close(); }
};

main().catch((error: unknown) => {
  const audit = error && typeof error === "object" && "audit" in error ? (error as { audit?: Record<string, unknown> }).audit : undefined;
  const safeAudit = audit ? Object.fromEntries([
    "stage", "provider", "model", "prompt", "output_schema", "response_received", "json_parse", "schema_validation",
    "business_validation", "repair_attempts", "failure_class", "validation_errors", "latency_ms", "finish_reason", "response_chars", "usage",
  ].flatMap((key) => key in audit ? [[key, audit[key]]] : [])) : undefined;
  process.stderr.write(`${JSON.stringify({ event: "multi_objective_run_failed", message: error instanceof Error ? error.message : "Multi-objective local run failed.", ...(safeAudit ? { audit: safeAudit } : {}) })}\n`);
  process.exitCode = 1;
});
