/**
 * A variable definition: the one declarative form in which a variable is added to the platform, by a developer or a researcher
 * (docs/decisions/0009-variable-definition-standard.md). It names dictionary items, codes or labels and says how to read them;
 * it never contains code. The compiler turns it into a variable mapping record that the existing resolver and runner use.
 */
export type DefinitionKind = "lab_or_chart" | "drug" | "diagnosis" | "procedure_or_event" | "ratio" | "formula";
/** Review ladder; only the first is created by a researcher. */
export type DefinitionStatus = "researcher_defined" | "team_reviewed" | "clinician_confirmed" | "validated";
export type MeasurementTable = "labevents" | "chartevents" | "inputevents" | "outputevents" | "procedureevents";
export type Aggregation = "first" | "last" | "minimum" | "maximum" | "mean" | "median" | "sum" | "any" | "count";

export interface VariableDefinition {
  schema_version: "1.0.0";
  /** Lower-case words, digits and underscores; the stable identity of the variable. */
  definition_id: string;
  version: string;
  kind: DefinitionKind;
  labels: { en: string; zh?: string };
  synonyms: string[];
  /** One line saying what the variable means clinically. */
  meaning: string;
  status: DefinitionStatus;
  author?: string;
  /** A measurement read from dictionary items (laboratory, chart, input, output or procedure events). */
  items?: { table: MeasurementTable; item_ids: number[]; unit?: string; valid_range?: { min?: number; max?: number }; aggregation?: Aggregation };
  /** A drug read from prescription labels (exact labels of the archive), or from ICU input items. */
  drug?: { prescription_labels?: string[]; input_item_ids?: number[] };
  /** Diagnoses read from ICD codes; a code ending in "*" is a prefix and is expanded against the dictionary. */
  diagnosis?: { codes: Array<{ code: string; version: 9 | 10 }> };
  /** Numerator and denominator are the `definition_id` or concept id of existing variables. */
  ratio?: { numerator: string; denominator: string };
  /** Arithmetic over named variables: + - * / ( ) numbers and the functions min, max, abs, log. `variables` maps a name to a variable id. */
  formula?: { expression: string; variables: Record<string, string>; unit?: string };
}

export const DEFINITION_ID = /^[a-z][a-z0-9_]{2,63}$/u;
