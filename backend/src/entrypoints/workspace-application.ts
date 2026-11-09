import { fileURLToPath } from "node:url";
import { AssociationAnalysisService, PublicationSyntheticLactateMortalityGateway, RAssociationStatisticalExecutor } from "../association-analysis/index.js";
import { AnalysisCapabilityRegistry, AnalysisPlanningService, ResearchAnalysisPlanService } from "../analysis-planning/index.js";
import { ClinicalConceptCatalogService } from "../clinical-concept-catalog/index.js";
import { MimicIvConceptMappingService } from "../mimic-concept-mapping/index.js";
import { PredictionAnalysisService, PublicationSyntheticVentilationGateway, RVentilationPredictionExecutor } from "../prediction-analysis/index.js";
import { createSqliteDesignSessionRepository } from "../research-design/index.js";
import { createInitialResearchPreflightService } from "../research-feasibility/index.js";
import { ReportExportService } from "../report-export/index.js";
import { ResearchWorkflowService, SqliteGuardedRunEvidenceRepository } from "../research-workflow/index.js";
import { RunEvidenceService, SqliteRunEvidenceRepository } from "../run-evidence/index.js";
import type { BackendRuntimeConfig, ResearchDesignModelFactory, SystemStatusService } from "../runtime/index.js";
import { createConfiguredGuardedResearchWorkflow, createConfiguredResearchDesignService, createConfiguredVariableMappingRuntime, createRepositoryProductPromptRegistry, createResearchWorkspaceHttpServer } from "../runtime/index.js";
import type { GuardedPlannerSettings } from "../runtime/index.js";
import { PublicationSyntheticVasopressorGateway, RVasopressorTreatmentEffectExecutor, TreatmentEffectAnalysisService } from "../treatment-effect-analysis/index.js";
import { ModelAuditQueryService, SqliteModelAuditRepository } from "../model-audit/index.js";
import { PersistentLocalRunJobService, SqliteLocalRunJobRepository, SubprocessLocalRunJobExecutor } from "../runtime/local-run-job-service.js";
import { PersistentMultiObjectiveRunJobService, SqliteMultiObjectiveRunJobRepository, SubprocessMultiObjectiveRunJobExecutor } from "../runtime/multi-objective-run-job-service.js";
import { createLocalArchiveRunRuntime } from "./local-archive-run-runtime.js";

