import { createHash } from "node:crypto";
import type { MappingCandidateEvidenceReview, VariableDictionaryEvidence, VariableMappingAssessment, VariableMappingCandidate } from "./variable-mapping.js";

export interface MappingCandidateEvidenceSummary {
  candidate_id: string;
  mapping_status: VariableMappingCandidate["mapping"]["status"];
  confidence: VariableMappingCandidate["confidence"];
  source: { schema: string; table: string; dictionary_table?: string };
  dictionary_entries: VariableDictionaryEvidence[];
  field_entries?: Array<{ evidence_key: string; schema: string; table: string; column: string }>;
}

export interface MappingCandidateReviewInput {
  requested_term: string;
  role: VariableMappingCandidate["role"];
  candidates: MappingCandidateEvidenceSummary[];
}

/** Provider boundary for a model that may select only supplied dictionary evidence. */
export interface MappingCandidateReviewer {
  review(input: MappingCandidateReviewInput): Promise<MappingCandidateEvidenceReview>;
}

export interface AppliedMappingCandidateReview {
  status: "approved" | "rejected" | "blocked";
  selected_candidate?: VariableMappingCandidate;
  review: MappingCandidateEvidenceReview;
}

export interface MappingCandidateReviewPolicy {
  max_selected_dictionary_entries: number;
  broad_dictionary_set_threshold: number;
}

export const defaultMappingCandidateReviewPolicy: MappingCandidateReviewPolicy = {
  max_selected_dictionary_entries: 100,
  broad_dictionary_set_threshold: 100,
};

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]))
    : value;
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;

const fieldEvidenceKey = (schema: string, table: string, column: string): string => `field:${schema}.${table}.${column}`;

export const mappingCandidateEvidenceSummary = (assessment: VariableMappingAssessment): MappingCandidateEvidenceSummary[] => assessment.candidates.flatMap((candidate) => {
  if (candidate.mapping.status !== "database_verified" || candidate.mapping.provenance !== "realtime_discovery") return [];
  const entries = candidate.mapping.evidence.dictionary_entries ?? [];
  const source = candidate.mapping.sources[0];
  if (!source) return [];
  const dictionaryEntries = source.dictionary_table ? entries.filter(({ dictionary }) => dictionary === source.dictionary_table) : [];
  const fieldEntries = source.kind === "direct_field" ? source.columns.map((column) => ({ evidence_key: fieldEvidenceKey(source.schema, source.table, column), schema: source.schema, table: source.table, column })) : [];
  return dictionaryEntries.length || fieldEntries.length ? [{
    candidate_id: candidate.candidate_id,
    mapping_status: candidate.mapping.status,
    confidence: candidate.confidence,
    source: { schema: source.schema, table: source.table, ...(source.dictionary_table ? { dictionary_table: source.dictionary_table } : {}) },
    dictionary_entries: dictionaryEntries,
    field_entries: fieldEntries,
  }] : [];
});

export const mappingCandidateEvidenceDigest = (input: MappingCandidateReviewInput): string => digest(input);

export const isCandidateExecutable = (candidate: VariableMappingCandidate, allowDatabaseVerified = false): boolean =>
  !candidate.requires_clinician_confirmation && (
    candidate.mapping.status === "validated"
    || candidate.mapping.status === "clinician_confirmed"
    || candidate.mapping.status === "model_reviewed"
    || (allowDatabaseVerified && candidate.mapping.status === "database_verified")
  );

const blocked = (review: MappingCandidateEvidenceReview, code: string): AppliedMappingCandidateReview => ({
  status: "blocked",
  review: { ...review, decision: "blocked", selected_candidate_id: null, selected_evidence_keys: [], reason_codes: [...new Set([...review.reason_codes, code])] },
});

const refineCandidate = (candidate: VariableMappingCandidate, review: MappingCandidateEvidenceReview): VariableMappingCandidate | undefined => {
  const selectedKeys = new Set(review.selected_evidence_keys);
  const dictionaryEntries = (candidate.mapping.evidence.dictionary_entries ?? []).filter(({ evidence_key }) => selectedKeys.has(evidence_key));
  const fieldEntries = candidate.mapping.sources.flatMap((source) => source.kind === "direct_field" ? source.columns.map((column) => ({ evidence_key: fieldEvidenceKey(source.schema, source.table, column), source, column })) : []);
  const selectedFields = fieldEntries.filter(({ evidence_key }) => selectedKeys.has(evidence_key));
  if (dictionaryEntries.length + selectedFields.length !== selectedKeys.size) return undefined;
  const sources = candidate.mapping.sources.map((source) => {
    if (source.kind === "direct_field") return { ...source, columns: selectedFields.filter((entry) => entry.source === source).map(({ column }) => column) };
    if (!source.dictionary_table) return source;
    const entries = dictionaryEntries.filter(({ dictionary }) => dictionary === source.dictionary_table);
    if (source.kind === "diagnosis_code" || source.kind === "procedure_code") return { ...source, codes: entries.flatMap((entry) => entry.code_version ? [{ code: entry.identifier, version: entry.code_version }] : []) };
    if (source.kind === "dictionary_item") return { ...source, item_ids: entries.map(({ identifier }) => Number(identifier)).filter(Number.isSafeInteger) };
    if (source.kind === "medication_label") return { ...source, value_filters: [{ column: "drug", values: entries.map(({ identifier }) => identifier) }] };
    return source;
  });
  const frozenCount = sources.reduce((count, source) => count + (source.kind === "direct_field" ? source.columns.length : source.codes?.length ?? source.item_ids?.length ?? source.value_filters?.reduce((sum, filter) => sum + filter.values.length, 0) ?? 0), 0);
  if (frozenCount !== selectedKeys.size) return undefined;
  const refinementId = digest({ source_mapping_id: candidate.mapping.mapping_id, evidence_sha256: review.evidence_sha256, selected_evidence_keys: [...selectedKeys].sort(), model: review.model, prompt: review.prompt }).slice(7, 27);
  const mappingId = `${candidate.mapping.mapping_id}.model-reviewed.${refinementId}`;
  const mapping = {
    ...candidate.mapping,
    mapping_id: mappingId,
    status: "model_reviewed" as const,
    provenance: "automated_model_review" as const,
    sources,
    evidence: { ...candidate.mapping.evidence, dictionary_entries: dictionaryEntries, automated_review: { ...review, source_mapping_id: candidate.mapping.mapping_id } },
    updated_at: review.reviewed_at,
  };
  return {
    ...candidate,
    candidate_id: `candidate:${mappingId}`,
    mapping,
    match_basis: [...new Set([...candidate.match_basis, "model_suggestion" as const])],
    confidence: "medium",
    requires_clinician_confirmation: false,
    explanation: "Runtime-authorized automated semantic review selected a frozen subset of verified dictionary evidence; this is not clinician confirmation.",
  };
};

