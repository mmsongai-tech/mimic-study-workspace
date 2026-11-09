import type { LactateMortalityGateway } from "../gateways/lactate-mortality-gateway.js";
import {
  AssociationAnalysisError,
  type AssociationAnalysisResult,
  type AssociationExecutionRequest,
  type AssociationStatisticalExecutor,
} from "../domain/association-analysis.js";
import { executeCrudeLactateAssociation } from "../engines/crude-binary-association.js";

const capabilityId = "association.lactate.in_hospital_mortality.v1";

export class AssociationAnalysisService {
  constructor(
    private readonly gateway: LactateMortalityGateway,
    private readonly executor: AssociationStatisticalExecutor = {
      execute: async (input, studyIntegrityId, threshold) =>
        executeCrudeLactateAssociation(input, studyIntegrityId, threshold),
    },
  ) {}

  async execute(request: AssociationExecutionRequest): Promise<AssociationAnalysisResult> {
    if (
      request.preflight.status !== "supported" ||
      request.preflight.capability_id !== capabilityId ||
      request.preflight.confirmed_study_integrity_id !== request.study.integrity_id
    ) {
      throw new AssociationAnalysisError(
        "ANALYSIS_UNSUPPORTED",
        "The confirmed study does not have a matching supported preflight.",
      );
    }
    let input;
    try {
      input = await this.gateway.load();
    } catch (error) {
      if (error instanceof AssociationAnalysisError) throw error;
      throw new AssociationAnalysisError("ANALYSIS_DATA_UNAVAILABLE", "The analysis data is unavailable.");
    }
    try {
      return await this.executor.execute(input, request.study.integrity_id, request.threshold_mmol_l);
    } catch (error) {
      if (error instanceof AssociationAnalysisError) throw error;
      throw new AssociationAnalysisError("ANALYSIS_EXECUTION_FAILED", "The statistical execution failed.");
    }
  }
}
