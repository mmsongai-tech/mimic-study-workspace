export type VariableMappingStatus =
  | "discovered"
  | "database_verified"
  | "model_reviewed"
  | "clinician_confirmed"
  | "validated"
  | "deprecated";

export type VariableSourceKind = "direct_field" | "dictionary_item" | "diagnosis_code" | "procedure_code" | "medication_label" | "diagnosis_code_score" | "derived";

/** A weighted group of ICD code prefixes (e.g. one Charlson category); a superseding group replaces the listed ones. */
export interface CodeScoreGroup { group_id: string; label: string; weight: number; code_prefixes: Array<{ prefix: string; version: 9 | 10 }>; supersedes?: string[] }
export type VariableDictionaryName = "d_items" | "d_labitems" | "d_icd_diagnoses" | "d_icd_procedures" | "prescriptions_drug";

export interface VariableSourceReference {
  kind: VariableSourceKind;
  schema: "mimiciv_hosp" | "mimiciv_icu" | "mimiciv_derived";
  table: string;
  columns: string[];
  dictionary_table?: VariableDictionaryName;
  item_ids?: number[];
  codes?: Array<{ code: string; version: 9 | 10 }>;
  value_filters?: Array<{ column: string; values: string[] }>;
  score_groups?: CodeScoreGroup[];
  /**
   * A recorded amount read as `amount × factor` when the row's item and unit match (e.g. IV fentanyl in mcg → IV morphine
   * equivalents in mg). Rows whose item/unit pair is not listed are ignored, so an unexpected unit never enters a sum.
   */
  amount_conversions?: Array<{ item_id: number; unit: string; factor: number }>;
}

/** A mapping compiled from a variable definition (docs/decisions/0009): whoever saved it chose its items, and every report states its review status. */
export const isVariableDefinition = (mapping: { mapping_id: string }): boolean => mapping.mapping_id.startsWith("variable-definition.");

export interface VariableOperationalDefinition {
  summary: string;
  temporal_rule: string;
  aggregation?: "first" | "last" | "minimum" | "maximum" | "mean" | "median" | "sum" | "standard_deviation" | "any" | "count";
  value_rule: string;
  missingness_rule: string;
  category_values?: Array<{ source_value: string; labels: string[] }>;
  /** Physiologically plausible range; recorded values outside it (charting artifacts) are ignored. Bounds are exclusive. */
  valid_range?: { min?: number; max?: number };
  /** A value computed per patient from other variables (a ratio or formula definition): `variables` maps each name of the expression to the concept it reads. */
  formula?: { expression: string; variables: Record<string, string>; unit?: string };
  derivation?: {
    schema_version: "1.0.0";
    operator: "difference";
    baseline: { purpose: "baseline"; aggregation: NonNullable<VariableOperationalDefinition["aggregation"]> };
    follow_up: { purpose: "follow_up"; aggregation: NonNullable<VariableOperationalDefinition["aggregation"]> };
    direction: "follow_up_minus_baseline" | "baseline_minus_follow_up";
  };
}

export interface VariableDictionaryEvidence {
  evidence_key: string;
  dictionary: VariableDictionaryName;
  identifier: string;
  label: string;
  code_version?: 9 | 10;
  category?: string;
  source_table?: string;
}

export const variableDictionaryEvidenceKey = (entry: Pick<VariableDictionaryEvidence, "dictionary" | "identifier" | "code_version">): string =>
  `${entry.dictionary}:${entry.code_version ?? "item"}:${entry.identifier}`;

export interface MappingCandidateReviewResult {
  schema_version: "1.0.0";
  requested_term: string;
  decision: "approved" | "rejected" | "blocked";
  selected_candidate_id: string | null;
  selected_evidence_keys: string[];
  ranked_candidate_ids: string[];
  reason_codes: string[];
  explanation: string;
}

export interface MappingCandidateEvidenceReview extends MappingCandidateReviewResult {
  review_id: string;
  reviewer_kind: "openai_compatible_model";
  provider: "openai_compatible";
  model: string;
  prompt: { id: "mapping-evidence-review"; version: "1.0.0" | "1.1.0" | "1.1.1" };
  reviewed_at: string;
  authorization_basis: "runtime_configured_automated_review";
  clinical_confirmation: false;
  evidence_sha256: string;
}

