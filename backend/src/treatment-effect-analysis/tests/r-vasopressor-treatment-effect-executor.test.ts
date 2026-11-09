import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PublicationSyntheticVasopressorGateway } from "../gateways/publication-synthetic-vasopressor-gateway.js";
import { RVasopressorTreatmentEffectExecutor } from "../runtimes/r/r-vasopressor-treatment-effect-executor.js";

const assertClose = (actual: number, expected: number, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};

test("runs 1,000-record IPTW treatment-effect analysis with balance diagnostics",async()=>{
  const input=await new PublicationSyntheticVasopressorGateway().load();
  const result=await new RVasopressorTreatmentEffectExecutor({rscript_binary:"Rscript",script_path:fileURLToPath(new URL("../runtimes/r/vasopressor_iptw.R",import.meta.url)),timeout_ms:10_000}).execute(input,"sha256:treatment");
  assert.equal(result.counts.total,1_000); assert.equal(result.counts.treated+result.counts.untreated,1_000);
  assert.ok(Number.isFinite(result.estimates.risk_difference)); assert.ok(result.diagnostics.maximum_smd_after<result.diagnostics.maximum_smd_before);
  assert.equal(result.diagnostics.propensity_model_converged,true); assert.equal(result.publication_outputs.figures.length,2);
  assert.deepEqual(result.method, {
    id: "iptw_average_treatment_effect",
    version: "1.0.0",
    weight_strategy: "stabilized_truncated_1_99",
    uncertainty: "percentile_bootstrap",
  });
  assert.equal(result.provenance.data_source_id, "publication-synthetic-vasopressor-fixture");
  assertClose(result.estimates.weighted_treated_risk, 0.157495268618785);
  assertClose(result.estimates.weighted_untreated_risk, 0.197827045690871);
  assertClose(result.estimates.risk_difference, -0.0403317770720861);
  assertClose(result.estimates.risk_ratio, 0.796126070976618);
  assertClose(result.diagnostics.maximum_smd_after, 0.0131351822571623);
  assertClose(result.diagnostics.effective_sample_size, 883.9373242779);
});