/**
 * A reviewer may drop unrelated drug labels but never a label that literally contains the requested drug name
 * (tartrate/succinate/XL variants of the same ingredient); small models otherwise freeze incomplete exposures.
 */
const completeMedicationSelection = (requestedTerm: string, candidate: VariableMappingCandidate, review: MappingCandidateEvidenceReview): MappingCandidateEvidenceReview => {
  const name = requestedTerm.trim().toLocaleLowerCase();
  if (!candidate.mapping.sources.some(({ kind }) => kind === "medication_label") || name.length < 4 || !/^[a-z][a-z0-9 -]+$/u.test(name)) return review;
  const keys = new Set(review.selected_evidence_keys);
  for (const entry of candidate.mapping.evidence.dictionary_entries ?? []) {
    if (entry.dictionary === "prescriptions_drug" && entry.label.toLocaleLowerCase().includes(name)) keys.add(entry.evidence_key);
  }
  return keys.size === review.selected_evidence_keys.length ? review : { ...review, selected_evidence_keys: [...keys] };
};

/** Applies fail-closed rules and freezes only identifiers present in the supplied evidence. */
export const applyMappingCandidateReview = (assessment: VariableMappingAssessment, review: MappingCandidateEvidenceReview, policy: MappingCandidateReviewPolicy = defaultMappingCandidateReviewPolicy): AppliedMappingCandidateReview => {
  const summaries = mappingCandidateEvidenceSummary(assessment);
  const input: MappingCandidateReviewInput = { requested_term: assessment.requested_term, role: assessment.candidates[0]?.role ?? "covariate", candidates: summaries };
  if (review.requested_term !== assessment.requested_term) return blocked(review, "REQUESTED_TERM_MISMATCH");
  if (review.evidence_sha256 !== mappingCandidateEvidenceDigest(input)) return blocked(review, "EVIDENCE_DIGEST_MISMATCH");
  const candidateIds = new Set(summaries.map(({ candidate_id }) => candidate_id));
  if (new Set(review.ranked_candidate_ids).size !== review.ranked_candidate_ids.length || review.ranked_candidate_ids.some((id) => !candidateIds.has(id))) return blocked(review, "INVALID_CANDIDATE_RANKING");
  if (review.decision !== "approved") {
    if (review.selected_candidate_id !== null || review.selected_evidence_keys.length) return blocked(review, "NON_APPROVAL_CONTAINS_SELECTION");
    return { status: review.decision, review };
  }
  if (!review.selected_candidate_id) return blocked(review, "SELECTED_CANDIDATE_NOT_FOUND");
  const summary = summaries.find(({ candidate_id }) => candidate_id === review.selected_candidate_id);
  const selected = assessment.candidates.find(({ candidate_id }) => candidate_id === review.selected_candidate_id);
  if (!summary || !selected) return blocked(review, "SELECTED_CANDIDATE_NOT_FOUND");
  if (!review.selected_evidence_keys.length) return blocked(review, "DICTIONARY_EVIDENCE_SELECTION_EMPTY");
  if (new Set(review.selected_evidence_keys).size !== review.selected_evidence_keys.length) return blocked(review, "DUPLICATE_DICTIONARY_EVIDENCE");
  const availableKeys = new Set([...summary.dictionary_entries.map(({ evidence_key }) => evidence_key), ...(summary.field_entries ?? []).map(({ evidence_key }) => evidence_key)]);
  if (review.selected_evidence_keys.some((key) => !availableKeys.has(key))) return blocked(review, "DICTIONARY_EVIDENCE_NOT_FOUND");
  if (review.selected_evidence_keys.length > policy.max_selected_dictionary_entries) return blocked(review, "DICTIONARY_SELECTION_TOO_BROAD");
  if (availableKeys.size >= policy.broad_dictionary_set_threshold && review.selected_evidence_keys.length === availableKeys.size) return blocked(review, "BROAD_DICTIONARY_SET_NOT_REFINED");
  const refined = refineCandidate(selected, completeMedicationSelection(assessment.requested_term, selected, review));
  return refined ? { status: "approved", selected_candidate: refined, review } : blocked(review, "DICTIONARY_REFINEMENT_INVALID");
};
