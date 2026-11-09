export type ResearchObjectivePurpose = "association" | "prediction" | "treatment_effect";
export type ResearchObjectiveRelationship = "primary" | "secondary" | "effect_modification" | "mediation" | "composite_component";

export interface ResearchObjective {
  objective_id: string;
  purpose: ResearchObjectivePurpose;
  relationship: ResearchObjectiveRelationship;
  question: string;
  population: string;
  exposure_or_predictors: string[];
  comparator?: string;
  outcome: string;
  effect_modifiers: string[];
  mediator?: string;
  depends_on_objective_ids?: string[];
  source_claims: string[];
}

export interface ResearchAmbiguity {
  ambiguity_id: string;
  question: string;
  reason: string;
  affected_objective_ids: string[];
}

export interface ResearchObjectiveList {
  schema_version: "1.0.0";
  original_question: string;
  objectives: ResearchObjective[];
  ambiguities: ResearchAmbiguity[];
}

export interface ObjectiveCoverageReview {
  schema_version: "1.0.0";
  decision: "pass" | "needs_review";
  covered_claims: string[];
  missing_claims: string[];
  altered_claims: string[];
  unsupported_additions: string[];
  explanation: string;
}

/** Performs deterministic identity checks after model-based semantic review. */
export const validateObjectiveIdentities = (list: ResearchObjectiveList): string[] => {
  const issues: string[] = [];
  const objectiveIds = new Set<string>();
  const semanticObjectives = new Map<string, string>();
  const ambiguityIds = new Set<string>();
  for (const objective of list.objectives) {
    if (objectiveIds.has(objective.objective_id)) issues.push(`Duplicate objective_id: ${objective.objective_id}`);
    objectiveIds.add(objective.objective_id);
    if (!objective.source_claims.length) issues.push(`Objective ${objective.objective_id} has no source claim.`);
    if (objective.relationship === "effect_modification" && !objective.effect_modifiers.length) issues.push(`Objective ${objective.objective_id} has no effect modifier.`);
    if (objective.relationship === "effect_modification" && objective.effect_modifiers.some((modifier) => objective.exposure_or_predictors.includes(modifier))) {
      issues.push(`Objective ${objective.objective_id} repeats an effect modifier as an exposure or predictor.`);
    }
    if (objective.relationship === "mediation" && !objective.mediator) issues.push(`Objective ${objective.objective_id} has no mediator.`);
    for (const dependencyId of objective.depends_on_objective_ids ?? []) {
      if (dependencyId === objective.objective_id) issues.push(`Objective ${objective.objective_id} cannot depend on itself.`);
    }
    const normalizedModifiers = objective.effect_modifiers.map((value) => value.trim().toLocaleLowerCase()).sort();
    const semanticIdentity = JSON.stringify({
      purpose: objective.purpose,
      population: objective.population.trim().toLocaleLowerCase(),
      inputs: objective.exposure_or_predictors.map((value) => value.trim().toLocaleLowerCase()).filter((value) => !normalizedModifiers.includes(value)).sort(),
      comparator: objective.comparator?.trim().toLocaleLowerCase() ?? "",
      outcome: objective.outcome.trim().toLocaleLowerCase(),
      modifiers: normalizedModifiers,
      mediator: objective.mediator?.trim().toLocaleLowerCase() ?? "",
    });
    const priorObjective = semanticObjectives.get(semanticIdentity);
    if (priorObjective) issues.push(`Objective ${objective.objective_id} duplicates the estimand represented by ${priorObjective}.`);
    else semanticObjectives.set(semanticIdentity, objective.objective_id);
  }
  for (const objective of list.objectives) for (const dependencyId of objective.depends_on_objective_ids ?? []) {
    if (!objectiveIds.has(dependencyId)) issues.push(`Objective ${objective.objective_id} depends on unknown objective ${dependencyId}.`);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (objectiveId: string): void => {
    if (visiting.has(objectiveId)) { issues.push(`Objective dependency cycle includes ${objectiveId}.`); return; }
    if (visited.has(objectiveId)) return;
    visiting.add(objectiveId);
    const objective = list.objectives.find(({ objective_id }) => objective_id === objectiveId);
    for (const dependencyId of objective?.depends_on_objective_ids ?? []) if (objectiveIds.has(dependencyId)) visit(dependencyId);
    visiting.delete(objectiveId); visited.add(objectiveId);
  };
  for (const objective of list.objectives) visit(objective.objective_id);
  for (const ambiguity of list.ambiguities) {
    if (ambiguityIds.has(ambiguity.ambiguity_id)) issues.push(`Duplicate ambiguity_id: ${ambiguity.ambiguity_id}`);
    ambiguityIds.add(ambiguity.ambiguity_id);
    for (const objectiveId of ambiguity.affected_objective_ids) {
      if (!objectiveIds.has(objectiveId)) issues.push(`Ambiguity ${ambiguity.ambiguity_id} references unknown objective ${objectiveId}.`);
    }
  }
  return issues;
};

/** Checks invariants that JSON Schema cannot express for the independent coverage verdict. */
export const validateCoverageConsistency = (review: ObjectiveCoverageReview): string[] => {
  const hasFindings = review.missing_claims.length > 0 || review.altered_claims.length > 0 || review.unsupported_additions.length > 0;
  if (review.decision === "pass" && hasFindings) return ["A passing coverage review cannot contain findings."];
  if (review.decision === "needs_review" && !hasFindings) return ["A needs-review coverage decision must identify at least one finding."];
  return [];
};

export const objectiveListCanProceed = (list: ResearchObjectiveList, coverage: ObjectiveCoverageReview): boolean =>
  validateObjectiveIdentities(list).length === 0 && validateCoverageConsistency(coverage).length === 0 && coverage.decision === "pass";
