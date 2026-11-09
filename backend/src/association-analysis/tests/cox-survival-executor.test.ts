import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RCoxSurvivalExecutor } from "../index.js";

test("executes a Cox survival model and returns diagnostics", async () => {
  const result = await new RCoxSurvivalExecutor({ rscript_binary: "Rscript", script_path: fileURLToPath(new URL("../runtimes/r/cox_survival.R", import.meta.url)), timeout_ms: 10_000 }).execute([
    { duration: 1, event: true, exposure: true }, { duration: 2, event: false, exposure: true }, { duration: 3, event: true, exposure: false }, { duration: 4, event: false, exposure: false }, { duration: 5, event: true, exposure: true }, { duration: 6, event: false, exposure: false },
  ]);
  assert.equal(result.status, "completed"); assert.equal(result.counts.total, 6); assert.equal(result.counts.events, 3); assert.ok(Number.isFinite(result.estimates.hazard_ratio)); assert.equal(result.diagnostics.model_converged, true);
});