export interface VariableMappingRecord {
  schema_version: "1.0.0";
  mapping_id: string;
  concept_id: string;
  mapping_version: string;
  labels: { en: string; zh?: string };
  synonyms: string[];
  category: "demographic" | "encounter" | "vital_sign" | "laboratory" | "medication" | "intervention" | "diagnosis" | "score" | "outcome";
  value_type: "binary" | "categorical" | "continuous" | "count" | "date_time" | "duration";
  definition: VariableOperationalDefinition;
  sources: VariableSourceReference[];
  status: VariableMappingStatus;
  provenance: "versioned_seed" | "realtime_discovery" | "automated_model_review" | "clinician_review" | "team_validation";
  evidence: {
    catalog_integrity_id?: string;
    database_checked_at?: string;
    matched_record_count?: number;
    reviewer_note?: string;
    dictionary_entries?: VariableDictionaryEvidence[];
    semantic_code_hints?: {
      requested_prefixes: string[];
      checked_prefixes?: string[];
      matched_prefixes: string[];
      match_mode: "dictionary_prefix";
    };
    automated_review?: MappingCandidateEvidenceReview & { source_mapping_id: string };
    /** The source mapping and version an automatically derived variable was built from. */
    derived_from?: { mapping_id: string; mapping_version: string };
    data_profile?: {
      source_id: string;
      matched_record_count: number;
      missing_value_count: number;
      distinct_value_count: number;
      numeric?: { minimum: number; maximum: number; mean: number };
      units: Array<{ value: string; count: number }>;
      top_values: Array<{ value: string; count: number }>;
      profiled_at: string;
    };
  };
  created_at: string;
  updated_at: string;
}

export interface SemanticCodeHintCoverage {
  has_verified_matches: boolean;
  all_prefixes_checked: boolean;
  complete: boolean;
  unmatched_prefixes: string[];
}

/** Verifies that every declared matched prefix is backed by at least one frozen source code. */
export const semanticCodeHintCoverage = (mapping: VariableMappingRecord): SemanticCodeHintCoverage => {
  const hints = mapping.evidence.semantic_code_hints;
  if (!hints?.requested_prefixes.length) return { has_verified_matches: false, all_prefixes_checked: false, complete: false, unmatched_prefixes: [] };
  const normalizeCode = (value: string): string => value.replaceAll(".", "").toLocaleLowerCase();
  const requested = new Map(hints.requested_prefixes.map((prefix) => [normalizeCode(prefix), prefix]));
  const checked = new Set((hints.checked_prefixes ?? []).map(normalizeCode));
  const matched = new Set(hints.matched_prefixes.map(normalizeCode));
  const sourceCodes = mapping.sources.flatMap((source) => source.codes ?? []).map(({ code }) => normalizeCode(code));
  const matchedAreRequested = [...matched].every((prefix) => requested.has(prefix));
  const matchedHaveCodes = [...matched].every((prefix) => sourceCodes.some((code) => code.startsWith(prefix)));
  const hasVerifiedMatches = matched.size > 0 && matchedAreRequested && matchedHaveCodes;
  const allPrefixesChecked = requested.size > 0 && [...requested].every(([prefix]) => checked.has(prefix));
  const unmatchedPrefixes = [...requested].filter(([prefix]) => !matched.has(prefix)).map(([, original]) => original);
  return { has_verified_matches: hasVerifiedMatches, all_prefixes_checked: allPrefixesChecked, complete: hasVerifiedMatches && allPrefixesChecked && unmatchedPrefixes.length === 0, unmatched_prefixes: unmatchedPrefixes };
};

export interface VariableMappingCandidate {
  candidate_id: string;
  requested_term: string;
  normalized_term: string;
  role: "population" | "index_time" | "exposure" | "predictor" | "outcome" | "covariate";
  mapping: VariableMappingRecord;
  match_basis: Array<"validated_mapping" | "synonym" | "database_dictionary" | "schema_catalog" | "model_suggestion">;
  confidence: "high" | "medium" | "low";
  requires_clinician_confirmation: boolean;
  explanation: string;
}

export interface VariableMappingAssessment {
  schema_version: "1.0.0";
  requested_term: string;
  status: "resolved" | "needs_confirmation" | "unmapped";
  candidates: VariableMappingCandidate[];
  reason?: string;
  candidate_review?: MappingCandidateEvidenceReview;
}

export type VariableMappingErrorCode =
  | "MAPPING_INVALID"
  | "MAPPING_NOT_FOUND"
  | "MAPPING_TRANSITION_INVALID"
  | "MAPPING_STORAGE_FAILURE"
  | "MAPPING_SEARCH_UNAVAILABLE";

export class VariableMappingError extends Error {
  constructor(public readonly code: VariableMappingErrorCode, message: string) {
    super(message);
    this.name = "VariableMappingError";
  }
}
