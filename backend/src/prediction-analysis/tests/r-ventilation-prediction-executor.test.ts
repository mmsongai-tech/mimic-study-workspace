import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PublicationSyntheticVentilationGateway } from "../gateways/publication-synthetic-ventilation-gateway.js";
import { RVentilationPredictionExecutor } from "../runtimes/r/r-ventilation-prediction-executor.js";

const assertClose = (actual: number, expected: number, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};

test("runs 1,000-record ventilation prediction with internal validation", async () => {
  const input = await new PublicationSyntheticVentilationGateway().load();
  const result = await new RVentilationPredictionExecutor({ rscript_binary:"Rscript", script_path:fileURLToPath(new URL("../runtimes/r/ventilation_prediction.R",import.meta.url)), timeout_ms:10_000 }).execute(input,"sha256:prediction");
  assert.equal(result.counts.total,1_000); assert.equal(result.counts.development+result.counts.validation,1_000);
  assert.ok(result.estimates.auroc>0.5&&result.estimates.auroc<=1); assert.ok(result.estimates.brier_score>0&&result.estimates.brier_score<0.25);
  assert.ok(result.estimates.sensitivity > 0); assert.ok(result.estimates.specificity > 0);
  assert.equal(result.diagnostics.model_converged,true); assert.equal(result.publication_outputs.figures.length,2);
  assert.deepEqual(result.method, {
    id: "logistic_prediction_internal_validation",
    version: "1.0.0",
    validation: "deterministic_70_30_split",
    threshold_selection: "development_youden",
  });
  assert.equal(result.provenance.data_source_id, "publication-synthetic-ventilation-fixture");
  assertClose(result.estimates.auroc, 0.808499743983615);
  assertClose(result.estimates.brier_score, 0.0598139320656498);
  assertClose(result.estimates.calibration_intercept, 0.0498197084168586);
  assertClose(result.estimates.calibration_slope, 0.97126022278236);
  assertClose(result.estimates.probability_threshold, 0.0461230084021733);
});
