import type { ConfirmedStudySpec } from "../research-design/design-session.js";
import type { DataSourceDescriptor } from "../research-feasibility/domain/preflight.js";
import type { ResearchPreflightService } from "../research-feasibility/services/research-preflight-service.js";
import type { MimicIvConceptMappingService } from "../mimic-concept-mapping/services/mimic-iv-concept-mapping-service.js";
import type { AnalysisPlan } from "./analysis-plan.js";
import type { AnalysisPlanningService } from "./analysis-planning-service.js";
import type { ClinicalConceptCatalogService } from "../clinical-concept-catalog/index.js";

export class ResearchAnalysisPlanService {
  constructor(private readonly dependencies: {
    preflight: ResearchPreflightService;
    mapping: MimicIvConceptMappingService;
    planning: AnalysisPlanningService;
    clinicalConcepts: ClinicalConceptCatalogService;
    generated_execution_enabled: boolean;
  }) {}

  create(input: { study: ConfirmedStudySpec; data_source: DataSourceDescriptor }): AnalysisPlan {
    const preflight = this.dependencies.preflight.check(input);
    return this.dependencies.planning.plan({
      study_spec: input.study.spec,
      mapping: this.dependencies.mapping.mapStudy(input.study.spec),
      clinical_concepts: this.dependencies.clinicalConcepts.assessStudy(input.study.spec),
      ...(preflight.status === "supported" && preflight.capability_id
        ? { registered_capability_id: preflight.capability_id }
        : {}),
      generated_execution_enabled: this.dependencies.generated_execution_enabled,
    });
  }
}
