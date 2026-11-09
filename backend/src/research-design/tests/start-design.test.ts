import assert from "node:assert/strict";
import test from "node:test";
import type { ResearchDesignProposal } from "../model-proposal.js";
import type { StudySpec } from "../study-spec.js";
import {
  createInMemoryDesignSessionRepository,
  createResearchDesignService,
  DesignError,
  ResearchDesignModelError,
} from "../index.js";
import {
  ambiguousProposal,
  baseProposal,
  completeAssociationProposal,
  modelReturning,
  queuedModel,
  startRequest,
} from "./model-fixtures.js";
import { normalizeResearchDesignProposal } from "../research-design-service.js";

const objectiveProposal = (question: string): ResearchDesignProposal => {
  const proposal = completeAssociationProposal();
  const spec = proposal.spec_patch.reduce((value, operation) => operation.op === "remove"
    ? value : { ...value, [operation.path.slice(1)]: operation.value },
  { schema_version: "1.0.0", intent_family: "undetermined" } as StudySpec);
  spec.analysis_objectives = {
    schema_version: "1.0.0", original_question: question,
    requested: [{ objective_id: "event", source_text: "Event association", outcome_structure: "binary" }],
    objectives: [{ objective_id: "event", status: "ready", outcome: spec.outcome!,
      outcome_structure: "binary", time_windows: spec.time_windows!, estimand: spec.estimand!,
      analysis_family: spec.analysis_family! }],
  };
  return { ...proposal, spec_patch: [], candidate_spec: spec };
};

test("objective opt-in supplies an empty ledger and confirms a generated objective without another model call", async () => {
  let calls = 0;
  const service = createResearchDesignService({ async propose({ current_spec }) {
    calls += 1;
    assert.deepEqual(current_spec.analysis_objectives, {
      schema_version: "1.0.0", original_question: startRequest.message, requested: [], objectives: [],
    });
    return objectiveProposal(startRequest.message);
  } }, createInMemoryDesignSessionRepository());
  const view = await service.start({ ...startRequest, study_spec_contract: "objectives-v1" });
  assert.equal(view.phase, "ready_to_confirm");
  const confirmed = await service.confirm({ session_id: view.session_id, base_revision: view.revision, client_request_id: "objective-confirm" });
  assert.equal(confirmed.spec.analysis_objectives?.objectives.length, 1);
  assert.equal(calls, 1);
});

test("objective opt-in does not silently replay a previously confirmed single-outcome design", async () => {
  let calls = 0;
  const service = createResearchDesignService({ async propose({ current_spec }) {
    calls += 1;
    return current_spec.analysis_objectives ? objectiveProposal(startRequest.message) : completeAssociationProposal();
  } }, createInMemoryDesignSessionRepository());
  const first = await service.start({ ...startRequest, client_request_id: "legacy-first" });
  await service.confirm({ session_id: first.session_id, base_revision: first.revision, client_request_id: "legacy-confirm" });
  const next = await service.start({ ...startRequest, study_spec_contract: "objectives-v1", client_request_id: "new-objective-request" });
  assert.equal(calls, 2);
  assert.equal(next.reused_design_review, undefined);
  assert.equal(next.study_spec.analysis_objectives?.objectives.length, 1);
});

