import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RSyntheticMethodValidationService, type SyntheticValidationScenario } from "../index.js";

const service = new RSyntheticMethodValidationService({
  rscript_binary: "/usr/local/bin/Rscript",
  script_path: fileURLToPath(new URL("../runtimes/r/synthetic_method_validation.R", import.meta.url)),
  timeout_ms: 20_000,
});

for (const scenario of ["continuous_association", "count_association", "time_to_event_association", "repeated_measure_association", "competing_risk_association"] as SyntheticValidationScenario[]) {
  test(`executes R synthetic validation for ${scenario}`, async () => {
    const result = await service.execute(scenario);
    assert.equal(result.evidence_level, "synthetic_execution");
    assert.equal(result.diagnostics.decision, "reportable");
    assert.ok(result.sample.observations >= result.sample.study_units);
    assert.ok(result.estimate.value > 1 || (scenario === "continuous_association" || scenario === "repeated_measure_association") && result.estimate.value > 0);
    assert.ok(result.estimate.confidence_interval_95[0] < result.estimate.value);
    assert.ok(result.estimate.confidence_interval_95[1] > result.estimate.value);
    assert.match(result.report_markdown, /Why this method/iu);
    assert.match(result.report_markdown, /Required conditions/iu);
    assert.match(result.report_markdown, /Diagnostic decision/iu);
    assert.match(result.report_markdown, /not clinical/iu);
    assert.match(result.publication_outputs.figures[0]?.content ?? "", /<svg/iu);
  });
}
