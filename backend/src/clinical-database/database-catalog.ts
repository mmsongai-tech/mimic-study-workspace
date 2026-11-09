export interface ClinicalDatabaseColumn {
  name: string;
  data_type: string;
  nullable: boolean;
}

export interface ClinicalDatabaseRelation {
  schema: "mimiciv_hosp" | "mimiciv_icu" | "mimiciv_derived";
  name: string;
  relation_type: "table" | "view";
  columns: ClinicalDatabaseColumn[];
}

export interface ClinicalDatabaseCatalog {
  schema_version: "1.0.0";
  data_model: "MIMIC-IV";
  source_service: string;
  relations: ClinicalDatabaseRelation[];
  relation_count: number;
  column_count: number;
  inspected_at: string;
}

export interface ClinicalDatabaseCatalogSource {
  inspect(): Promise<ClinicalDatabaseRelation[]>;
}

export interface ClinicalDatabaseCatalogSnapshot {
  schema_version: "1.0.0";
  catalog: ClinicalDatabaseCatalog;
  integrity_id: string;
}

export interface ClinicalDatabaseCatalogSnapshotRepository {
  load(): Promise<ClinicalDatabaseCatalogSnapshot>;
  save(snapshot: ClinicalDatabaseCatalogSnapshot): Promise<void>;
}

export const isClinicalDatabaseRelation = (value: unknown): value is ClinicalDatabaseRelation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const relation = value as Record<string, unknown>;
  return ["mimiciv_hosp", "mimiciv_icu", "mimiciv_derived"].includes(String(relation.schema))
    && typeof relation.name === "string"
    && /^(table|view)$/u.test(String(relation.relation_type))
    && Array.isArray(relation.columns)
    && relation.columns.every((column) => Boolean(column && typeof column === "object"
      && typeof (column as Record<string, unknown>).name === "string"
      && typeof (column as Record<string, unknown>).data_type === "string"
      && typeof (column as Record<string, unknown>).nullable === "boolean"));
};
