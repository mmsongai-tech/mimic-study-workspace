import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { executeCrudeLactateAssociation } from "../../association-analysis/engines/crude-binary-association.js";
import { completeAssociationProposal } from "../../research-design/tests/model-fixtures.js";
import { createConfirmedStudySpecIntegrityId } from "../../research-design/confirmed-study-spec-integrity.js";
import { RunEvidenceService } from "../index.js";

test("serialized run evidence satisfies the public execution contract", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../../../../contracts/research-execution/run-evidence.schema.json",
    import.meta.url,
  ), "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true, formats: { "date-time": true } });
  const validate = ajv.compile(schema);
  const spec = completeAssociationProposal().spec_patch.reduce((current, operation) => {
    const key = operation.path.slice(1);
    if (operation.op === "add" || operation.op === "replace") return { ...current, [key]: operation.value };
    return current;
  }, { schema_version: "1.0.0", intent_family: "undetermined" } as Record<string, unknown>) as never;
  const confirmed = {
    schema_version: "1.0.0" as const,
    session_id: "contract-session",
    revision: 1,
    confirmed_at: "2026-08-31T12:00:00.000Z",
    spec,
    integrity_id: createConfirmedStudySpecIntegrityId("contract-session", 1, spec),
  };
  const preflight = {
    status: "supported" as const,
    evidence_class: "catalog_match" as const,
    confirmed_study_integrity_id: confirmed.integrity_id,
    capability_id: "association.lactate.in_hospital_mortality.v1" as const,
    data_source: {
      id: "contract-fixture",
      version: "1.0.0",
      data_mode: "synthetic" as const,
      available_concepts: ["icu_admission_time", "lactate_measurement", "hospital_discharge_status"],
    },
    missing_requirements: [],
    warnings: [],
  };
  const analysis = executeCrudeLactateAssociation({
    records: [
      { synthetic_subject_id: "A", max_lactate_first_6h: 3, in_hospital_death: true },
      { synthetic_subject_id: "B", max_lactate_first_6h: 3, in_hospital_death: false },
      { synthetic_subject_id: "C", max_lactate_first_6h: 1, in_hospital_death: false },
      { synthetic_subject_id: "D", max_lactate_first_6h: 1, in_hospital_death: true }
    ],
    provenance: { data_source_id: "contract-fixture", data_source_version: "1.0.0", data_mode: "synthetic", retrieved_at: "2026-08-31T12:00:00.000Z" },
  }, confirmed.integrity_id, 2);
  const bundle = new RunEvidenceService({
    now: () => new Date("2026-08-31T12:00:00.000Z"),
    createRunId: () => "contract-run",
  }).create({ study: confirmed, preflight, analysis });
  assert.equal(validate(bundle), true, JSON.stringify(validate.errors));
  assert.equal(bundle.artifact.statistical_review?.interpretation_status, "blocked");
  assert.match(bundle.report_markdown, /Primary interpretation is blocked/iu);
});