test("an uncovered model-declared objective remains visible and prevents confirmation", async () => {
  const proposal = objectiveProposal(startRequest.message);
  proposal.candidate_spec!.analysis_objectives!.requested.push({ objective_id: "second", source_text: "A second independent goal" });
  const service = createResearchDesignService(modelReturning(proposal), createInMemoryDesignSessionRepository());
  const view = await service.start({ ...startRequest, study_spec_contract: "objectives-v1", client_request_id: "missing-goal" });
  assert.equal(view.phase, "needs_clarification");
  assert.equal(view.study_spec.analysis_objectives?.requested.length, 2);
  await assert.rejects(service.confirm({ session_id: view.session_id, base_revision: view.revision, client_request_id: "missing-goal-confirm" }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_NOT_READY");
});

test("normalizes equivalent intent confidence and reuses an emitted clarification prompt", () => {
  const proposal = ambiguousProposal() as unknown as Record<string, unknown>;
  const assessment = proposal.intent_assessment as Record<string, unknown>;
  assessment.confidence = "moderate";
  delete assessment.clarifying_question;

  const normalized = normalizeResearchDesignProposal(proposal) as ResearchDesignProposal;

  assert.equal(normalized.intent_assessment.confidence, "medium");
  assert.equal(normalized.intent_assessment.clarifying_question, normalized.clarifying_questions[0]?.prompt);
});

test("normalizes the model clarification_question alias without weakening strict validation", () => {
  const proposal = completeAssociationProposal() as unknown as Record<string, unknown>;
  const assessment = proposal.intent_assessment as Record<string, unknown>;
  assessment.clarification_question = assessment.clarifying_question;
  delete assessment.clarifying_question;

  const normalized = normalizeResearchDesignProposal(proposal) as ResearchDesignProposal;

  assert.equal(normalized.intent_assessment.clarifying_question, null);
  assert.equal("clarification_question" in (normalized.intent_assessment as unknown as Record<string, unknown>), false);
});

test("does not invent a missing required clarification prompt", () => {
  const proposal = ambiguousProposal() as unknown as Record<string, unknown>;
  const assessment = proposal.intent_assessment as Record<string, unknown>;
  delete assessment.clarifying_question;
  proposal.clarifying_questions = [];

  const normalized = normalizeResearchDesignProposal(proposal) as Record<string, unknown>;

  assert.equal("clarifying_question" in (normalized.intent_assessment as Record<string, unknown>), false);
});

test("canonicalizes confidence from the model clarification decision and preserves warnings with unsupported paths", () => {
  const proposal = baseProposal() as unknown as Record<string, unknown>;
  (proposal.intent_assessment as Record<string, unknown>).confidence = "very_high";
  proposal.warnings = [{ code: "DESIGN_LIMITATION", message: "A limitation remains.", field_path: "/comparison" }];

  const normalized = normalizeResearchDesignProposal(proposal) as ResearchDesignProposal;

  assert.equal(normalized.intent_assessment.confidence, "high");
  assert.deepEqual(normalized.warnings, [{ code: "DESIGN_LIMITATION", message: "A limitation remains." }]);
});

test("creates and saves a typed draft from a clear association question", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  const service = createResearchDesignService(modelReturning(baseProposal()), sessions);

  const view = await service.start(startRequest);

  assert.equal(view.phase, "drafting");
  assert.equal(view.study_spec.intent_family, "association");
  assert.deepEqual(view.allowed_actions, ["continue"]);
  assert.deepEqual((await sessions.findById(view.session_id))?.spec, view.study_spec);
});

test("reuses an exact confirmed StudySpec as a reviewable draft without another model request", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  let modelCalls = 0;
  const service = createResearchDesignService({
    async propose() { modelCalls += 1; return completeAssociationProposal(); },
  }, sessions, { now: () => new Date("2026-09-15T00:00:00.000Z") });
  const first = await service.start({ ...startRequest, client_request_id: "reusable-first" });
  await service.confirm({ session_id: first.session_id, base_revision: first.revision, client_request_id: "reusable-confirm" });

  const reused = await service.start({ ...startRequest, client_request_id: "reusable-second" });

  assert.equal(modelCalls, 1);
  assert.notEqual(reused.session_id, first.session_id);
  assert.equal(reused.phase, "ready_to_confirm");
  assert.equal(reused.confirmed, undefined);
  assert.equal(reused.study_spec.research_question, startRequest.message);
  assert.deepEqual(reused.allowed_actions, ["confirm", "revise"]);
  assert.ok(reused.reused_design_review?.source_integrity_id);
  assert.equal((await sessions.findById(reused.session_id))?.confirmation, undefined);

  const restored = await service.getSession(reused.session_id);
  assert.deepEqual(restored.reused_design_review, reused.reused_design_review);
  const reconfirmed = await service.confirm({
    session_id: reused.session_id,
    base_revision: reused.revision,
    client_request_id: "reusable-reconfirm",
  });
  assert.equal(reconfirmed.spec.research_question, startRequest.message);
  assert.equal(modelCalls, 1);
});

test("aligns a clear model assessment when its patch omits the unresolved intent", async () => {
  const proposal = baseProposal();
  proposal.spec_patch = proposal.spec_patch.filter(({ path }) => path !== "/intent_family");
  const service = createResearchDesignService(
    modelReturning(proposal),
    createInMemoryDesignSessionRepository(),
  );

  const view = await service.start({ ...startRequest, client_request_id: "omitted-intent" });

  assert.equal(view.study_spec.intent_family, "association");
});

