import type { StudyVariableMappingReview } from "../variable-mapping/study-variable-mapping-service.js";

export interface DataFeasibilityBlocker {
  code: "MAPPING_UNRESOLVED" | "PROFILE_MISSING" | "DATA_SOURCE_UNAVAILABLE";
  role?: string;
  message: string;
  suggested_action: string;
}

export interface DataFeasibilityAssessment {
  schema_version: "1.0.0";
  status: "ready" | "needs_confirmation" | "blocked";
  data_source: { id: string; version: string; mode: "local_archive" | "approved_database" };
  mapping_summary: StudyVariableMappingReview["summary"];
  blockers: DataFeasibilityBlocker[];
  evidence: { catalog_integrity_id?: string; profile_id?: string };
}

/** Converts verified mapping/profile evidence into a generic feasibility decision. */
export const assessDataFeasibility = (input: {
  data_source: DataFeasibilityAssessment["data_source"];
  mappings: StudyVariableMappingReview;
  catalog_integrity_id?: string;
  profile_id?: string;
}): DataFeasibilityAssessment => {
  const blockers: DataFeasibilityBlocker[] = [];
  if (input.data_source.mode !== "local_archive" && input.data_source.mode !== "approved_database") {
    blockers.push({ code: "DATA_SOURCE_UNAVAILABLE", message: "The selected data source is not available for this run.", suggested_action: "Select a verified local archive or approved read-only database." });
  }
  for (const variable of input.mappings.variables) {
    if (variable.status === "unmapped") blockers.push({ code: "MAPPING_UNRESOLVED", role: variable.role, message: `No mapping was found for the ${variable.role} variable “${variable.requested_term}”.`, suggested_action: "Refine the clinical definition or review the MIMIC dictionary candidates." });
    else if (variable.status === "needs_confirmation") blockers.push({ code: "MAPPING_UNRESOLVED", role: variable.role, message: `The ${variable.role} variable “${variable.requested_term}” has candidates that still require confirmation.`, suggested_action: "Confirm the source field, coding, value rule and time window before execution." });
  }
  if (!input.profile_id) blockers.push({ code: "PROFILE_MISSING", message: "No aggregate data profile is attached to the feasibility decision.", suggested_action: "Run the read-only aggregate profiler for the confirmed mappings." });
  return {
    schema_version: "1.0.0", status: blockers.some(({ code }) => code === "DATA_SOURCE_UNAVAILABLE" || code === "MAPPING_UNRESOLVED") ? "blocked" : blockers.length ? "needs_confirmation" : "ready",
    data_source: input.data_source, mapping_summary: input.mappings.summary, blockers,
    evidence: { ...(input.catalog_integrity_id ? { catalog_integrity_id: input.catalog_integrity_id } : {}), ...(input.profile_id ? { profile_id: input.profile_id } : {}) },
  };
};
