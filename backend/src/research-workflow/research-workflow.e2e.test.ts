import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AssociationAnalysisService,
  SyntheticLactateMortalityGateway,
} from "../association-analysis/index.js";
import {
  createInMemoryDesignSessionRepository,
  createResearchDesignService,
} from "../research-design/index.js";
import {
  completeAssociationProposal,
  modelReturning,
  startRequest,
} from "../research-design/tests/model-fixtures.js";
import { createInitialResearchPreflightService } from "../research-feasibility/index.js";
import {
  InMemoryRunEvidenceRepository,
  RunEvidenceService,
  SqliteRunEvidenceRepository,
} from "../run-evidence/index.js";
import { ResearchWorkflowService } from "./research-workflow-service.js";

test("runs the synthetic Research Design to report workflow end to end", async () => {
  const proposal = completeAssociationProposal();
  proposal.spec_patch = proposal.spec_patch.map((operation) => {
    if (operation.path === "/title") return { ...operation, value: "Lactate and in-hospital mortality" };
    if (operation.path === "/exposure_or_predictors") return {
      ...operation,
      value: [{
        name: "Lactate",
        role: "exposure",
        operational_definition: "Maximum lactate in the first six hours",
        definition: { condition_id: "exposure.lactate", source_text: "Lactate", kind: "concept", concept: "blood lactate", assertion: "present" },
      }],
    };
    if (operation.path === "/outcome") return {
      ...operation,
      value: {
        name: "In-hospital mortality",
        role: "outcome",
        operational_definition: "Death before hospital discharge",
        definition: { condition_id: "outcome.mortality", source_text: "In-hospital mortality", kind: "event_exists", concept: "in-hospital mortality", occurrence: "present" },
      },
    };
    return operation;
  });
  const design = createResearchDesignService(
    modelReturning(proposal),
    createInMemoryDesignSessionRepository(),
    { now: () => new Date("2026-08-31T08:00:00.000Z") },
  );
  const view = await design.start({ ...startRequest, client_request_id: "e2e-start" });
  const study = await design.confirm({
    session_id: view.session_id,
    base_revision: view.revision,
    client_request_id: "e2e-confirm",
  });
  const workflow = new ResearchWorkflowService({
    preflight: createInitialResearchPreflightService(),
    analysis: new AssociationAnalysisService(new SyntheticLactateMortalityGateway()),
    evidence: new RunEvidenceService({
      now: () => new Date("2026-08-31T09:00:00.000Z"),
      createRunId: () => "synthetic-run-001",
    }),
    runs: new InMemoryRunEvidenceRepository(),
  });

  const result = await workflow.execute({
    study,
    threshold_mmol_l: 2,
    data_source: {
      id: "synthetic-lactate-mortality-fixture",
      version: "1.0.0",
      data_mode: "synthetic",
      available_concepts: [
        "icu_admission_time",
        "lactate_measurement",
        "hospital_discharge_status",
      ],
    },
  });

  assert.equal(result.artifact.evidence_level, "synthetic_execution");
  assert.equal(result.artifact.analysis.counts.total, 6);
  assert.equal(result.artifact.analysis.capability_id, "association.lactate.in_hospital_mortality.v1");
  if (result.artifact.analysis.capability_id !== "association.lactate.in_hospital_mortality.v1") assert.fail("Expected association analysis.");
  assert.equal(result.artifact.analysis.estimates.odds_ratio, 4);
  assert.match(result.artifact.integrity_id, /^sha256:[a-f0-9]{64}$/u);
  assert.match(result.report_markdown, /Synthetic fixture result/u);
  assert.doesNotMatch(result.report_markdown, /SYN-00/u);

  const directory = await mkdtemp(join(tmpdir(), "mimic-run-evidence-"));
  const filename = join(directory, "runs.sqlite");
  try {
    const firstRepository = new SqliteRunEvidenceRepository(filename);
    assert.equal(await firstRepository.save(result), true);
    assert.equal(await firstRepository.save(result), false);
    firstRepository.close();
    const reopened = new SqliteRunEvidenceRepository(filename);
    assert.deepEqual(await reopened.findByRunId(result.artifact.run_id), result);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
