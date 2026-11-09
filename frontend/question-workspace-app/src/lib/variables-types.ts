/** Shapes of the /api/variables endpoints (backend/src/question-workspace/variable-routes.ts). Hand-kept in sync, like api-types.ts. */
export type DefinitionKind = "lab_or_chart" | "drug" | "diagnosis" | "procedure_or_event" | "ratio" | "formula";
export type DefinitionStatus = "researcher_defined" | "team_reviewed" | "clinician_confirmed" | "validated";
export type SearchKind = "item" | "drug" | "diagnosis";
export type Aggregation = "first" | "last" | "minimum" | "maximum" | "mean" | "median" | "sum" | "any" | "count";

export interface VariableDefinition {
  schema_version: "1.0.0"; definition_id: string; version: string; kind: DefinitionKind;
  labels: { en: string; zh?: string }; synonyms: string[]; meaning: string; status: DefinitionStatus; author?: string;
  items?: { table: "labevents" | "chartevents" | "inputevents" | "outputevents" | "procedureevents"; item_ids: number[]; unit?: string; valid_range?: { min?: number; max?: number }; aggregation?: Aggregation };
  drug?: { prescription_labels?: string[]; input_item_ids?: number[] };
  diagnosis?: { codes: Array<{ code: string; version: 9 | 10 }> };
  ratio?: { numerator: string; denominator: string };
  formula?: { expression: string; variables: Record<string, string>; unit?: string };
}

export interface SearchHit {
  kind: SearchKind | "procedure"; id?: number; code?: string; version?: 9 | 10; label: string; table: string; rows: number; admissions: number;
  median?: number; p01?: number; p99?: number; units?: Array<[string, number]>;
}

export interface DefinitionCheck { check: "structure" | "items_exist" | "counts" | "distribution" | "name_collision" | "parts"; level: "error" | "warning" | "ok"; message: string }
export interface DefinitionReport {
  ok: boolean; checks: DefinitionCheck[];
  facts: { rows: number; admissions: number; median?: number; p01?: number; p99?: number; units?: Array<[string, number]>; item_labels: string[] };
}
export interface VariableLists { shared: VariableDefinition[]; workspace: VariableDefinition[] }
