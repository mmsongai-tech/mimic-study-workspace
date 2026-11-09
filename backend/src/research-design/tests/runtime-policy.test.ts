import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryDesignSessionRepository,
  createResearchDesignService,
  DesignError,
} from "../index.js";
import { ambiguousProposal, associationProposal, baseProposal, queuedModel, startRequest } from "./model-fixtures.js";

test("enforces configured request size before calling the model", async () => {
  let modelCalls = 0;
  const service = createResearchDesignService({
    async propose() { modelCalls += 1; return baseProposal(); },
  }, createInMemoryDesignSessionRepository(), { policy: { maxRequestChars: 5 } });

  await assert.rejects(
    () => service.start(startRequest),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_LIMIT_EXCEEDED",
  );
  assert.equal(modelCalls, 0);
});

test("enforces configured revision retention before calling the model", async () => {
  const service = createResearchDesignService(
    queuedModel(ambiguousProposal(), associationProposal()),
    createInMemoryDesignSessionRepository(),
    { policy: { maxRevisions: 1 } },
  );
  const first = await service.start(startRequest);

  await assert.rejects(
    () => service.continue({
      session_id: first.session_id,
      base_revision: first.revision,
      message: "Association",
      client_request_id: "retention-continue",
    }),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_LIMIT_EXCEEDED",
  );
});

test("enforces configured patch-operation limits", async () => {
  const service = createResearchDesignService(
    queuedModel(baseProposal()),
    createInMemoryDesignSessionRepository(),
    { policy: { maxPatchOperations: 1 } },
  );

  await assert.rejects(
    () => service.start(startRequest),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_LIMIT_EXCEEDED",
  );
});

test("rejects a runtime that does not support the active StudySpec version", async () => {
  const service = createResearchDesignService(
    queuedModel(baseProposal()),
    createInMemoryDesignSessionRepository(),
    { policy: { supportedStudySpecVersions: ["2.0.0"] } },
  );

  await assert.rejects(
    () => service.start(startRequest),
    (error: unknown) => error instanceof DesignError && error.code === "DESIGN_INVALID_INPUT",
  );
});
