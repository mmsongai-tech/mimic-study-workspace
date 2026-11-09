import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmedStudySpec } from "../../research-design/index.js";
import type { PreflightResult } from "../../research-feasibility/index.js";
import {
  AssociationAnalysisError,
  AssociationAnalysisService,
  SyntheticLactateMortalityGateway,
} from "../index.js";

const study = {
  schema_version: "1.0.0",
  session_id: "synthetic-session",
  revision: 1,
  confirmed_at: "2026-08-31T08:00:00.000Z",
  integrity_id: "sha256:synthetic-study",
  spec: {
    schema_version: "1.0.0",
    intent_family: "association",
    analysis_family: "association",
  },
} as ConfirmedStudySpec;

const preflight: PreflightResult = {
  status: "supported",
  confirmed_study_integrity_id: study.integrity_id,
  capability_id: "association.lactate.in_hospital_mortality.v1",
  data_source: { id: "synthetic", version: "1.0.0", data_mode: "synthetic" },
  missing_requirements: [],
  warnings: [],
  evidence_class: "catalog_match",
};

test("executes deterministic crude lactate association statistics", async () => {
  const result = await new AssociationAnalysisService(
    new SyntheticLactateMortalityGateway(),
  ).execute({ study, preflight, threshold_mmol_l: 2 });

  assert.deepEqual(result.counts, {
    total: 6,
    exposed: 3,
    unexposed: 3,
    exposed_events: 2,
    unexposed_events: 1,
  });
  assert.equal(result.estimates.exposed_risk, 2 / 3);
  assert.equal(result.estimates.unexposed_risk, 1 / 3);
  assert.equal(result.estimates.risk_difference, 1 / 3);
  assert.equal(result.estimates.odds_ratio, 4);
  assert.equal(result.provenance.data_mode, "synthetic");
});

test("rejects execution without a matching supported preflight", async () => {
  const service = new AssociationAnalysisService(new SyntheticLactateMortalityGateway());

  await assert.rejects(
    () => service.execute({
      study,
      preflight: { ...preflight, confirmed_study_integrity_id: "sha256:other" },
      threshold_mmol_l: 2,
    }),
    (error: unknown) =>
      error instanceof AssociationAnalysisError && error.code === "ANALYSIS_UNSUPPORTED",
  );
});

test("normalizes gateway failures", async () => {
  const service = new AssociationAnalysisService({ async load() { throw new Error("private path"); } });

  await assert.rejects(
    () => service.execute({ study, preflight, threshold_mmol_l: 2 }),
    (error: unknown) =>
      error instanceof AssociationAnalysisError &&
      error.code === "ANALYSIS_DATA_UNAVAILABLE" &&
      !error.message.includes("private"),
  );
});
