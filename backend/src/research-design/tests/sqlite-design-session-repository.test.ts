import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createResearchDesignService,
  createSqliteDesignSessionRepository,
} from "../index.js";
import {
  ambiguousProposal,
  associationProposal,
  completeAssociationProposal,
  modelReturning,
  startRequest,
} from "./model-fixtures.js";

const withDatabase = async (run: (filename: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "mimic-research-design-"));
  try {
    await run(join(directory, "sessions.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("persists sessions, revisions, and completed request replay across restart", async () => {
  await withDatabase(async (filename) => {
    let firstModelCalls = 0;
    const firstRepository = createSqliteDesignSessionRepository(filename);
    const firstService = createResearchDesignService({
      async propose() {
        firstModelCalls += 1;
        return ambiguousProposal();
      },
    }, firstRepository);
    const first = await firstService.start(startRequest);
    firstRepository.close();

    let secondModelCalls = 0;
    const secondRepository = createSqliteDesignSessionRepository(filename);
    const secondService = createResearchDesignService({
      async propose() {
        secondModelCalls += 1;
        return associationProposal();
      },
    }, secondRepository);
    const replay = await secondService.start(startRequest);
    const continued = await secondService.continue({
      session_id: first.session_id,
      base_revision: first.revision,
      answers: { intent: "association" },
      client_request_id: "sqlite-continue",
    });

    assert.deepEqual(replay, first);
    assert.equal(firstModelCalls, 1);
    assert.equal(secondModelCalls, 1);
    assert.equal(continued.revision, 2);
    secondRepository.close();

    const thirdRepository = createSqliteDesignSessionRepository(filename);
    assert.equal((await thirdRepository.findById(first.session_id))?.revisions.length, 2);
    thirdRepository.close();
  });
});

test("persists confirmation and its idempotent result across restart", async () => {
  await withDatabase(async (filename) => {
    const firstRepository = createSqliteDesignSessionRepository(filename);
    const firstService = createResearchDesignService(
      modelReturning(completeAssociationProposal()),
      firstRepository,
      { now: () => new Date("2026-08-31T08:00:00.000Z") },
    );
    const view = await firstService.start({ ...startRequest, client_request_id: "sqlite-start-confirm" });
    const request = {
      session_id: view.session_id,
      base_revision: view.revision,
      client_request_id: "sqlite-confirm",
    };
    const confirmed = await firstService.confirm(request);
    firstRepository.close();

    const secondRepository = createSqliteDesignSessionRepository(filename);
    const secondService = createResearchDesignService(
      modelReturning(new Error("model must not be called")),
      secondRepository,
    );
    const replay = await secondService.confirm(request);

    assert.deepEqual(replay, confirmed);
    assert.equal((await secondRepository.findById(view.session_id))?.phase, "confirmed");
    secondRepository.close();
  });
});

test("persists active claims and replaces expired claims", async () => {
  await withDatabase(async (filename) => {
    const firstRepository = createSqliteDesignSessionRepository(filename);
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal(await firstRepository.claimRequest({
      request_id: "durable-claim",
      operation: "start",
      request_fingerprint: "fingerprint",
      claim_token: "token-1",
      expires_at: future,
    }), "acquired");
    firstRepository.close();

    const secondRepository = createSqliteDesignSessionRepository(filename);
    assert.equal(await secondRepository.claimRequest({
      request_id: "durable-claim",
      operation: "start",
      request_fingerprint: "fingerprint",
      claim_token: "token-2",
      expires_at: future,
    }), "pending");
    await secondRepository.releaseRequest("durable-claim", "token-1");
    assert.equal(await secondRepository.claimRequest({
      request_id: "expired-claim",
      operation: "start",
      request_fingerprint: "old",
      claim_token: "old-token",
      expires_at: new Date(0).toISOString(),
    }), "acquired");
    assert.equal(await secondRepository.claimRequest({
      request_id: "expired-claim",
      operation: "continue",
      request_fingerprint: "new",
      claim_token: "new-token",
      expires_at: future,
    }), "acquired");
    secondRepository.close();
  });
});
