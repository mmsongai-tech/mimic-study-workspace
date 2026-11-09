import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisPlanningService } from "../analysis-planning/index.js";
import {
  DynamicLocalResearchWorkflow,
  GenericRAnalysisExecutor,
  LocalExecutionGraphRunner,
  LocalResearchRunService,
  SqliteLocalRunRepository,
} from "../clinical-data/index.js";
import { SqliteMultiObjectiveReportRepository } from "../multi-objective-report/index.js";
import { CompoundOutcomeLocalRunService } from "../research-program/index.js";
import {
  createConfiguredVariableMappingRuntime,
  createRepositoryProductPromptRegistry,
  type BackendRuntimeConfig,
  type GuardedPlannerSettings,
} from "../runtime/index.js";

/** Composes the local archive execution boundary shared by the web process and run worker. */
export const createLocalArchiveRunRuntime = async (input: {
  config: BackendRuntimeConfig;
  archivePath: string;
  mappingPlanner?: GuardedPlannerSettings;
}) => {
  const variableMappingRuntime = await createConfiguredVariableMappingRuntime({
    config: input.config,
    prompts: createRepositoryProductPromptRegistry(),
    ...(input.mappingPlanner ? { planner: input.mappingPlanner } : {}),
    localArchivePath: input.archivePath,
  });
  if (!variableMappingRuntime.catalog) {
    variableMappingRuntime.close();
    throw new Error("Clinical database catalog unavailable from local archive.");
  }
  const localRunRepository = new SqliteLocalRunRepository(input.config.storage.database_path);
  const multiObjectiveReportRepository = new SqliteMultiObjectiveReportRepository(input.config.storage.database_path);
  const baseLocalRuns = new LocalResearchRunService({
    archive_path: input.archivePath,
    archive_version: basename(input.archivePath),
    catalog: variableMappingRuntime.catalog,
    mappings: variableMappingRuntime.service,
    planning: new AnalysisPlanningService(),
    workflow: new DynamicLocalResearchWorkflow({
      runner: new LocalExecutionGraphRunner(),
      statistics: new GenericRAnalysisExecutor({
        rscript_binary: input.config.statistical_execution.rscript_binary,
        script_path: fileURLToPath(new URL("../clinical-data/runtimes/r/generic_manifest_analysis.R", import.meta.url)),
        timeout_ms: input.config.statistical_execution.timeout_ms,
      }),
      now: () => new Date(),
    }),
    runs: localRunRepository,
  });
  const localRuns = new CompoundOutcomeLocalRunService({
    local_runs: baseLocalRuns,
    mappings: variableMappingRuntime.service,
    reports: multiObjectiveReportRepository,
    now: () => new Date(),
  });
  return {
    variableMappingRuntime,
    localRunRepository,
    multiObjectiveReportRepository,
    localRuns,
    close: () => {
      localRunRepository.close();
      multiObjectiveReportRepository.close();
      variableMappingRuntime.close();
    },
  };
};
