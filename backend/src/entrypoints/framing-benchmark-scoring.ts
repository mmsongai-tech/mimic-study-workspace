import type { StudyFrame } from "../study-framing/index.js";

// Shared scoring for the study-framing benchmarks: token overlap of a frame's English labels with the published study's
// expected names, and facet-based study-type matching.

const STOP = new Set(["the", "of", "and", "or", "in", "with", "without", "to", "for", "a", "an", "at", "on", "by", "per", "any", "all", "patients", "patient", "adult", "adults", "icu", "hospital", "level", "levels", "use", "total", "rate", "risk", "day", "days", "mimic", "iv", "vs", "versus", "no", "non"]);
export const tokens = (value: string): Set<string> => new Set((value.toLocaleLowerCase().replaceAll("β", "beta").replaceAll("α", "alpha").match(/[a-z][a-z0-9]+/gu) ?? []).map((token) => token.replace(/s$/u, "")).filter((token) => token.length > 2 && !STOP.has(token)));
export const overlaps = (candidate: string | undefined, expected: string[]): boolean => {
  if (!candidate) return false;
  const found = tokens(candidate);
  return expected.some((name) => [...tokens(name)].some((token) => found.has(token)));
};

/** A benchmark study type is matched when any frame carries the facet that defines it. */
export const typeMatches = (expected: string, frames: StudyFrame[]): boolean => frames.some(({ facets, study_type }) => {
  switch (expected) {
    case "descriptive": return facets.goal === "describe";
    case "group_comparison": return facets.goal === "compare_groups";
    case "association": return facets.goal === "relate_factor";
    case "treatment_effect": return facets.goal === "evaluate_treatment";
    case "time_to_event": return facets.outcome_kind === "time_to_event";
    case "longitudinal_change": return facets.outcome_kind === "change_over_time";
    case "dose_response": return facets.dose_question;
    case "effect_modification": return facets.has_modifier;
    case "mediation": return facets.has_mediator;
    case "prediction": return facets.goal === "predict";
    default: return study_type === expected;
  }
});

export const labels = (frames: StudyFrame[], pick: (frame: StudyFrame) => Array<{ text: string; normalized?: { label_en: string } } | undefined>): string =>
  frames.flatMap(pick).filter(Boolean).map((slot) => `${slot!.normalized?.label_en ?? ""} ${slot!.text}`).join(" | ");
