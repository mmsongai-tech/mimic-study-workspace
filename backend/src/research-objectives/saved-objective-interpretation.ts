import { validateCoverageConsistency, validateObjectiveIdentities, type ObjectiveCoverageReview, type ResearchObjectiveList } from "./research-objective-list.js";
import { validateObjectiveCoverageReview, validateResearchObjectiveList } from "./schema-validator.js";

export interface SavedObjectiveInterpretation {
  objective_list: ResearchObjectiveList;
  coverage: ObjectiveCoverageReview;
  audit: [];
}

/** Loads only a schema-valid, coverage-consistent interpretation for the exact same question. */
export const loadSavedObjectiveInterpretation = (serialized: string, expectedQuestion: string): SavedObjectiveInterpretation => {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new Error("SAVED_OBJECTIVE_INTERPRETATION_INVALID_JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SAVED_OBJECTIVE_INTERPRETATION_INVALID");
  const record = parsed as Record<string, unknown>;
  const objectiveList = record.objective_list;
  const coverage = record.coverage_review ?? record.coverage;
  const issues = [
    ...validateResearchObjectiveList(objectiveList),
    ...validateObjectiveCoverageReview(coverage),
  ];
  if (issues.length) throw new Error("SAVED_OBJECTIVE_INTERPRETATION_SCHEMA_INVALID");
  const typedList = objectiveList as ResearchObjectiveList;
  const typedCoverage = coverage as ObjectiveCoverageReview;
  if (typedList.original_question !== expectedQuestion) throw new Error("SAVED_OBJECTIVE_INTERPRETATION_QUESTION_MISMATCH");
  if (validateObjectiveIdentities(typedList).length || validateCoverageConsistency(typedCoverage).length) {
    throw new Error("SAVED_OBJECTIVE_INTERPRETATION_INCONSISTENT");
  }
  return { objective_list: structuredClone(typedList), coverage: structuredClone(typedCoverage), audit: [] };
};
