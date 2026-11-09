import assert from "node:assert/strict";
import test from "node:test";
import type { ResearchDesignProposal } from "../research-design/model-proposal.js";
import { createSyntheticResearchDesignModel } from "./synthetic-research-design-model.js";

test("creates a new proposal from user-edited design fields", async () => {
  const model = createSyntheticResearchDesignModel();
  const proposal = await model.propose({
    request: {
      session_id: "session",
      base_revision: 1,
      answers: {
        population: "Adults with a first ICU admission",
        index_event: "First ICU admission",
        selection_rule: "One ICU stay per patient",
        exposure: "Early lactate",
        outcome: "Hospital mortality",
        summary_measure: "Adjusted odds ratio",
      },
      client_request_id: "edit-1",
    },
    current_spec: {
      schema_version: "1.0.0",
      intent_family: "association",
      research_question: "Study the association between lactate and in-hospital mortality.",
    },
  }) as ResearchDesignProposal;

  const values = new Map(proposal.spec_patch.flatMap((operation) =>
    operation.op === "remove" ? [] : [[operation.path, operation.value]]));
  assert.deepEqual(values.get("/population"), {
    description: "Adults with a first ICU admission",
    criteria: {
      condition_id: "population.synthetic_icu",
      source_text: "Adults with a first ICU admission",
      kind: "concept",
      concept: "Adults with a first ICU admission",
      assertion: "present",
    },
  });
  assert.deepEqual(values.get("/index_time"), {
    event: "First ICU admission",
    selection_rule: "One ICU stay per patient",
  });
  assert.equal((values.get("/exposure_or_predictors") as Array<{ name: string }>)[0]?.name, "Early lactate");
  assert.equal((values.get("/outcome") as { name: string }).name, "Hospital mortality");
  assert.equal((values.get("/estimand") as { summary_measure: string }).summary_measure, "Adjusted odds ratio");
});

for (const example of [
  {
    name: "ventilation prediction",
    message: "Predict invasive mechanical ventilation within 24 hours of ICU admission.",
    intent: "prediction",
    analysis: "binary_prediction",
  },
  {
    name: "vasopressor treatment effect",
    message: "Estimate the effect of early vasopressor use on in-hospital mortality.",
    intent: "treatment_effect",
    analysis: "propensity_weighted_treatment_effect",
  },
] as const) {
  test(`creates a complete ${example.name} proposal`, async () => {
    const proposal = await createSyntheticResearchDesignModel().propose({
      request: { message: example.message, client_request_id: example.name },
      current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
    }) as ResearchDesignProposal;
    const values = new Map(proposal.spec_patch.flatMap((operation) =>
      operation.op === "remove" ? [] : [[operation.path, operation.value]]));
    assert.equal(proposal.readiness, "candidate_ready");
    assert.equal(values.get("/intent_family"), example.intent);
    assert.equal(values.get("/analysis_family"), example.analysis);
    assert.ok(Array.isArray(values.get("/exposure_or_predictors")));
    assert.ok(values.get("/outcome"));
  });
}

test("applies clinician edits to prediction and treatment-effect designs", async () => {
  const model=createSyntheticResearchDesignModel();
  for (const [question,intent] of [["Predict invasive ventilation within 24 hours.","prediction"],["Estimate early vasopressor effect on mortality.","treatment_effect"]] as const) {
    const proposal=await model.propose({request:{session_id:intent,base_revision:1,answers:{population:"Edited eligible population",outcome:"Edited outcome",summary_measure:"Edited summary measure"},client_request_id:`edit-${intent}`},current_spec:{schema_version:"1.0.0",intent_family:intent,research_question:question}}) as ResearchDesignProposal;
    const values=new Map(proposal.spec_patch.flatMap((operation)=>operation.op==="remove"?[]:[[operation.path,operation.value]]));
    assert.deepEqual(values.get("/population"),{description:"Edited eligible population"});
    assert.equal((values.get("/outcome") as {name:string}).name,"Edited outcome"); assert.equal((values.get("/estimand") as {summary_measure:string}).summary_measure,"Edited summary measure");
  }
});

test("preserves an unsupported MIMIC question without substituting an executable template", async () => {
  const message = "研究 ICU 入科后 24 小时内液体正平衡与 28 天死亡。";
  const proposal = await createSyntheticResearchDesignModel().propose({
    request: { message, client_request_id: "unsupported-fluid-balance" },
    current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
  }) as ResearchDesignProposal;

  assert.equal(proposal.readiness, "needs_clarification");
  assert.match(proposal.assistant_message, /ready for a research-purpose decision/);
  assert.deepEqual(proposal.spec_patch, [{ op: "add", path: "/research_question", value: message }]);
  assert.equal(proposal.warnings[0]?.code, "DATA_MAPPING_REQUIRED");
  assert.equal(proposal.clarifying_questions[0]?.id, "research-purpose");
});

test("turns a clarification choice into the selected executable synthetic design", async () => {
  const proposal = await createSyntheticResearchDesignModel().propose({
    request: {
      session_id: "clarify",
      base_revision: 1,
      answers: { "research-purpose": "association" },
      client_request_id: "clarify-lactate",
    },
    current_spec: { schema_version: "1.0.0", intent_family: "undetermined", research_question: "糖尿病和死亡关联" },
  }) as ResearchDesignProposal;
  const values = new Map(proposal.spec_patch.flatMap((operation) => operation.op === "remove" ? [] : [[operation.path, operation.value]]));
  assert.equal(proposal.readiness, "candidate_ready");
  assert.equal(values.get("/intent_family"), "association");
  assert.ok(values.get("/population"));
  assert.ok(values.get("/outcome"));
});

test("infers an explicit association question without asking for the purpose", async () => {
  const proposal = await createSyntheticResearchDesignModel().propose({
    request: { message: "糖尿病和死亡关联", client_request_id: "explicit-association" },
    current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
  }) as ResearchDesignProposal;
  assert.equal(proposal.readiness, "candidate_ready");
  assert.equal(proposal.intent_assessment.recommended_intent, "association");
  assert.equal(proposal.clarifying_questions.length, 0);
  const outcome = proposal.spec_patch.find((operation) => operation.path === "/outcome");
  assert.notEqual(outcome?.op, "remove");
  assert.equal(((outcome as { value: { name: string } }).value).name, "死亡");
});
