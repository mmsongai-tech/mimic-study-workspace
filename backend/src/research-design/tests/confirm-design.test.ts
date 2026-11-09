import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryDesignSessionRepository,
  createResearchDesignService,
  DesignError,
} from "../index.js";
import {
  baseProposal,
  completeAssociationProposal,
  modelReturning,
  startRequest,
} from "./model-fixtures.js";

const fixedNow = () => new Date("2026-08-31T08:00:00.000Z");

test("confirms the exact ready revision without another model call", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  let modelCalls = 0;
  const service = createResearchDesignService(
    {
      async propose() {
        modelCalls += 1;
        return completeAssociationProposal();
      },
    },
    sessions,
    { now: fixedNow },
  );
  const view = await service.start(startRequest);

  const confirmed = await service.confirm({
    session_id: view.session_id,
    base_revision: view.revision,
    client_request_id: "confirm-1",
  });

  assert.equal(modelCalls, 1);
  assert.equal(confirmed.confirmed_at, "2026-08-31T08:00:00.000Z");
  assert.match(confirmed.integrity_id, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await sessions.findById(view.session_id))?.phase, "confirmed");
});

test("replays the original confirmation for the same request identifier", async () => {
  const service = createResearchDesignService(
    modelReturning(completeAssociationProposal()),
    createInMemoryDesignSessionRepository(),
    { now: fixedNow },
  );
  const view = await service.start(startRequest);
  const request = {
    session_id: view.session_id,
    base_revision: view.revision,
    client_request_id: "confirm-1",
  };

  const first = await service.confirm(request);
  const replay = await service.confirm(request);

  assert.deepEqual(replay, first);
});

test("rejects reuse of a confirmation request identifier with another payload", async () => {
  const service = createResearchDesignService(
    modelReturning(completeAssociationProposal()),
    createInMemoryDesignSessionRepository(),
    { now: fixedNow },
  );
  const view = await service.start(startRequest);
  await service.confirm({
    session_id: view.session_id,
    base_revision: view.revision,
    client_request_id: "confirm-reused",
  });

  await assert.rejects(
    () => service.confirm({
      session_id: view.session_id,
      base_revision: view.revision + 1,
      client_request_id: "confirm-reused",
    }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_IDEMPOTENCY_CONFLICT",
  );
});

test("rejects a competing confirmation and preserves the stored result", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  const service = createResearchDesignService(
    modelReturning(completeAssociationProposal()),
    sessions,
    { now: fixedNow },
  );
  const view = await service.start(startRequest);
  const first = await service.confirm({
    session_id: view.session_id,
    base_revision: view.revision,
    client_request_id: "confirm-1",
  });

  await assert.rejects(
    () => service.confirm({
      session_id: view.session_id,
      base_revision: view.revision,
      client_request_id: "confirm-2",
    }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_REVISION_CONFLICT",
  );
  assert.deepEqual((await sessions.findById(view.session_id))?.confirmation?.result, first);
});

test("stores only one result when confirmations race", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  const service = createResearchDesignService(
    modelReturning(completeAssociationProposal()),
    sessions,
    { now: fixedNow },
  );
  const view = await service.start(startRequest);

  const results = await Promise.allSettled([
    service.confirm({
      session_id: view.session_id,
      base_revision: view.revision,
      client_request_id: "confirm-race-1",
    }),
    service.confirm({
      session_id: view.session_id,
      base_revision: view.revision,
      client_request_id: "confirm-race-2",
    }),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.equal((await sessions.findById(view.session_id))?.confirmation !== undefined, true);
});

test("does not confirm a draft or a stale revision", async () => {
  const service = createResearchDesignService(
    modelReturning(baseProposal()),
    createInMemoryDesignSessionRepository(),
    { now: fixedNow },
  );
  const view = await service.start(startRequest);

  await assert.rejects(
    () => service.confirm({
      session_id: view.session_id,
      base_revision: view.revision,
      client_request_id: "confirm-draft",
    }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_NOT_READY",
  );
  await assert.rejects(
    () => service.confirm({
      session_id: view.session_id,
      base_revision: view.revision + 1,
      client_request_id: "confirm-stale",
    }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_REVISION_CONFLICT",
  );
});

test("normalizes confirmation storage failures", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  const failingSessions = {
    claimRequest: sessions.claimRequest.bind(sessions),
    releaseRequest: sessions.releaseRequest.bind(sessions),
    create: sessions.create.bind(sessions),
    saveRevision: sessions.saveRevision.bind(sessions),
    findById: sessions.findById.bind(sessions),
    findProcessedRequest: sessions.findProcessedRequest.bind(sessions),
    async confirm() {
      throw new Error("private storage failure");
    },
  };
  const service = createResearchDesignService(
    modelReturning(completeAssociationProposal()),
    failingSessions,
    { now: fixedNow },
  );
  const view = await service.start(startRequest);

  await assert.rejects(
    () => service.confirm({
      session_id: view.session_id,
      base_revision: view.revision,
      client_request_id: "confirm-storage-failure",
    }),
    (error: unknown) =>
      error instanceof DesignError &&
      error.code === "DESIGN_STORAGE_FAILURE" &&
      !error.message.includes("private"),
  );
});

test("keeps immutable revision history while continuing a design", async () => {
  const sessions = createInMemoryDesignSessionRepository();
  const firstProposal = baseProposal();
  const secondProposal = baseProposal({
    spec_patch: [{ op: "add", path: "/title", value: "A revised title" }],
  });
  const outputs = [firstProposal, secondProposal];
  const service = createResearchDesignService({
    async propose() {
      return outputs.shift();
    },
  }, sessions, { now: fixedNow });
  const first = await service.start(startRequest);
  await service.continue({
    session_id: first.session_id,
    base_revision: first.revision,
    message: "Add a title",
    client_request_id: "continue-history",
  });

  const stored = await sessions.findById(first.session_id);
  assert.equal(stored?.revisions.length, 2);
  assert.equal(stored?.revisions[0]?.spec.title, undefined);
  assert.equal(stored?.revisions[1]?.spec.title, "A revised title");
});
