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
  startRequest,
} from "./model-fixtures.js";

test("replays start without calling the model or creating another session", async () => {
  let modelCalls = 0;
  const service = createResearchDesignService({
    async propose() {
      modelCalls += 1;
      return baseProposal();
    },
  }, createInMemoryDesignSessionRepository());

  const first = await service.start(startRequest);
  const replay = await service.start(startRequest);

  assert.equal(modelCalls, 1);
  assert.deepEqual(replay, first);
});

test("rejects a reused start request identifier with different content", async () => {
  let modelCalls = 0;
  const service = createResearchDesignService({
    async propose() {
      modelCalls += 1;
      return baseProposal();
    },
  }, createInMemoryDesignSessionRepository());
  await service.start(startRequest);

  await assert.rejects(
    () => service.start({ ...startRequest, message: "A different research question" }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(modelCalls, 1);
});

test("replays continue without calling the model or incrementing the revision", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  let modelCalls = 0;
  const service = createResearchDesignService({
    async propose() {
      modelCalls += 1;
      return modelCalls === 1 ? ambiguousProposal() : associationProposal();
    },
  }, sessions);
  const first = await service.start(startRequest);
  const request = {
    session_id: first.session_id,
    base_revision: first.revision,
    answers: { intent: "association" },
    client_request_id: "continue-idempotent",
  };

  const second = await service.continue(request);
  const replay = await service.continue(request);

  assert.equal(modelCalls, 2);
  assert.deepEqual(replay, second);
  assert.equal((await sessions.findById(first.session_id))?.revision, 2);
});

test("rejects a reused continue identifier with different content", async () => {
  let modelCalls = 0;
  const service = createResearchDesignService({
    async propose() {
      modelCalls += 1;
      return modelCalls === 1 ? ambiguousProposal() : associationProposal();
    },
  }, createInMemoryDesignSessionRepository());
  const first = await service.start(startRequest);
  await service.continue({
    session_id: first.session_id,
    base_revision: first.revision,
    message: "Association",
    client_request_id: "continue-reused",
  });

  await assert.rejects(
    () => service.continue({
      session_id: first.session_id,
      base_revision: first.revision,
      message: "Treatment effect",
      client_request_id: "continue-reused",
    }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(modelCalls, 2);
});

test("rejects reuse of a request identifier across operations", async () => {
  const service = createResearchDesignService({
    async propose() {
      return ambiguousProposal();
    },
  }, createInMemoryDesignSessionRepository());
  const first = await service.start(startRequest);

  await assert.rejects(
    () => service.continue({
      session_id: first.session_id,
      base_revision: first.revision,
      message: "Association",
      client_request_id: startRequest.client_request_id,
    }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_IDEMPOTENCY_CONFLICT",
  );
});

test("releases a request claim after model failure so the same request can retry", async () => {
  let modelCalls = 0;
  const service = createResearchDesignService({
    async propose() {
      modelCalls += 1;
      if (modelCalls === 1) throw new Error("transient model failure");
      return baseProposal();
    },
  }, createInMemoryDesignSessionRepository());

  await assert.rejects(
    () => service.start(startRequest),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_MODEL_UNAVAILABLE",
  );
  const retried = await service.start(startRequest);

  assert.equal(modelCalls, 2);
  assert.equal(retried.revision, 1);
});

test("concurrent duplicate starts call the model once and report the in-progress request", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  let modelCalls = 0;
  const service = createResearchDesignService({
    async propose() {
      modelCalls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return baseProposal();
    },
  }, sessions);

  const results = await Promise.allSettled([service.start(startRequest), service.start(startRequest)]);
  const fulfilled = results.find((result) => result.status === "fulfilled");
  const rejected = results.find((result) => result.status === "rejected");

  assert.equal(modelCalls, 1);
  assert.equal(fulfilled?.status, "fulfilled");
  assert.equal(
    rejected?.status === "rejected" &&
      rejected.reason instanceof DesignError &&
      rejected.reason.code === "DESIGN_REQUEST_IN_PROGRESS",
    true,
  );
  if (fulfilled?.status === "fulfilled") {
    assert.deepEqual(
      (await sessions.findById(fulfilled.value.session_id))?.spec,
      fulfilled.value.study_spec,
    );
  }
});

test("concurrent duplicate continues call the model once and create one new revision", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  let modelCalls = 0;
  const service = createResearchDesignService({
    async propose() {
      modelCalls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return modelCalls === 1 ? ambiguousProposal() : associationProposal();
    },
  }, sessions);
  const first = await service.start(startRequest);
  const request = {
    session_id: first.session_id,
    base_revision: first.revision,
    answers: { intent: "association" },
    client_request_id: "continue-concurrent",
  };

  const results = await Promise.allSettled([service.continue(request), service.continue(request)]);
  const fulfilled = results.find((result) => result.status === "fulfilled");
  const rejected = results.find((result) => result.status === "rejected");

  assert.equal(modelCalls, 2);
  assert.equal(fulfilled?.status === "fulfilled" && fulfilled.value.revision, 2);
  assert.equal(
    rejected?.status === "rejected" &&
      rejected.reason instanceof DesignError &&
      rejected.reason.code === "DESIGN_REQUEST_IN_PROGRESS",
    true,
  );
  assert.equal((await sessions.findById(first.session_id))?.revisions.length, 2);
});
