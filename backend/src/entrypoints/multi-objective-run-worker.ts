import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicLocalResearchWorkflow, GenericRAnalysisExecutor, LocalExecutionGraphRunner, LocalResearchRunService, SqliteLocalRunRepository } from "../clinical-data/index.js";
import { SqliteMultiObjectiveReportRepository } from "../multi-objective-report/index.js";
import { MultiObjectiveResearchOrchestrator, type MultiObjectiveRunPhase } from "../research-program/index.js";
import { OpenAiCompatibleObjectiveStudySpecCompiler, OpenAiCompatibleResearchObjectiveModel } from "../research-objectives/index.js";
import { SqliteModelAuditRepository } from "../model-audit/index.js";
import { createConfiguredVariableMappingRuntime, createRepositoryProductPromptRegistry, loadRouterApiKey, requireRouterBaseUrl, type BackendRuntimeConfig } from "../runtime/index.js";

interface WorkerInput { config: BackendRuntimeConfig; archivePath: string; originalQuestion: string }

const send = (message: unknown): void => { if (process.send) process.send(message); };
const isEnabled = (value: string | undefined): boolean => ["1", "true", "enabled", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");

process.once("message", async (input: WorkerInput) => {
  const { config, archivePath, originalQuestion } = input;
  const localMode = isEnabled(process.env.MIMIC_LOCAL_MODEL_ENABLED) && process.env.MIMIC_MODEL_ACCESS !== "enabled";
  const timeout = Number(process.env.OBJECTIVE_MODEL_TIMEOUT_MS ?? "300000");
  const model = localMode
    ? (process.env.MIMIC_LOCAL_MODEL_PROFILE || "llama3.1:8b-instruct-q4_K_M")
    : (process.env.OPENROUTER_MODEL ?? "ora/claude-sonnet-4-6");
  const apiKey = localMode ? undefined : loadRouterApiKey({ environment: process.env });

  let mappingRuntime: Awaited<ReturnType<typeof createConfiguredVariableMappingRuntime>> | undefined;
  let runRepository: SqliteLocalRunRepository | undefined;
  let auditRepository: SqliteModelAuditRepository | undefined;
  let reportRepository: SqliteMultiObjectiveReportRepository | undefined;
  try {
    if (!localMode && !apiKey) {
      throw Object.assign(new Error("The Router provider is not configured for this multi-objective run."), { code: "MULTI_OBJECTIVE_RUN_PROVIDER_NOT_CONFIGURED", retryable: false });
    }
    const prompts = createRepositoryProductPromptRegistry();
    const [objectivePrompt, coveragePrompt, compilerPrompt] = await Promise.all([
      prompts.load({ id: "research-objectives", version: "1.1.0" }),
      prompts.load({ id: "research-objective-coverage", version: "1.0.0" }),
      prompts.load({ id: "research-objective-study-spec", version: "1.1.0" }),
    ]);
    const provider = {
      base_url: localMode ? (process.env.MIMIC_LOCAL_MODEL_BASE_URL || "http://127.0.0.1:11434/v1") : requireRouterBaseUrl(config),
      ...(apiKey ? { api_key: apiKey } : {}),
      provider: localMode ? "local" : "router",
      model,
      timeout_ms: timeout,
      max_output_tokens: localMode ? 1_200 : config.research_design.model.max_output_tokens,
    };
    const objectives = new OpenAiCompatibleResearchObjectiveModel({
      ...provider,
      objective_prompt: { id: objectivePrompt.id, version: objectivePrompt.version, content: objectivePrompt.body },
      coverage_prompt: { id: coveragePrompt.id, version: coveragePrompt.version, content: coveragePrompt.body },
    });
    const compiler = new OpenAiCompatibleObjectiveStudySpecCompiler({
      ...provider,
      ...(localMode ? { max_output_tokens: 900 } : {}),
      prompt: { id: compilerPrompt.id, version: compilerPrompt.version, content: compilerPrompt.body },
    });
    mappingRuntime = await createConfiguredVariableMappingRuntime({
      config,
      prompts,
      localArchivePath: archivePath,
      profileEvidence: true,
      planner: { base_url: provider.base_url, model, ...(apiKey ? { api_key: apiKey } : {}) },
    });
    if (!mappingRuntime.catalog) throw Object.assign(new Error("The clinical database catalog is unavailable to the multi-objective run worker."), { code: "MULTI_OBJECTIVE_RUN_CATALOG_UNAVAILABLE", retryable: false });
    runRepository = new SqliteLocalRunRepository(config.storage.database_path);
    auditRepository = new SqliteModelAuditRepository(config.storage.database_path);
    reportRepository = new SqliteMultiObjectiveReportRepository(config.storage.database_path);
    const localRuns = new LocalResearchRunService({
      archive_path: archivePath,
      archive_version: basename(archivePath),
      catalog: mappingRuntime.catalog,
      mappings: mappingRuntime.service,
      workflow: new DynamicLocalResearchWorkflow({
        runner: new LocalExecutionGraphRunner(),
        statistics: new GenericRAnalysisExecutor({
          rscript_binary: config.statistical_execution.rscript_binary,
          script_path: fileURLToPath(new URL("../clinical-data/runtimes/r/generic_manifest_analysis.R", import.meta.url)),
          timeout_ms: config.statistical_execution.timeout_ms,
        }),
        now: () => new Date(),
      }),
      runs: runRepository,
    });
    const onPhase = (phase: MultiObjectiveRunPhase): void => send({ type: "phase", phase });
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
      onPhase,
    }).run(originalQuestion);
    const reportIntegrityId = result.report.artifact.integrity_id;
    auditRepository.append([
      ...result.interpretation_audit.map((record) => ({ ...record, report_integrity_id: reportIntegrityId })),
      ...result.objective_traces.flatMap((trace) => trace.compilation_audit.map((record) => ({
        ...record,
        ...(trace.study_spec_integrity_id ? { study_spec_integrity_id: trace.study_spec_integrity_id } : {}),
        ...(trace.manifest_integrity_id ? { manifest_integrity_id: trace.manifest_integrity_id } : {}),
        ...(trace.method_integrity_id ? { method_integrity_id: trace.method_integrity_id } : {}),
        report_integrity_id: reportIntegrityId,
      }))),
    ]);
    if (!await reportRepository.save(result.report)) {
      const existing = await reportRepository.findByReportId(result.report.artifact.report_id);
      if (!existing || existing.artifact.reproducibility_id !== result.report.artifact.reproducibility_id) {
        throw Object.assign(new Error("The multi-objective report artifact could not be saved."), { code: "MULTI_OBJECTIVE_RUN_REPORT_SAVE_FAILED", retryable: true });
      }
    }
    send({ type: "completed", result_id: result.report.artifact.report_id, objective_traces: result.objective_traces });
  } catch (error) {
    const candidate = error as { code?: string; message?: string; retryable?: boolean; audit?: unknown };
    if (auditRepository && candidate.audit && typeof candidate.audit === "object") {
      try { auditRepository.append([candidate.audit]); }
      catch { /* Best-effort: a failed audit write must not hide the original run failure. */ }
    }
    send({ type: "failed", code: candidate.code ?? "MULTI_OBJECTIVE_RUN_FAILED", message: candidate.message ?? "The multi-objective research run did not complete.", retryable: candidate.retryable !== false });
  } finally {
    auditRepository?.close();
    runRepository?.close();
    reportRepository?.close();
    mappingRuntime?.close();
    process.disconnect();
  }
});
