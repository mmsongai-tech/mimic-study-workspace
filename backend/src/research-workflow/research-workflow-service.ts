import type { AssociationAnalysisService } from "../association-analysis/services/association-analysis-service.js";
import type { PredictionAnalysisService } from "../prediction-analysis/services/prediction-analysis-service.js";
import type { TreatmentEffectAnalysisService } from "../treatment-effect-analysis/services/treatment-effect-analysis-service.js";
import type { ConfirmedStudySpec } from "../research-design/design-session.js";
import type { DataSourceDescriptor } from "../research-feasibility/domain/preflight.js";
import type { ResearchPreflightService } from "../research-feasibility/services/research-preflight-service.js";
import type { RunEvidenceBundle } from "../run-evidence/domain/run-artifact.js";
import type { RunEvidenceService } from "../run-evidence/services/run-evidence-service.js";
import type { RunEvidenceRepository } from "../run-evidence/repositories/run-evidence-repository.js";
import type { AnalysisCapabilityRegistry } from "../analysis-planning/capability-registry.js";

export class ResearchWorkflowError extends Error {
  constructor(public readonly code: "RUN_STORAGE_FAILURE", message: string) {
    super(message);
    this.name = "ResearchWorkflowError";
  }
}

export class ResearchWorkflowService {
  constructor(private readonly dependencies: {
    preflight: ResearchPreflightService;
    analysis: AssociationAnalysisService;
    prediction?: PredictionAnalysisService;
    treatmentEffect?: TreatmentEffectAnalysisService;
    capabilities?: AnalysisCapabilityRegistry;
    evidence: RunEvidenceService;
    runs: RunEvidenceRepository;
  }) {}

  async execute(input: {
    study: ConfirmedStudySpec;
    data_source: DataSourceDescriptor;
    threshold_mmol_l: number;
  }): Promise<RunEvidenceBundle> {
    const preflight = this.dependencies.preflight.check({
      study: input.study,
      data_source: input.data_source,
    });
    const registered = preflight.capability_id ? this.dependencies.capabilities?.get(preflight.capability_id) : undefined;
    const analysis = registered
      ? await registered.execute({ study: input.study, preflight, threshold_mmol_l: input.threshold_mmol_l }) as Awaited<ReturnType<AssociationAnalysisService["execute"]>> | Awaited<ReturnType<PredictionAnalysisService["execute"]>> | Awaited<ReturnType<TreatmentEffectAnalysisService["execute"]>>
      : preflight.capability_id === "prediction.invasive_ventilation_24h.v1"
      ? await this.requirePrediction().execute({ study: input.study, preflight })
      : preflight.capability_id === "treatment_effect.early_vasopressor.in_hospital_mortality.v1"
        ? await this.requireTreatmentEffect().execute({ study: input.study, preflight })
        : await this.dependencies.analysis.execute({ study: input.study, preflight, threshold_mmol_l: input.threshold_mmol_l });
    const bundle = this.dependencies.evidence.create({ study: input.study, preflight, analysis });
    let saved: boolean;
    try {
      saved = await this.dependencies.runs.save(bundle);
    } catch {
      throw new ResearchWorkflowError("RUN_STORAGE_FAILURE", "The run artifact could not be saved.");
    }
    if (!saved) throw new ResearchWorkflowError("RUN_STORAGE_FAILURE", "The run artifact could not be saved.");
    return bundle;
  }

  private requirePrediction(): PredictionAnalysisService {
    if (!this.dependencies.prediction) throw new Error("Prediction analysis is unavailable.");
    return this.dependencies.prediction;
  }

  private requireTreatmentEffect(): TreatmentEffectAnalysisService {
    if (!this.dependencies.treatmentEffect) throw new Error("Treatment-effect analysis is unavailable.");
    return this.dependencies.treatmentEffect;
  }

  async getRun(runId: string): Promise<RunEvidenceBundle | undefined> {
    try {
      return await this.dependencies.runs.findByRunId(runId);
    } catch {
      throw new ResearchWorkflowError("RUN_STORAGE_FAILURE", "The run artifact could not be loaded.");
    }
  }

  async getRunsForStudy(studyIntegrityId: string): Promise<RunEvidenceBundle[]> {
    try {
      return await this.dependencies.runs.findByStudyIntegrityId(studyIntegrityId);
    } catch {
      throw new ResearchWorkflowError("RUN_STORAGE_FAILURE", "The study run artifacts could not be loaded.");
    }
  }
}
