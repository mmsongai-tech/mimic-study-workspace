import { createHash } from "node:crypto";
import type { MimicMappingResult } from "../mimic-concept-mapping/domain/mimic-concept.js";
import type { OutcomeStructure, ResearchIntent, StudySpec, StudyVariableRole } from "./study-spec.js";

export interface ProblemDecomposition { intent: ResearchIntent; population: string; index_time: string; exposure_or_predictors: Array<{ name: string; role: "exposure" | "predictor"; definition: string }>; outcome: { name: string; definition: string; structure: OutcomeStructure }; covariates: Array<{ name: string; definition: string }>; time_windows: StudySpec["time_windows"]; issues: string[]; }
export interface FrozenManifestField { role: Exclude<StudyVariableRole, "population">; requested_label: string; concept_id?: string | undefined; relation: string; columns: string[]; dictionary_table?: string | undefined; status: "confirmed"; }
export interface ConfirmedManifest { schema_version: "1.0.0"; manifest_id: string; study_integrity_id: string; data_model: "MIMIC-IV"; subject_id?: { relation: string; column: string }; fields: FrozenManifestField[]; time_windows: StudySpec["time_windows"]; confirmed_at: string; }
export interface ManifestCandidate { relation: string; columns: string[]; dictionary_table?: string; source: "catalog" | "dictionary"; }
export interface ManifestDraftField { role: "population" | "index_time" | StudyVariableRole; requested_label: string; status: "candidate" | "unmapped" | "blocked"; candidates: ManifestCandidate[]; reasons: string[]; }
export interface ManifestDraft { schema_version: "1.0.0"; study_integrity_id: string; fields: ManifestDraftField[]; requires_user_confirmation: true; blocking_reasons: string[]; }

export const decomposeStudy = (study: StudySpec): ProblemDecomposition => {
  const issues: string[] = [];
  if (study.intent_family === "undetermined") issues.push("Research purpose is not confirmed.");
  if (!study.population?.description) issues.push("Population definition is missing.");
  if (!study.index_time?.event) issues.push("Index time is missing.");
  if (!study.outcome?.name || !study.outcome_structure) issues.push("Outcome and outcome structure are required.");
  const variables = study.exposure_or_predictors ?? [];
  if (!variables.length) issues.push("At least one exposure or predictor is required.");
  return { intent: study.intent_family === "undetermined" ? "association" : study.intent_family, population: study.population?.description ?? "", index_time: study.index_time?.event ?? "", exposure_or_predictors: variables.map(({ name, role, operational_definition }) => ({ name, role: role === "predictor" ? "predictor" : "exposure", definition: operational_definition })), outcome: { name: study.outcome?.name ?? "", definition: study.outcome?.operational_definition ?? "", structure: study.outcome_structure ?? "binary" }, covariates: (study.covariates ?? []).map(({ name, operational_definition }) => ({ name, definition: operational_definition })), time_windows: study.time_windows, issues };
};

export const createManifestDraft = (study: StudySpec, mapping: MimicMappingResult): ManifestDraft => {
  const decomposition = decomposeStudy(study); const blocking_reasons = [...decomposition.issues];
  const fields = mapping.matches.map((match): ManifestDraftField => {
    const candidates = match.field_candidates.flatMap((candidate) => candidate.columns.map((column) => ({ relation: `${candidate.module}.${candidate.table}`, columns: [column], ...(candidate.dictionary_table ? { dictionary_table: candidate.dictionary_table } : {}), source: candidate.dictionary_table ? "dictionary" as const : "catalog" as const })));
    const reasons = [...match.warnings]; if (match.status === "unmapped") reasons.push("No catalog or dictionary candidate was found."); if (match.status === "requires_dictionary_resolution") reasons.push("A dictionary-backed definition requires researcher confirmation.");
    return { role: match.requested.role, requested_label: match.requested.text, status: match.status === "unmapped" ? "unmapped" : candidates.length ? match.status === "requires_dictionary_resolution" ? "blocked" : "candidate" : "unmapped", candidates, reasons };
  });
  if (mapping.blocking_requirements.length) blocking_reasons.push(...mapping.blocking_requirements);
  if (fields.some((field) => field.status !== "candidate")) blocking_reasons.push("Every non-candidate field requires researcher review before execution.");
  return { schema_version: "1.0.0", study_integrity_id: `sha256:${createHash("sha256").update(JSON.stringify(study)).digest("hex")}`, fields, requires_user_confirmation: true, blocking_reasons: [...new Set(blocking_reasons)] };
};

export const freezeConfirmedManifest = (study: StudySpec, mapping: MimicMappingResult, selections: Record<string, { relation: string; columns: string[]; dictionary_table?: string }>, confirmedAt = new Date().toISOString()): ConfirmedManifest => {
  const decomposition = decomposeStudy(study); if (decomposition.issues.length) throw new Error(`Study definition is incomplete: ${decomposition.issues.join(" ")}`);
  if (mapping.blocking_requirements.length || mapping.matches.some((match) => match.status === "unmapped")) throw new Error(`Variable mapping is incomplete: ${[...mapping.blocking_requirements, ...mapping.matches.filter((match) => match.status === "unmapped").map((match) => `No confirmed mapping for ${match.requested.text}.`)].join(" ")}`);
  const fields: FrozenManifestField[] = mapping.matches.filter((match) => match.status === "mapped" || match.status === "requires_dictionary_resolution").map((match) => { const selection = selections[match.requested.text]; if (!selection) throw new Error(`A confirmed field selection is required for: ${match.requested.text}`); const role: Exclude<StudyVariableRole, "population"> = match.requested.role === "index_time" || match.requested.role === "population" ? "covariate" : match.requested.role; return { role, requested_label: match.requested.text, ...(match.concept_id ? { concept_id: match.concept_id } : {}), relation: selection.relation, columns: [...selection.columns], ...(selection.dictionary_table ? { dictionary_table: selection.dictionary_table } : {}), status: "confirmed" }; });
  if (!fields.length) throw new Error("At least one mapped field is required.");
  const study_integrity_id = `sha256:${createHash("sha256").update(JSON.stringify(study)).digest("hex")}`;
  const subjectSelection = selections.__subject_id; const body = { schema_version: "1.0.0" as const, study_integrity_id, data_model: "MIMIC-IV" as const, ...(subjectSelection?.columns[0] ? { subject_id: { relation: subjectSelection.relation, column: subjectSelection.columns[0] } } : {}), fields, time_windows: study.time_windows, confirmed_at: confirmedAt };
  return { ...body, manifest_id: `manifest:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}` };
};
