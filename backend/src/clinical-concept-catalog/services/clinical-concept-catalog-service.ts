import type {
  ClinicalConceptDefinition,
  ClinicalConceptRequest,
  ClinicalConceptResolution,
  ClinicalStudyConceptAssessment,
} from "../domain/clinical-concept.js";
import type { StudySpec } from "../../research-design/index.js";
import { initialClinicalConceptCatalog } from "./initial-clinical-concept-catalog.js";

const normalize = (value: string): string => value
  .normalize("NFKC")
  .toLocaleLowerCase("en-US")
  .replaceAll(/[_–—-]+/gu, " ")
  .replaceAll(/\s+/gu, " ")
  .trim();

const aliasMatches = (text: string, alias: string): boolean => {
  const normalizedAlias = normalize(alias);
  return normalizedAlias.length > 1 && text.includes(normalizedAlias);
};

export class ClinicalConceptCatalogService {
  private readonly catalogById: Map<string, ClinicalConceptDefinition>;

  constructor(private readonly catalog: ClinicalConceptDefinition[] = initialClinicalConceptCatalog) {
    this.catalogById = new Map(catalog.map((definition) => [definition.id, definition]));
    if (this.catalogById.size !== catalog.length) throw new Error("Clinical concept identifiers must be unique.");
  }

  list(): ClinicalConceptDefinition[] {
    return this.catalog.map((definition) => structuredClone(definition));
  }

  get(conceptId: string): ClinicalConceptDefinition | undefined {
    const definition = this.catalogById.get(conceptId);
    return definition ? structuredClone(definition) : undefined;
  }

  resolve(request: ClinicalConceptRequest): ClinicalConceptResolution {
    const normalizedText = normalize(request.text);
    const candidates = this.catalog.filter((definition) =>
      [definition.label, ...Object.values(definition.localized_labels), ...definition.synonyms]
        .some((alias) => aliasMatches(normalizedText, alias)));
    if (candidates.length === 0) {
      return {
        request,
        status: "unresolved",
        candidate_concept_ids: [],
        requirements: ["Define the clinical concept before selecting a data-source mapping."],
        warnings: ["The concept was not inferred from free text; execution must remain blocked."],
      };
    }
    if (candidates.length > 1) {
      return {
        request,
        status: "ambiguous",
        candidate_concept_ids: candidates.map(({ id }) => id),
        requirements: ["Ask the researcher to select the intended clinical concept."],
        warnings: ["Multiple registered clinical concepts match the supplied text."],
      };
    }
    const resolved = candidates[0]!;
    return {
      request,
      status: "resolved",
      concept: structuredClone(resolved),
      candidate_concept_ids: [resolved.id],
      requirements: [...resolved.temporal_requirements, ...resolved.source_requirements],
      warnings: resolved.mapping_status === "source_mapping_required"
        ? ["The clinical concept is defined, but a source-specific mapping must be verified before data execution."]
        : [],
    };
  }

  assessStudy(spec: StudySpec): ClinicalStudyConceptAssessment {
    const requests: ClinicalConceptRequest[] = [
      ...(spec.exposure_or_predictors ?? []).map((variable) => ({
        role: variable.role === "predictor" ? "predictor" as const : "exposure" as const,
        text: variable.name,
      })),
      ...(spec.outcome ? [{ role: "outcome" as const, text: spec.outcome.name }] : []),
      ...(spec.covariates ?? []).map((variable) => ({ role: "covariate" as const, text: variable.name })),
    ];
    const resolutions = requests.map((request) => this.resolve(request));
    const blockingRequirements = resolutions
      .filter(({ status }) => status !== "resolved")
      .map(({ request, status }) => `${status === "ambiguous" ? "Clarify" : "Define"} ${request.role}: ${request.text}`);
    return {
      status: blockingRequirements.length > 0 ? "needs_clarification" : "ready_for_source_mapping",
      resolutions,
      blocking_requirements: blockingRequirements,
    };
  }
}
