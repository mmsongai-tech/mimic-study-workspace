import type { StudySpec } from "../research-design/study-spec.js";
import type { MimicMappingResult } from "../mimic-concept-mapping/domain/mimic-concept.js";
import type { AnalysisPlan } from "./analysis-plan.js";
import type { ClinicalStudyConceptAssessment } from "../clinical-concept-catalog/index.js";
import { selectStatisticalMethod } from "./statistical-method-catalog.js";

export class AnalysisPlanningService {
  plan(input: {
    study_spec: StudySpec;
    mapping: MimicMappingResult;
    clinical_concepts: ClinicalStudyConceptAssessment;
    registered_capability_id?: string;
    generated_execution_enabled: boolean;
  }): AnalysisPlan {
    if (input.study_spec.intent_family === "undetermined") {
      throw new Error("A classified research intent is required before analysis planning.");
    }
    const method = selectStatisticalMethod(input.study_spec);
    const fieldManifest = input.mapping.matches.flatMap((match) => match.status === "mapped"
      ? match.field_candidates.flatMap((candidate) => candidate.columns.map((name) => ({
        name: `${candidate.module}.${candidate.table}.${name}`,
        type: "category" as const,
        role: match.requested.role,
      })))
      : []);
    const blocking = [
      ...input.clinical_concepts.blocking_requirements,
      ...(input.registered_capability_id ? [] : input.mapping.blocking_requirements),
    ];
    if (!input.registered_capability_id && !input.generated_execution_enabled) {
      blocking.push("No registered capability matches and guarded generated execution is disabled.");
    }
    const executionMode = blocking.length > 0
      ? "none" as const
      : input.registered_capability_id
        ? "registered" as const
        : input.generated_execution_enabled
        ? "guarded_generated" as const
        : "none" as const;
    return {
      schema_version: "1.0.0",
      status: blocking.length ? "blocked" : "ready_for_confirmation",
      execution_mode: executionMode,
      ...(input.registered_capability_id ? { registered_capability_id: input.registered_capability_id } : {}),
      study_spec: input.study_spec,
      mapping: input.mapping,
      field_manifest: [...new Map(fieldManifest.map((field) => [field.name, field])).values()],
      clinical_concepts: input.clinical_concepts,
      method,
      blocking_requirements: blocking,
      warnings: [
        "Method selection is a reviewable plan, not proof of statistical validity.",
        ...(executionMode === "guarded_generated" ? ["Generated code requires source review, isolation, output validation, and explicit confirmation."] : []),
      ],
    };
  }
}