export const startWorkspaceApplication = async (input: { config: BackendRuntimeConfig; modelFactory: ResearchDesignModelFactory; systemStatus?: SystemStatusService; guardedPlanner?: GuardedPlannerSettings; mappingPlanner?: GuardedPlannerSettings; localArchivePath?: string }) => {
  const { config } = input;
  const designRepository = createSqliteDesignSessionRepository(config.storage.database_path);
  const runRepository = new SqliteRunEvidenceRepository(config.storage.database_path);
  const guardedRunRepository = new SqliteGuardedRunEvidenceRepository(config.storage.database_path);
  const modelAuditRepository = new SqliteModelAuditRepository(config.storage.database_path);
  const design = await createConfiguredResearchDesignService({
    config,
    prompts: createRepositoryProductPromptRegistry(),
    sessions: designRepository,
    modelFactory: input.modelFactory,
    modelAudit: {
      append: (records) => {
        try { modelAuditRepository.append(records); }
        catch { void 0; }
      },
    },
  });
  const localArchiveRuntime = input.localArchivePath
    ? await createLocalArchiveRunRuntime({ config, archivePath: input.localArchivePath, ...(input.mappingPlanner ? { mappingPlanner: input.mappingPlanner } : {}) })
    : undefined;
  const variableMappingRuntime = localArchiveRuntime?.variableMappingRuntime
    ?? await createConfiguredVariableMappingRuntime({ config, prompts: createRepositoryProductPromptRegistry(), ...(input.mappingPlanner ? { planner: input.mappingPlanner } : {}) });
  const localRunRepository = localArchiveRuntime?.localRunRepository;
  const localRuns = localArchiveRuntime?.localRuns;
  const runJobs = localRuns && input.localArchivePath
    ? new PersistentLocalRunJobService({
        jobs: new SqliteLocalRunJobRepository(config.storage.database_path),
        executor: new SubprocessLocalRunJobExecutor({ config, archivePath: input.localArchivePath }),
        getResult: (id) => localRuns.getRun(id),
        now: () => new Date(),
      })
    : undefined;
  // Runs an arbitrary MIMIC research question end to end (objective decomposition through
  // per-objective execution) as a persisted background job, independent of any fixed question.
  const localModelEnabled = config.research_design.local.enabled && config.research_design.local.profile !== "disabled";
  const localModelProfile = localModelEnabled ? config.research_design.local.profile : undefined;
  const localModelBaseUrl = config.research_design.local.base_url;
  const multiObjectiveJobs = localArchiveRuntime && input.localArchivePath
    ? new PersistentMultiObjectiveRunJobService({
        jobs: new SqliteMultiObjectiveRunJobRepository(config.storage.database_path),
        executor: new SubprocessMultiObjectiveRunJobExecutor({
          config,
          archivePath: input.localArchivePath,
          localModelEnabled,
          ...(localModelProfile ? { localModelProfile } : {}),
          localModelBaseUrl,
        }),
        getResult: (id) => localArchiveRuntime.multiObjectiveReportRepository.findByReportId(id),
        now: () => new Date(),
      })
    : undefined;
  if (input.systemStatus && variableMappingRuntime.mapping_model) input.systemStatus.set({
    id: "variable_mapping_model",
    label: "变量映射模型",
    state: "ready",
    summary: `快速可用性检查后选择 ${variableMappingRuntime.mapping_model}；仅生成术语候选，本地 MIMIC 字典仍负责最终验证`,
  });
  const preflight = createInitialResearchPreflightService();
  const association = new AssociationAnalysisService(new PublicationSyntheticLactateMortalityGateway(), new RAssociationStatisticalExecutor({ rscript_binary: config.statistical_execution.rscript_binary, script_path: fileURLToPath(new URL("../association-analysis/runtimes/r/crude_binary_association.R", import.meta.url)), timeout_ms: config.statistical_execution.timeout_ms }));
  const prediction = new PredictionAnalysisService(new PublicationSyntheticVentilationGateway(), new RVentilationPredictionExecutor({ rscript_binary: config.statistical_execution.rscript_binary, script_path: fileURLToPath(new URL("../prediction-analysis/runtimes/r/ventilation_prediction.R", import.meta.url)), timeout_ms: config.statistical_execution.timeout_ms }), "prediction.invasive_ventilation_24h.v1");
  const treatmentEffect = new TreatmentEffectAnalysisService(new PublicationSyntheticVasopressorGateway(), new RVasopressorTreatmentEffectExecutor({ rscript_binary: config.statistical_execution.rscript_binary, script_path: fileURLToPath(new URL("../treatment-effect-analysis/runtimes/r/vasopressor_iptw.R", import.meta.url)), timeout_ms: config.statistical_execution.timeout_ms }), "treatment_effect.early_vasopressor.in_hospital_mortality.v1");
  const capabilities = new AnalysisCapabilityRegistry();
  capabilities.register({ capability_id: "association.lactate.in_hospital_mortality.v1", label: "Association", manifest: { intent_family: "association", analysis_family: "association", outcome_structure: "binary", required_data_concepts: ["icu_admission_time", "lactate_measurement", "hospital_discharge_status"], required_diagnostics: ["cohort_reconciliation", "missingness", "event_information", "model_convergence"], field_manifest: [{ name: "lactate", role: "exposure", type: "number" }, { name: "in_hospital_mortality", role: "outcome", type: "boolean" }] }, execute: (request: Parameters<AssociationAnalysisService["execute"]>[0]) => association.execute(request) });
  capabilities.register({ capability_id: "prediction.invasive_ventilation_24h.v1", label: "Prediction", manifest: { intent_family: "prediction", analysis_family: "binary_prediction", outcome_structure: "binary", required_data_concepts: ["icu_admission_time", "age", "respiratory_rate", "spo2_fio2_ratio", "gcs", "invasive_ventilation_start"], required_diagnostics: ["cohort_reconciliation", "resampling_integrity", "discrimination", "calibration"], field_manifest: [{ name: "age", role: "predictor", type: "number" }, { name: "respiratory_rate", role: "predictor", type: "number" }, { name: "invasive_ventilation_24h", role: "outcome", type: "boolean" }] }, execute: (request: Parameters<PredictionAnalysisService["execute"]>[0]) => prediction.execute(request) });
  capabilities.register({ capability_id: "treatment_effect.early_vasopressor.in_hospital_mortality.v1", label: "Treatment effect", manifest: { intent_family: "treatment_effect", analysis_family: "propensity_weighted_treatment_effect", outcome_structure: "binary", required_data_concepts: ["icu_admission_time", "hypotension_time", "vasopressor_start", "hospital_discharge_status", "age", "sex", "sofa", "lactate"], required_diagnostics: ["cohort_reconciliation", "treatment_timing", "propensity_overlap", "covariate_balance", "effective_sample_size"], field_manifest: [{ name: "early_vasopressor", role: "treatment", type: "boolean" }, { name: "in_hospital_mortality", role: "outcome", type: "boolean" }, { name: "age", role: "confounder", type: "number" }, { name: "sofa", role: "confounder", type: "number" }] }, execute: (request: Parameters<TreatmentEffectAnalysisService["execute"]>[0]) => treatmentEffect.execute(request) });
  const workflow = new ResearchWorkflowService({
    preflight,
    analysis: association,
    prediction,
    treatmentEffect,
    capabilities,
    evidence: new RunEvidenceService({ now: () => new Date() }),
    runs: runRepository,
  });
  const executionDataSource = {
    id: "publication-synthetic-lactate-mortality-fixture", version: "3.0.0", data_mode: "synthetic" as const,
    available_concepts: ["icu_admission_time", "lactate_measurement", "hospital_discharge_status", "age", "sex", "respiratory_rate", "spo2_fio2_ratio", "gcs", "invasive_ventilation_start", "hypotension_time", "vasopressor_start", "sofa", "lactate"],
  };
  const analysisPlans = new ResearchAnalysisPlanService({ preflight, mapping: new MimicIvConceptMappingService(variableMappingRuntime.mimicCatalog), planning: new AnalysisPlanningService(), clinicalConcepts: new ClinicalConceptCatalogService(), generated_execution_enabled: config.generated_analysis.enabled });
  const guardedWorkflow = config.generated_analysis.enabled && input.guardedPlanner
    ? await createConfiguredGuardedResearchWorkflow({ config, prompts: createRepositoryProductPromptRegistry(), analysisPlans, runs: guardedRunRepository, planner: input.guardedPlanner })
    : undefined;
  const server = createResearchWorkspaceHttpServer(design, {
    analysisPlans,
    variableMappings: variableMappingRuntime.service,
    reportExports: new ReportExportService({ runs: runRepository, ...(localRuns ? { fallback_runs: { findByRunId: (id: string) => localRuns.getRun(id) } } : {}), python_binary: config.report_exports.python_binary, builder_path: fileURLToPath(new URL("../report-export/runtimes/python/build_clinical_report.py", import.meta.url)), timeout_ms: config.report_exports.timeout_ms }),
    ...(!input.localArchivePath ? { workflow, executionDataSource } : {}),
    ...(localRuns ? { localRuns } : {}),
    ...(runJobs ? { runJobs } : {}),
    ...(multiObjectiveJobs ? { multiObjectiveJobs } : {}),
    ...(input.systemStatus ? { systemStatus: input.systemStatus } : {}),
    modelAudit: new ModelAuditQueryService(modelAuditRepository),
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.server.port, config.server.host, resolve); });
  } catch (error) {
    designRepository.close();
    runRepository.close();
    guardedRunRepository.close();
    runJobs?.close();
    multiObjectiveJobs?.close();
    modelAuditRepository.close();
    localArchiveRuntime?.close();
    if (!localArchiveRuntime) variableMappingRuntime.close();
    throw error;
  }
  return {
    origin: `http://${config.server.host}:${config.server.port}`,
    guardedWorkflow,
    close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); designRepository.close(); runRepository.close(); guardedRunRepository.close(); runJobs?.close(); multiObjectiveJobs?.close(); modelAuditRepository.close(); localArchiveRuntime?.close(); if (!localArchiveRuntime) variableMappingRuntime.close(); },
  };
};
