import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryDesignSessionRepository,
  createResearchDesignService,
  DesignError,
} from "../index.js";
import {
  ambiguousProposal,
  associationProposal,
  baseProposal,
  completeAssociationProposal,
  queuedModel,
  startRequest,
} from "./model-fixtures.js";

test("continues the same session after the user answers a clarification", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  const service = createResearchDesignService(
    queuedModel(ambiguousProposal(), associationProposal()),
    sessions,
  );
  const first = await service.start(startRequest);

  const second = await service.continue({
    session_id: first.session_id,
    base_revision: first.revision,
    answers: { intent: "association" },
    client_request_id: "continue-1",
  });

  assert.equal(second.session_id, first.session_id);
  assert.equal(second.revision, 2);
  assert.equal(second.study_spec.intent_family, "association");
  assert.equal((await sessions.findById(first.session_id))?.revision, 2);
});

test("adds every model-defined effect modifier to covariates without inventing mapping details", async () => {
  const proposal = completeAssociationProposal();
  const candidate = proposal.spec_patch.reduce((spec, operation) => operation.op === "remove" ? spec : { ...spec, [operation.path.slice(1)]: operation.value }, { schema_version: "1.0.0", intent_family: "undetermined" } as NonNullable<typeof proposal.candidate_spec>);
  candidate.effect_modifiers = [{ variable_name: "Subgroup", analysis: "interaction_and_stratified", report_levels: ["A", "B"] }];
  candidate.covariates = [];
  const service = createResearchDesignService(
    queuedModel({ ...proposal, candidate_spec: candidate, spec_patch: [] }),
    createInMemoryDesignSessionRepository(),
  );

  const view = await service.start({ ...startRequest, client_request_id: "effect-modifier-covariate" });
  assert.deepEqual(view.study_spec.covariates, [{ name: "Subgroup", role: "covariate", operational_definition: "Subgroup" }]);
  assert.equal(view.clarifying_questions.some(({ id }) => id === "protocol-effect_modifier_variable_missing"), false);
});

test("provides prior clarification answers to every later model turn", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  let call = 0;
  let observedHistory: unknown;
  const service = createResearchDesignService({ propose: async (input) => {
    call += 1;
    if (call === 3) observedHistory = input.clarification_history;
    return call < 3 ? ambiguousProposal() : associationProposal();
  } }, sessions);
  const first = await service.start({ ...startRequest, client_request_id: "history-start" });
  const second = await service.continue({
    session_id: first.session_id,
    base_revision: first.revision,
    answers: { intent: "association" },
    client_request_id: "history-one",
  });
  await service.continue({
    session_id: second.session_id,
    base_revision: second.revision,
    answers: { intent: "association" },
    client_request_id: "history-two",
  });

  assert.equal((observedHistory as Array<{ answer_context?: Array<{ question: string; selected_label: string }> }>).length, 2);
  assert.deepEqual((observedHistory as Array<{ answer_context?: unknown }>)[0]?.answer_context, [{
    question_id: "intent",
    question: "Do you want association or treatment effect?",
    selected_value: "association",
    selected_label: "Association",
  }]);
  assert.deepEqual((await sessions.findById(first.session_id))?.clarification_history, [
    {
      answers: { intent: "association" },
      answer_context: [{ question_id: "intent", question: "Do you want association or treatment effect?", selected_value: "association", selected_label: "Association" }],
    },
    {
      answers: { intent: "association" },
      answer_context: [{ question_id: "intent", question: "Do you want association or treatment effect?", selected_value: "association", selected_label: "Association" }],
    },
  ]);
  const reviewHistory = (await sessions.findById(first.session_id))?.clarification_review_history;
  assert.equal(reviewHistory?.length, 2);
  assert.equal(reviewHistory?.[0]?.response_kind, "single_select");
  assert.ok((reviewHistory?.[0]?.options?.length ?? 0) >= 2);
  assert.equal(reviewHistory?.[0]?.selected_value, "association");
});

test("applies a structured design suggestion without another model call", async () => {
  const complete = completeAssociationProposal();
  const candidate = complete.spec_patch.reduce((spec, operation) => operation.op === "remove" ? spec : { ...spec, [operation.path.slice(1)]: operation.value }, { schema_version: "1.0.0", intent_family: "undetermined" } as typeof complete.candidate_spec & { schema_version: "1.0.0"; intent_family: "undetermined" });
  let calls = 0;
  const service = createResearchDesignService({ propose: async () => {
    calls += 1;
    return { ...ambiguousProposal(), suggestions: [{ id: "association-reference", label: "Association", explanation: "Use AKI as the exposure.", candidate_spec: candidate }] };
  } }, createInMemoryDesignSessionRepository());
  const first = await service.start({ ...startRequest, client_request_id: "suggestion-start" });
  const selected = await service.continue({ session_id: first.session_id, base_revision: first.revision, suggestion_id: "association-reference", client_request_id: "suggestion-select" });

  assert.equal(calls, 1);
  assert.equal(selected.study_spec.population?.description, "Synthetic adult admissions");
});

test("rejects a stale page without changing the current design", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  const service = createResearchDesignService(
    queuedModel(ambiguousProposal(), associationProposal()),
    sessions,
  );
  const first = await service.start(startRequest);
  await service.continue({
    session_id: first.session_id,
    base_revision: 1,
    answers: { intent: "association" },
    client_request_id: "continue-1",
  });

  await assert.rejects(
    () =>
      service.continue({
        session_id: first.session_id,
        base_revision: 1,
        message: "An answer from an old page",
        client_request_id: "continue-2",
      }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_REVISION_CONFLICT",
  );
  assert.equal((await sessions.findById(first.session_id))?.revision, 2);
});

test("reports a missing session before calling the model", async () => {
  const service = createResearchDesignService(queuedModel(), createInMemoryDesignSessionRepository());

  await assert.rejects(
    () =>
      service.continue({
        session_id: "missing",
        base_revision: 1,
        message: "Continue",
        client_request_id: "continue-1",
      }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_SESSION_NOT_FOUND",
  );
});

test("requires an answer, message, or selected suggestion", async () => {
  const service = createResearchDesignService(queuedModel(), createInMemoryDesignSessionRepository());

  await assert.rejects(
    () =>
      service.continue({
        session_id: "session-1",
        base_revision: 1,
        client_request_id: "continue-1",
      }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_INVALID_INPUT",
  );
});

test("revises a confirmed design without changing its historical confirmation", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  const revisedProposal = baseProposal({
    readiness: "candidate_ready",
    spec_patch: [{
      op: "replace",
      path: "/population/description",
      value: "Revised synthetic adult admissions",
    }],
  });
  const service = createResearchDesignService(
    queuedModel(completeAssociationProposal(), revisedProposal),
    sessions,
  );
  const first = await service.start(startRequest);
  const confirmation = await service.confirm({
    session_id: first.session_id,
    base_revision: first.revision,
    client_request_id: "confirm-before-revision",
  });

  const revised = await service.continue({
    session_id: first.session_id,
    base_revision: first.revision,
    answers: { population: "Revised synthetic adult admissions" },
    client_request_id: "revise-confirmed-design",
  });

  const stored = await sessions.findById(first.session_id);
  assert.equal(revised.revision, first.revision + 1);
  assert.equal(revised.study_spec.population?.description, "Revised synthetic adult admissions");
  assert.equal(stored?.confirmation, undefined);
  assert.deepEqual(stored?.confirmation_history?.[0]?.result, confirmation);
});
