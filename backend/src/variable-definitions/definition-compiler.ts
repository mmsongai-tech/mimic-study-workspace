import type { VariableMappingPack } from "../variable-mapping/file-variable-mapping-pack-repository.js";
import type { VariableMappingRecord, VariableSourceReference } from "../variable-mapping/variable-mapping.js";
import type { DictionaryIndex } from "./dictionary-index.js";
import type { VariableDefinition } from "./variable-definition.js";

type PackMapping = VariableMappingPack["mappings"][number];

const STATUS: Record<VariableDefinition["status"], VariableMappingRecord["status"]> = {
  researcher_defined: "database_verified", team_reviewed: "validated", clinician_confirmed: "clinician_confirmed", validated: "validated",
};
const COLUMNS: Record<string, { schema: VariableSourceReference["schema"]; columns: string[]; dictionary: "d_labitems" | "d_items"; time: string }> = {
  labevents: { schema: "mimiciv_hosp", columns: ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"], dictionary: "d_labitems", time: "charttime" },
  chartevents: { schema: "mimiciv_icu", columns: ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"], dictionary: "d_items", time: "charttime" },
  inputevents: { schema: "mimiciv_icu", columns: ["subject_id", "hadm_id", "stay_id", "itemid", "starttime", "amount"], dictionary: "d_items", time: "starttime" },
  outputevents: { schema: "mimiciv_icu", columns: ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "value"], dictionary: "d_items", time: "charttime" },
  procedureevents: { schema: "mimiciv_icu", columns: ["subject_id", "hadm_id", "stay_id", "itemid", "starttime", "value"], dictionary: "d_items", time: "starttime" },
};
const NOTE: Record<VariableDefinition["status"], string> = {
  researcher_defined: "Defined by a researcher; not reviewed by the team or a clinician.", team_reviewed: "Defined and checked by the platform team; not yet reviewed by a clinician.",
  clinician_confirmed: "Confirmed by a clinician.", validated: "Validated.",
};

/** Turns a definition into a pack entry, the form the resolver and the runner already read. Throws when the definition is incomplete. */
export const compileDefinition = (definition: VariableDefinition, index?: DictionaryIndex): PackMapping => {
  const base = {
    schema_version: "1.0.0" as const, mapping_id: `variable-definition.${definition.definition_id}.v1`, concept_id: definition.definition_id, mapping_version: definition.version,
    labels: definition.labels, synonyms: [...new Set([definition.labels.en, ...definition.synonyms])].filter((name) => name !== definition.labels.en), status: STATUS[definition.status],
  };
  const summary = `${definition.meaning} ${NOTE[definition.status]}`;
  const missingness = (noun: string): string => `No ${noun} in the window means not recorded, not confirmed absent.`;

  if ((definition.kind === "lab_or_chart" || definition.kind === "procedure_or_event") && definition.items) {
    const table = COLUMNS[definition.items.table]!; const ids = [...definition.items.item_ids].sort((a, b) => a - b);
    const labels = ids.map((id) => index?.item(definition.items!.table, id)?.label).filter(Boolean).join("; ");
    const measured = definition.kind === "lab_or_chart";
    const range = definition.items.valid_range;
    return { ...base,
      category: measured ? (definition.items.table === "labevents" ? "laboratory" : "vital_sign") : "intervention", value_type: measured ? "continuous" : "binary",
      definition: { summary, temporal_rule: measured ? "Values recorded in the study window relative to time zero." : "Any recorded event in the study window relative to time zero.",
        value_rule: `${measured ? "valuenum" : "Any record"} of ${definition.items.table} items ${ids.join(", ")}${labels ? ` (${labels})` : ""}${definition.items.unit ? `; unit ${definition.items.unit}` : ""}${range ? `; values outside (${range.min ?? "-∞"}, ${range.max ?? "∞"}) ignored as artifacts` : ""}.`,
        missingness_rule: missingness(measured ? "value" : "record"), aggregation: definition.items.aggregation ?? (measured ? "mean" : "any"), ...(range ? { valid_range: range } : {}) },
      sources: [{ kind: "dictionary_item", schema: table.schema, table: definition.items.table, columns: table.columns, dictionary_table: table.dictionary, item_ids: ids }] };
  }
  if (definition.kind === "drug" && definition.drug) {
    const labels = [...(definition.drug.prescription_labels ?? [])].sort(); const inputs = [...(definition.drug.input_item_ids ?? [])].sort((a, b) => a - b);
    if (labels.length && inputs.length) throw new Error("A drug is read from prescription labels or from ICU input items, not both; define two variables.");
    if (!labels.length && !inputs.length) throw new Error("A drug definition needs prescription labels or ICU input items.");
    const source: VariableSourceReference = labels.length
      ? { kind: "medication_label", schema: "mimiciv_hosp", table: "prescriptions", columns: ["subject_id", "hadm_id", "starttime", "stoptime", "drug", "dose_val_rx", "dose_unit_rx", "route"], dictionary_table: "prescriptions_drug", value_filters: [{ column: "drug", values: labels }] }
      : { kind: "dictionary_item", schema: "mimiciv_icu", table: "inputevents", columns: COLUMNS.inputevents!.columns, dictionary_table: "d_items", item_ids: inputs };
    return { ...base, category: "medication", value_type: "binary",
      definition: { summary, temporal_rule: labels.length ? "Apply the StudySpec exposure window to prescription start times." : "Any recorded infusion in the study window relative to time zero.",
        value_rule: labels.length ? `Presence of one of ${labels.length} prescription labels: ${labels.slice(0, 8).join(", ")}${labels.length > 8 ? ", …" : ""}.` : `Any record of inputevents items ${inputs.join(", ")}.`,
        missingness_rule: "No matching record in the window is treated as not given.", aggregation: "any" }, sources: [source] };
  }
  if (definition.kind === "diagnosis" && definition.diagnosis) {
    const codes = new Map<string, { code: string; version: 9 | 10 }>();
    for (const { code, version } of definition.diagnosis.codes) {
      if (code.endsWith("*")) { if (!index) throw new Error("A code prefix can only be expanded with the dictionary index."); for (const entry of index.codesWithPrefix("diagnosis", code.slice(0, -1), version)) codes.set(`${entry.code}|${version}`, { code: entry.code, version }); }
      else codes.set(`${code}|${version}`, { code, version });
    }
    if (!codes.size) throw new Error("The diagnosis codes match nothing.");
    return { ...base, category: "diagnosis", value_type: "binary",
      definition: { summary, temporal_rule: "Diagnosis codes of the admission (assigned at discharge).", value_rule: `Any of ${codes.size} ICD codes (${definition.diagnosis.codes.map(({ code, version }) => `ICD-${version} ${code}`).join(", ")}).`, missingness_rule: "No listed code means not recorded, not confirmed absent." },
      sources: [{ kind: "diagnosis_code", schema: "mimiciv_hosp", table: "diagnoses_icd", columns: ["subject_id", "hadm_id", "icd_code", "icd_version"], dictionary_table: "d_icd_diagnoses", codes: [...codes.values()].sort((a, b) => a.code.localeCompare(b.code)) }] };
  }
  if ((definition.kind === "ratio" && definition.ratio) || (definition.kind === "formula" && definition.formula)) {
    const formula = definition.kind === "ratio" ? { expression: "numerator / denominator", variables: { numerator: definition.ratio!.numerator, denominator: definition.ratio!.denominator } } : { expression: definition.formula!.expression, variables: definition.formula!.variables, ...(definition.formula!.unit ? { unit: definition.formula!.unit } : {}) };
    return { ...base, category: "score", value_type: "continuous",
      definition: { summary, temporal_rule: "Each part is read from the study window relative to time zero; the value is computed per patient.", value_rule: `${formula.expression}, with ${Object.entries(formula.variables).map(([name, id]) => `${name} = ${id}`).join(", ")}.`, missingness_rule: "A patient missing any part, or with a zero divisor, has no value.", formula },
      sources: [] };
  }
  throw new Error(`The ${definition.kind} definition is incomplete.`);
};
