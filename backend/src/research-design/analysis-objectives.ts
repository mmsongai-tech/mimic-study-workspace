import type { AnalysisObjectiveDefinition, StudySpec, TimeWindow } from "./study-spec.js";
import { listStudyConditions } from "./study-condition.js";

export interface AnalysisObjectiveIssue { code: string; field_path: string; message: string }

const windowIdentity = (window: TimeWindow): string => "end_event" in window
  ? JSON.stringify([window.anchor, window.end_event])
  : JSON.stringify([window.anchor, window.start_offset, window.end_offset, window.unit]);

/** Copies model-authored target fields; never infers targets from Boolean leaves. */
export const projectAnalysisObjective = (study: StudySpec, objective: AnalysisObjectiveDefinition): StudySpec => {
  const { analysis_objectives: _program, ...shared } = structuredClone(study);
  const windows = [...(shared.time_windows ?? []).filter(({ purpose }) => purpose === "baseline" || purpose === "exposure"), ...structuredClone(objective.time_windows)];
  const derivation = objective.outcome.derivation;
  if (derivation) for (const window of [derivation.baseline, derivation.follow_up]) {
    if (!windows.some((existing) => existing.purpose === window.purpose)) windows.push(structuredClone(window));
  }
  return { ...shared, outcome: structuredClone(objective.outcome), outcome_structure: objective.outcome_structure,
    time_windows: windows, estimand: structuredClone(objective.estimand), analysis_family: objective.analysis_family };
};

/** Root outcome fields remain a compatibility summary, not an execution target list. */
export const withAnalysisObjectiveSummary = (spec: StudySpec): StudySpec => {
  const first = spec.analysis_objectives?.objectives[0];
  return first ? { ...projectAnalysisObjective(spec, first), analysis_objectives: structuredClone(spec.analysis_objectives!) } : spec;
};

export const assessAnalysisObjectiveContract = (spec: StudySpec): AnalysisObjectiveIssue[] => {
  const program = spec.analysis_objectives;
  if (!program) return [];
  const issues: AnalysisObjectiveIssue[] = [];
  const add = (code: string, field: string, message: string) => issues.push({ code, field_path: `/analysis_objectives/${field}`, message });
  if (!program.requested.length) add("OBJECTIVE_INVENTORY_REQUIRED", "requested", "List the independent research objectives before confirmation.");
  const requested = new Map(program.requested.map((item) => [item.objective_id, item]));
  if (requested.size !== program.requested.length) add("OBJECTIVE_ID_DUPLICATE", "requested", "Requested objective identifiers must be unique.");
  const seen = new Set<string>();
  for (const [index, objective] of program.objectives.entries()) {
    const path = `objectives/${index}`;
    if (seen.has(objective.objective_id)) add("OBJECTIVE_ID_DUPLICATE", path, "Each objective must appear exactly once.");
    seen.add(objective.objective_id);
    const target = requested.get(objective.objective_id);
    if (!target) add("OBJECTIVE_NOT_REQUESTED", path, "This objective is not linked to the frozen request inventory.");
    if (target?.outcome_structure && objective.outcome_structure !== target.outcome_structure) add("OBJECTIVE_SCALE_CHANGED", `${path}/outcome_structure`, "An objective cannot change its frozen outcome scale to make execution possible.");
    if (objective.status === "blocked" && !objective.blocking_reason?.trim()) add("OBJECTIVE_BLOCK_REASON_REQUIRED", path, "An unsupported objective requires an explicit reason.");
    if (objective.outcome.role !== "outcome") add("OBJECTIVE_ROLE_INVALID", `${path}/outcome/role`, "An analysis objective must identify its outcome.");
    const derivation = objective.outcome.derivation;
    if (target?.requires_derivation && !derivation) add("OBJECTIVE_DERIVATION_REQUIRED", `${path}/outcome`, "The requested derived measurement must retain its explicit derivation.");
    const leaves = objective.outcome.definition ? listStudyConditions(objective.outcome.definition) : [];
    if (objective.outcome_structure === "continuous" && (leaves.some(({ kind }) => kind === "numeric_comparison" || kind === "category_comparison" || kind === "event_exists") || objective.outcome.contrast?.kind === "threshold" || objective.outcome.contrast?.kind === "binary_presence")) {
      add("CONTINUOUS_VALUE_AS_PREDICATE", `${path}/outcome`, "A continuous measurement is not a threshold event. Put eligibility restrictions in population criteria instead.");
    }
    if (derivation) {
      if (objective.outcome_structure !== "continuous") add("DERIVATION_SCALE_INVALID", `${path}/outcome`, "The fixed difference operator returns a continuous measurement.");
      if (derivation.baseline.purpose !== "baseline" || derivation.follow_up.purpose !== "follow_up") add("DERIVATION_WINDOW_ROLE_INVALID", `${path}/outcome/derivation`, "Difference windows must be explicitly marked baseline and follow_up.");
      for (const window of [derivation.baseline, derivation.follow_up]) {
        if ("end_offset" in window && window.end_offset <= window.start_offset) add("DERIVATION_WINDOW_INVALID", `${path}/outcome/derivation`, "A measurement window must have positive duration.");
      }
      const projected = projectAnalysisObjective(spec, objective);
      for (const window of [derivation.baseline, derivation.follow_up]) {
        const candidates = projected.time_windows?.filter(({ purpose }) => purpose === window.purpose) ?? [];
        if (candidates.length !== 1 || windowIdentity(candidates[0]!) !== windowIdentity(window)) add("DERIVATION_WINDOW_CONFLICT", `${path}/outcome/derivation`, "Derivation windows must agree with the shared baseline and the objective follow-up; conflicting windows cannot be silently replaced.");
      }
    }
  }
  for (const id of requested.keys()) if (!seen.has(id)) add("OBJECTIVE_NOT_COVERED", "objectives", `The requested objective ${id} needs a defined or explicitly blocked target.`);
  return issues;
};

/** A continuation cannot quietly erase already extracted goals or their scale. */
export const objectivePreservationIssues = (previous: StudySpec, next: StudySpec): string[] => {
  if (!previous.analysis_objectives) return [];
  if (!next.analysis_objectives) return ["/analysis_objectives must be preserved"];
  if (previous.analysis_objectives.original_question !== next.analysis_objectives.original_question) return ["/analysis_objectives/original_question must preserve the exact original input"];
  return previous.analysis_objectives.requested.flatMap((prior) => {
    const item = next.analysis_objectives!.requested.find(({ objective_id }) => objective_id === prior.objective_id);
    return !item || item.source_text !== prior.source_text || (prior.outcome_structure && item.outcome_structure !== prior.outcome_structure) || (prior.requires_derivation && !item.requires_derivation)
      ? [`/analysis_objectives/requested/${prior.objective_id} must preserve the frozen source goal and measurement scale`] : [];
  });
};
