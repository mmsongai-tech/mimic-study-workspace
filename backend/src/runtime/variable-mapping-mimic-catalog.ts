import type { MimicConceptCatalog, MimicConceptDefinition, MimicIvFieldCandidate } from "../mimic-concept-mapping/index.js";
import { initialMimicIvConceptCatalog } from "../mimic-concept-mapping/services/mimic-iv-concept-catalog.js";
import type { VariableMappingRecord } from "../variable-mapping/index.js";

const moduleName = (schema: VariableMappingRecord["sources"][number]["schema"]): MimicIvFieldCandidate["module"] =>
  schema === "mimiciv_hosp" ? "hosp" : schema === "mimiciv_icu" ? "icu" : "derived";

const convert = (mapping: VariableMappingRecord): MimicConceptDefinition => ({
  id: mapping.concept_id,
  label: mapping.labels.en,
  synonyms: [mapping.labels.en, mapping.labels.zh, ...mapping.synonyms].filter((value): value is string => Boolean(value)),
  field_candidates: mapping.sources.map((source) => ({
    module: moduleName(source.schema), table: source.table, columns: source.columns,
    ...(source.dictionary_table ? { dictionary_table: source.dictionary_table } : {}),
  })),
  requires_dictionary_resolution: false,
});

export class MutableVariableMappingMimicCatalog implements MimicConceptCatalog {
  private readonly definitions = new Map<string, MimicConceptDefinition>(initialMimicIvConceptCatalog.map((definition) => [definition.id, definition]));
  register(mapping: VariableMappingRecord): void {
    if (["model_reviewed", "clinician_confirmed", "validated"].includes(mapping.status)) this.definitions.set(mapping.concept_id, convert(mapping));
  }
  list(): MimicConceptDefinition[] { return [...this.definitions.values()]; }
}
