import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RAssociationStatisticalExecutor } from "../runtimes/r/r-association-statistical-executor.js";
import { PublicationSyntheticLactateMortalityGateway } from "../gateways/publication-synthetic-lactate-mortality-gateway.js";

const scriptPath = fileURLToPath(new URL("../runtimes/r/crude_binary_association.R", import.meta.url));

test("executes the registered association in R and emits an aggregate SVG", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mimic-r-test-"));
  try {
    const executor = new RAssociationStatisticalExecutor({
      rscript_binary: "Rscript",
      script_path: scriptPath,
      temporary_root: temporaryRoot,
      timeout_ms: 10_000,
    });
    const result = await executor.execute({
      records: [
        { synthetic_subject_id: "S1", max_lactate_first_6h: 4.0, in_hospital_death: true },
        { synthetic_subject_id: "S2", max_lactate_first_6h: 3.0, in_hospital_death: true },
        { synthetic_subject_id: "S3", max_lactate_first_6h: 2.5, in_hospital_death: false },
        { synthetic_subject_id: "S4", max_lactate_first_6h: 2.0, in_hospital_death: true },
        { synthetic_subject_id: "S5", max_lactate_first_6h: 1.5, in_hospital_death: false },
        { synthetic_subject_id: "S6", max_lactate_first_6h: 1.0, in_hospital_death: false },
      ],
      provenance: {
        data_source_id: "synthetic-lactate-mortality-fixture",
        data_source_version: "1.0.0",
        data_mode: "synthetic",
        retrieved_at: "2026-08-31T00:00:00.000Z",
      },
    }, "sha256:study", 2);

    assert.equal(result.counts.total, 6);
    assert.equal(result.estimates.risk_difference, 1 / 3);
    assert.equal(result.estimates.odds_ratio, 4);
    assert.equal(result.runtime?.language, "r");
    assert.match(result.runtime?.version ?? "", /^4\./u);
    assert.match(result.publication_outputs?.figures[0]?.content ?? "", /<svg/u);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("produces Table 1, missingness diagnostics, and an adjusted sensitivity model", async () => {
  const executor = new RAssociationStatisticalExecutor({
    rscript_binary: "Rscript",
    script_path: scriptPath,
    timeout_ms: 10_000,
  });
  const input = await new PublicationSyntheticLactateMortalityGateway().load();
  const result = await executor.execute(input, "sha256:publication-study", 2);

  assert.equal(result.counts.total, 1_000);
  assert.equal(result.diagnostics?.complete_cases, 1_000);
  assert.equal(result.diagnostics?.missing_records, 0);
  assert.equal(result.diagnostics?.adjusted_model_status, "completed");
  assert.ok(Number.isFinite(result.adjusted_estimates?.exposure_odds_ratio));
  assert.deepEqual(result.adjusted_estimates?.covariates, ["age_years", "sex"]);
  assert.equal(result.diagnostics?.model_converged, true);
  assert.ok((result.diagnostics?.maximum_vif ?? 0) > 0);
  assert.equal(result.sensitivity_analyses?.threshold_results.length, 3);
  assert.ok(Number.isFinite(result.sensitivity_analyses?.continuous_lactate?.odds_ratio_per_mmol_l));
  assert.equal(result.publication_outputs?.figures.length, 2);
  const table = result.publication_outputs?.tables?.find((item) => item.id === "table_1");
  assert.equal(table?.rows.length, 5);
  assert.deepEqual(table?.columns, ["Characteristic", "Overall", "Exposed", "Unexposed"]);
});
