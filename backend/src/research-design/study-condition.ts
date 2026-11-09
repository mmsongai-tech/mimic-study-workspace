import type { StudyCondition } from "./study-spec.js";

export interface StudyConditionIssue {
  code: "CONDITION_ID_DUPLICATE" | "CONDITION_SOURCE_UNTRACEABLE" | "CONDITION_WINDOW_INVALID";
  condition_id: string;
  message: string;
}

/** Traverses a semantic condition tree without assigning database meaning. */
export const listStudyConditions = (root: StudyCondition): StudyCondition[] => {
  const result: StudyCondition[] = [];
  const visit = (condition: StudyCondition): void => {
    result.push(condition);
    if (condition.kind === "all" || condition.kind === "any") condition.operands.forEach(visit);
    if (condition.kind === "not") visit(condition.operand);
  };
  visit(root);
  return result;
};

/** Validates traceability and temporal invariants that JSON Schema cannot express. */
export const validateStudyCondition = (root: StudyCondition): StudyConditionIssue[] => {
  const issues: StudyConditionIssue[] = [];
  const seen = new Set<string>();
  for (const condition of listStudyConditions(root)) {
    if (seen.has(condition.condition_id)) issues.push({ code: "CONDITION_ID_DUPLICATE", condition_id: condition.condition_id, message: "Condition identifiers must be unique within one tree." });
    seen.add(condition.condition_id);
    if (!condition.source_text.trim()) issues.push({ code: "CONDITION_SOURCE_UNTRACEABLE", condition_id: condition.condition_id, message: "Every condition must retain the natural-language fragment that produced it." });
    if (condition.kind === "event_exists" && condition.window && "end_offset" in condition.window && condition.window.end_offset < condition.window.start_offset) issues.push({ code: "CONDITION_WINDOW_INVALID", condition_id: condition.condition_id, message: "A condition time window cannot end before it starts." });
  }
  return issues;
};
