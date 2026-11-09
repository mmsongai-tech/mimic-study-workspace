import type { VariableMappingRecord } from "./variable-mapping.js";

export interface PhenotypeDefinition {
  schema_version: "1.0.0";
  phenotype_id: string;
  role: "population" | "exposure" | "predictor" | "outcome" | "covariate";
  label: string;
  mapping_ids: string[];
  source_references: VariableMappingRecord["sources"];
  operational_definition: VariableMappingRecord["definition"];
  status: "ready" | "needs_confirmation" | "blocked";
  blockers: PhenotypeBlocker[];
  mapping_references: Array<{
    mapping_id: string;
    label: string;
    status: VariableMappingRecord["status"];
    sources: VariableMappingRecord["sources"];
    definition_summary: string;
  }>;
}

export interface PhenotypeBlocker {
  code: "MAPPING_NOT_FOUND" | "MAPPING_REVIEW_REQUIRED" | "TEMPORAL_RULE_CONFLICT";
  role: PhenotypeDefinition["role"];
  requested_label: string;
  message: string;
  suggested_action: string;
  candidate_mapping_ids: string[];
}

/** Builds a study phenotype from reviewed mappings without assuming a clinical term. */
export const buildPhenotypeDefinition = (input: {
  role: PhenotypeDefinition["role"];
  label: string;
  mappings: VariableMappingRecord[];
}): PhenotypeDefinition => {
  const blockers: PhenotypeBlocker[] = [];
  if (!input.mappings.length) blockers.push({
    code: "MAPPING_NOT_FOUND", role: input.role, requested_label: input.label,
    message: `No verified mapping was found for “${input.label}”.`,
    suggested_action: "Search the MIMIC-IV catalog or provide a more specific clinical definition.", candidate_mapping_ids: [],
  });
  const unreviewed = input.mappings.filter((mapping) => !["clinician_confirmed", "validated"].includes(mapping.status));
  if (unreviewed.length) blockers.push({
    code: "MAPPING_REVIEW_REQUIRED", role: input.role, requested_label: input.label,
    message: `候选映射已找到，但 ${unreviewed.map(({ labels }) => labels.zh ?? labels.en).join("、")} 尚未完成临床确认。`,
    suggested_action: "请核对候选表、字段、编码和值规则后确认；不要直接执行。",
    candidate_mapping_ids: unreviewed.map(({ mapping_id }) => mapping_id),
  });
  const definitions = input.mappings.map(({ definition }) => definition);
  const first = definitions[0];
  if (definitions.some((definition) => definition.temporal_rule !== first?.temporal_rule)) {
    blockers.push({
      code: "TEMPORAL_RULE_CONFLICT", role: input.role, requested_label: input.label,
      message: "候选字段的时间规则不一致，无法自动合并为一个表型。",
      suggested_action: "明确相对于 index time 的测量窗口，再选择或拆分候选映射。",
      candidate_mapping_ids: input.mappings.map(({ mapping_id }) => mapping_id),
    });
  }
  return {
    schema_version: "1.0.0",
    phenotype_id: `phenotype.${input.role}.${input.mappings.map(({ mapping_id }) => mapping_id).sort().join("+") || "unmapped"}`,
    role: input.role,
    label: input.label,
    mapping_ids: input.mappings.map(({ mapping_id }) => mapping_id),
    source_references: input.mappings.flatMap(({ sources }) => sources),
    operational_definition: first ?? {
      summary: "No operational definition available.", temporal_rule: "Define the index-relative window.",
      value_rule: "Define how source values determine the phenotype.", missingness_rule: "Define missing-value handling.",
    },
    status: blockers.some(({ code }) => code === "MAPPING_NOT_FOUND") ? "blocked" : blockers.length ? "needs_confirmation" : "ready",
    blockers,
    mapping_references: input.mappings.map((mapping) => ({ mapping_id: mapping.mapping_id, label: mapping.labels.zh ?? mapping.labels.en, status: mapping.status, sources: mapping.sources, definition_summary: mapping.definition.summary })),
  };
};
