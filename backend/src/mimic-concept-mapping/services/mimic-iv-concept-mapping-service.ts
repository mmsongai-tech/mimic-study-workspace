import type { StudySpec } from "../../research-design/study-spec.js";
import type {
  MimicConceptDefinition,
  MimicConceptCatalog,
  MimicConceptMatch,
  MimicMappingResult,
  RequestedStudyConcept,
} from "../domain/mimic-concept.js";
import { initialMimicIvConceptCatalog } from "./mimic-iv-concept-catalog.js";

const normalize = (value: string): string => value.toLocaleLowerCase("en-US").replaceAll(/[_-]+/gu, " ").trim();

const requestedConcepts = (spec: StudySpec): RequestedStudyConcept[] => [
  ...(spec.population ? [{ role: "population" as const, text: spec.population.description }] : []),
  ...(spec.index_time ? [{ role: "index_time" as const, text: `${spec.index_time.event} ${spec.index_time.selection_rule}` }] : []),
  ...(spec.exposure_or_predictors ?? []).map(({ role, name, operational_definition }) => ({
    role: role === "predictor" ? "predictor" as const : "exposure" as const,
    text: `${name} ${operational_definition}`,
  })),
  ...(spec.outcome ? [{ role: "outcome" as const, text: `${spec.outcome.name} ${spec.outcome.operational_definition}` }] : []),
  ...(spec.covariates ?? []).map(({ name, operational_definition }) => ({ role: "covariate" as const, text: `${name} ${operational_definition}` })),
];

const matchOne = (requested: RequestedStudyConcept, catalog: MimicConceptDefinition[]): MimicConceptMatch => {
  const text = normalize(requested.text);
  const definition = catalog.find(({ synonyms }) => synonyms.some((synonym) => text.includes(normalize(synonym))));
  if (!definition) {
    return {
      requested,
      status: "unmapped",
      field_candidates: [],
      warnings: ["No MIMIC-IV concept mapping is registered; execution is blocked."],
    };
  }
  return {
    requested,
    status: definition.requires_dictionary_resolution ? "requires_dictionary_resolution" : "mapped",
    concept_id: definition.id,
    label: definition.label,
    field_candidates: definition.field_candidates,
    warnings: definition.requires_dictionary_resolution
      ? ["Resolve and verify item identifiers against the connected MIMIC-IV dictionary before execution."]
      : [],
  };
};

export class MimicIvConceptMappingService {
  constructor(private readonly catalog: MimicConceptDefinition[] | MimicConceptCatalog = initialMimicIvConceptCatalog) {}

  mapStudy(spec: StudySpec): MimicMappingResult {
    const catalog = Array.isArray(this.catalog) ? this.catalog : this.catalog.list();
    const matches = requestedConcepts(spec).map((requested) => matchOne(requested, catalog));
    const blocking = matches.filter(({ status }) => status !== "mapped").map((match) =>
      match.status === "unmapped"
        ? `Unmapped ${match.requested.role}: ${match.requested.text}`
        : `Dictionary resolution required for ${match.concept_id}`);
    return {
      schema_version: "1.0.0",
      data_model: "MIMIC-IV",
      matches,
      blocking_requirements: blocking,
    };
  }
}