test("rejects an invalid proposal without granting a second full model budget", async () => {
  let modelCalls = 0;
  const service = createResearchDesignService({
    async propose() { modelCalls += 1; return { unexpected: true }; },
  }, createInMemoryDesignSessionRepository());

  await assert.rejects(
    service.start({ ...startRequest, client_request_id: "proposal-shape-retry" }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_PROPOSAL_INVALID",
  );
  assert.equal(modelCalls, 1);
});

test("asks the user when the research type is ambiguous", async () => {
  const service = createResearchDesignService(
    modelReturning(ambiguousProposal()),
    createInMemoryDesignSessionRepository(),
  );

  const view = await service.start(startRequest);

  assert.equal(view.phase, "needs_clarification");
  assert.equal(view.study_spec.intent_family, "undetermined");
  assert.equal(view.clarifying_questions.length, 1);
});

test("rejects a model that selects a type before clarification", async () => {
  const invalid = ambiguousProposal();
  invalid.intent_assessment.recommended_intent = "association";
  invalid.intent_assessment.confidence = "medium";
  invalid.spec_patch = [{ op: "replace", path: "/intent_family", value: "association" }];
  const service = createResearchDesignService(
    modelReturning(invalid),
    createInMemoryDesignSessionRepository(),
  );

  await assert.rejects(
    () => service.start(startRequest),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_PROPOSAL_INVALID",
  );
});

test("marks a complete association design ready for user confirmation", async () => {
  const service = createResearchDesignService(
    modelReturning(completeAssociationProposal()),
    createInMemoryDesignSessionRepository(),
  );

  const view = await service.start(startRequest);

  assert.equal(view.phase, "ready_to_confirm");
  assert.deepEqual(view.allowed_actions, ["continue", "confirm"]);
});

test("accepts a complete candidate spec without applying model-authored JSON Patch", async () => {
  const proposal = completeAssociationProposal();
  const service = createResearchDesignService(modelReturning({
    ...proposal,
    candidate_spec: proposal.spec_patch.reduce((spec, operation) => {
      if (operation.op === "remove") return spec;
      const key = operation.path.slice(1) as keyof typeof spec;
      return { ...spec, [key]: operation.value };
    }, { schema_version: "1.0.0", intent_family: "undetermined" } as StudySpec),
    spec_patch: [],
  }), createInMemoryDesignSessionRepository());
  const view = await service.start(startRequest);
  assert.equal(view.phase, "ready_to_confirm");
  assert.equal(view.study_spec.index_time?.event, "Admission");
});

test("provides the exact researcher question as immutable context on the first model turn", async () => {
  let receivedQuestion: string | undefined;
  let templateIds: string[] = [];
  const service = createResearchDesignService({
    propose: async ({ current_spec, template_context }) => {
      receivedQuestion = current_spec.research_question;
      assert.ok(template_context);
      templateIds = template_context.templates.map(({ template_id }) => template_id);
      return completeAssociationProposal();
    },
  }, createInMemoryDesignSessionRepository());

  const view = await service.start({ ...startRequest, client_request_id: "preserved-original-question" });
  assert.equal(receivedQuestion, startRequest.message);
  assert.deepEqual(templateIds, ["association.v1", "prediction.v1", "treatment-effect.v1"]);
  assert.equal(view.study_spec.research_question, startRequest.message);
});

test("resolves an explicit versioned template before calling the model", async () => {
  let received: unknown;
  const service = createResearchDesignService({
    propose: async (input) => {
      received = input;
      return completeAssociationProposal();
    },
  }, createInMemoryDesignSessionRepository());

  await service.start({
    ...startRequest,
    template_id: "association.v1",
    client_request_id: "explicit-association-template",
  });

  assert.deepEqual(
    (received as { template_context?: unknown }).template_context,
    {
      selected_template_id: "association.v1",
      templates: [{
        template_id: "association.v1",
        version: "1.0.0",
        intent_family: "association",
        purpose: "Estimate a relationship between an exposure or characteristic and an outcome without making an individual prediction or causal treatment claim.",
        required_slots: ["population", "index_time", "exposure", "exposure_window", "aggregation", "contrast", "outcome", "outcome_window", "covariates", "estimand"],
        constraints: [
          "Preserve association language unless the researcher explicitly asks for prediction or a causal treatment effect.",
          "Define exposure timing before the outcome and keep the summary measure non-causal.",
        ],
      }],
    },
  );
});

test("rejects an unknown template before calling the model", async () => {
  let modelCalls = 0;
  const service = createResearchDesignService({
    propose: async () => {
      modelCalls += 1;
      return completeAssociationProposal();
    },
  }, createInMemoryDesignSessionRepository());

  await assert.rejects(
    () => service.start({
      ...startRequest,
      template_id: "unknown.v1",
      client_request_id: "unknown-template",
    }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_INVALID_INPUT",
  );
  assert.equal(modelCalls, 0);
});

test("rejects a proposal that changes an explicitly selected template intent", async () => {
  const proposal = completeAssociationProposal();
  proposal.intent_assessment.recommended_intent = "prediction";
  proposal.spec_patch = proposal.spec_patch.map((operation) =>
    operation.path === "/intent_family" && operation.op !== "remove"
      ? { ...operation, value: "prediction" }
      : operation);
  const service = createResearchDesignService(
    modelReturning(proposal),
    createInMemoryDesignSessionRepository(),
  );

  await assert.rejects(
    () => service.start({
      ...startRequest,
      template_id: "association.v1",
      client_request_id: "template-intent-mismatch",
    }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_PROPOSAL_INVALID",
  );
});

test("normalizes exactly convertible fractional candidate windows", async () => {
  const proposal = completeAssociationProposal();
  const candidate = proposal.spec_patch.reduce((spec, operation) => operation.op === "remove" ? spec : { ...spec, [operation.path.slice(1)]: operation.value }, { schema_version: "1.0.0", intent_family: "undetermined" } as StudySpec);
  candidate.time_windows = [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 0.5, unit: "day" }];
  const service = createResearchDesignService(modelReturning({ ...proposal, candidate_spec: candidate, spec_patch: [] }), createInMemoryDesignSessionRepository());
  const view = await service.start({ ...startRequest, client_request_id: "fractional-window" });
  assert.deepEqual(view.study_spec.time_windows, [{ purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: 12, unit: "hour" }]);
});

test("normalizes common aggregation vocabulary at the model boundary", async () => {
  const proposal = completeAssociationProposal();
  const candidate = proposal.spec_patch.reduce((spec, operation) => operation.op === "remove" ? spec : { ...spec, [operation.path.slice(1)]: operation.value }, { schema_version: "1.0.0", intent_family: "undetermined" } as StudySpec);
  candidate.exposure_or_predictors![0]!.aggregation = "max" as never;
  const service = createResearchDesignService(modelReturning({ ...proposal, candidate_spec: candidate, spec_patch: [] }), createInMemoryDesignSessionRepository());
  const view = await service.start({ ...startRequest, client_request_id: "aggregation-normalization" });
  assert.equal(view.study_spec.exposure_or_predictors?.[0]?.aggregation, "maximum");
});

test("turns an incomplete candidate-ready proposal into explicit protocol clarification", async () => {
  const proposal = completeAssociationProposal();
  proposal.spec_patch = proposal.spec_patch.filter(({ path }) => path !== "/outcome_structure");
  const service = createResearchDesignService(
    modelReturning(proposal),
    createInMemoryDesignSessionRepository(),
  );
  const view = await service.start({ ...startRequest, client_request_id: "missing-outcome-structure" });
  assert.equal(view.phase, "needs_clarification");
  assert.deepEqual(view.allowed_actions, ["continue"]);
  assert.ok(view.clarifying_questions.some(({ id }) => id === "protocol-outcome_structure_required"));
});

test("rejects model changes outside the StudySpec allowlist", async () => {
  const invalid = baseProposal({ spec_patch: [{ op: "add", path: "/sql", value: "select *" }] });
  const service = createResearchDesignService(
    modelReturning(invalid),
    createInMemoryDesignSessionRepository(),
  );

  await assert.rejects(
    () => service.start(startRequest),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_PROPOSAL_INVALID",
  );
});

test("preserves a safe model failure class without exposing provider internals", async () => {
  const service = createResearchDesignService({ propose: async () => { throw new ResearchDesignModelError("MODEL_TIMEOUT"); } }, createInMemoryDesignSessionRepository());
  await assert.rejects(() => service.start({ ...startRequest, client_request_id: "model-timeout" }), (error: unknown) => error instanceof DesignError
    && error.code === "DESIGN_MODEL_TIMEOUT"
    && error.details[0] === "failure_class=MODEL_TIMEOUT"
    && !JSON.stringify(error).includes("http"));
});

test("surfaces request-scoped fallback authorization without saving a design", async () => {
  const repository = createInMemoryDesignSessionRepository();
  const service = createResearchDesignService({ propose: async () => { throw new ResearchDesignModelError("MODEL_FALLBACK_AUTHORIZATION_REQUIRED"); } }, repository);
  await assert.rejects(
    () => service.start({ ...startRequest, client_request_id: "fallback-authorization" }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_MODEL_FALLBACK_AUTHORIZATION_REQUIRED",
  );
  assert.equal(await repository.findProcessedRequest("fallback-authorization"), undefined);
});
