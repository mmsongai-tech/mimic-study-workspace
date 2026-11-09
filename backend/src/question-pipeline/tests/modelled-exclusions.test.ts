import assert from "node:assert/strict";
import test from "node:test";
import { modelledExclusions, outcomeIsPopulation, pruneConditions } from "../plan-execution.js";

const cohort = (rows: Array<Record<string, unknown>>) => ({ rows, columns: [{ column: "exposure" }, { column: "outcome" }, { column: "age" }, { column: "lactate" }], quality: { excluded_rows: 10, exclusion_reasons: { not_in_population: 4, incomplete_model_variables: 6 } } });

test("a missing value of a switched-off covariate is not counted as a patient-flow exclusion", () => {
  const rows = [{ exposure: 1, outcome: 0, age: 60, lactate: null }, { exposure: 0, outcome: 1, age: 70, lactate: 2 }, { exposure: 1, outcome: 1, age: null, lactate: 1 }];
  const result = modelledExclusions(cohort(rows), { covariates: ["age"] });
  assert.deepEqual(result.exclusion_reasons, { not_in_population: 4, incomplete_model_variables: 1 });
  assert.equal(result.excluded_rows, 5);
});

test("the step disappears when every modelled variable is complete", () => {
  const result = modelledExclusions(cohort([{ exposure: 1, outcome: 0, age: 60, lactate: null }]), { covariates: ["age"] });
  assert.deepEqual(result.exclusion_reasons, { not_in_population: 4 });
  assert.equal(result.excluded_rows, 4);
});

test("an outcome that resolves to the population's own diagnosis is flagged, a different one is not", () => {
  const same = [{ role: "population", requested_term: "heart failure", selected: { mapping_id: "mimic-iv.heart-failure.v1" } }, { role: "outcome", requested_term: "Hospitalization due to heart failure", selected: { mapping_id: "mimic-iv.heart-failure.v1" } }];
  assert.equal(outcomeIsPopulation(same), "Hospitalization due to heart failure");
  const different = [{ role: "population", requested_term: "heart failure", selected: { mapping_id: "mimic-iv.heart-failure.v1" } }, { role: "outcome", requested_term: "death", selected: { mapping_id: "mimic-iv.all-cause-death.v1" } }];
  assert.equal(outcomeIsPopulation(different), undefined);
  assert.equal(outcomeIsPopulation([{ role: "outcome", requested_term: "death", selected: { mapping_id: "a" } }]), undefined, "no population, nothing to repeat");
});

test("a drug with no record in the archive is pruned from the comparison without emptying it", () => {
  const leaf = (id: string, concept: string) => ({ condition_id: id, source_text: concept, kind: "event_exists" as const, concept, occurrence: "present" as const });
  const tree = { condition_id: "population.all", source_text: "x", kind: "all" as const, operands: [{ condition_id: "population.target", source_text: "COPD", kind: "concept" as const, concept: "COPD", assertion: "present" as const }, { condition_id: "population.any_level", source_text: "x", kind: "any" as const, operands: [leaf("population.level1", "Albuterol"), leaf("population.level2", "Procaterol"), leaf("population.level3", "Salmeterol")] }] };
  const pruned = pruneConditions(tree, new Set(["population.level2"]))!;
  assert.deepEqual(JSON.stringify(pruned).includes("Procaterol"), false);
  assert.equal(JSON.stringify(pruned).includes("Albuterol") && JSON.stringify(pruned).includes("Salmeterol"), true);
  assert.equal(pruneConditions(leaf("population.level2", "Procaterol"), new Set(["population.level2"])), undefined);
});
