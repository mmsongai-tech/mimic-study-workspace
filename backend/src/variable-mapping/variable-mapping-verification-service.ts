import type { ClinicalDatabaseCatalog } from "../clinical-database/index.js";
import type { VariableMappingRecord } from "./variable-mapping.js";
import { VariableMappingError } from "./variable-mapping.js";

export class VariableMappingVerificationService {
  constructor(private readonly catalog: ClinicalDatabaseCatalog, private readonly now = () => new Date().toISOString()) {}

  verify(record: VariableMappingRecord): VariableMappingRecord {
    const missing: string[] = [];
    for (const source of record.sources) {
      const relation = this.catalog.relations.find(({ schema, name }) => schema === source.schema && name === source.table);
      if (!relation) { missing.push(`${source.schema}.${source.table}`); continue; }
      const columns = new Set(relation.columns.map(({ name }) => name));
      for (const column of source.columns) if (!columns.has(column)) missing.push(`${source.schema}.${source.table}.${column}`);
      if (source.dictionary_table) {
        const virtualPrescriptionDictionary = source.kind === "medication_label"
          && source.dictionary_table === "prescriptions_drug"
          && source.schema === "mimiciv_hosp"
          && source.table === "prescriptions";
        if (virtualPrescriptionDictionary) {
          if (!source.value_filters?.some(({ column, values }) => column === "drug" && values.length > 0)) {
            missing.push("mimiciv_hosp.prescriptions.reviewed_drug_values");
          }
          continue;
        }
        if ((source.kind === "diagnosis_code" || source.kind === "procedure_code") && !source.codes?.length) {
          missing.push(`${source.schema}.${source.table}.reviewed_codes`);
        }
        if (source.kind === "dictionary_item" && !source.item_ids?.length) {
          missing.push(`${source.schema}.${source.table}.reviewed_item_ids`);
        }
        const dictionary = this.catalog.relations.find(({ name }) => name === source.dictionary_table);
        if (!dictionary) {
          missing.push(`dictionary.${source.dictionary_table}`);
        } else {
          const dictionaryColumns = new Set(dictionary.columns.map(({ name }) => name));
          const required = source.kind === "diagnosis_code" || source.kind === "procedure_code"
            ? ["icd_code", "icd_version"]
            : source.kind === "dictionary_item" ? ["itemid"] : [];
          for (const column of required) if (!dictionaryColumns.has(column)) missing.push(`dictionary.${source.dictionary_table}.${column}`);
        }
      }
    }
    if (missing.length) throw new VariableMappingError("MAPPING_INVALID", `The mapping references unavailable MIMIC-IV fields: ${missing.join(", ")}`);
    return {
      ...record,
      status: record.status === "discovered" ? "database_verified" : record.status,
      evidence: { ...record.evidence, database_checked_at: this.now() },
      updated_at: this.now(),
    };
  }
}
