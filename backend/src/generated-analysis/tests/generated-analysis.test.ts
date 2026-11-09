import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { access } from "node:fs/promises";
import {
  GeneratedAnalysisError,
  GeneratedAnalysisService,
  GeneratedSourceReviewer,
  type GeneratedAnalysisPlan,
  type GeneratedExecutionPolicy,
} from "../index.js";

const policy: GeneratedExecutionPolicy = {
  enabled: true,
  sandbox: "macos_sandbox",
  python_binary: "/opt/homebrew/bin/python3",
  rscript_binary: "/usr/local/bin/Rscript",
  wall_timeout_ms: 5_000,
  cpu_time_seconds: 3,
  memory_limit_mb: 512,
  max_source_bytes: 20_000,
  max_input_bytes: 100_000,
  max_output_bytes: 20_000,
  allowed_python_packages: ["json", "sys", "math", "statistics"],
  allowed_r_packages: ["jsonlite", "stats", "survival"],
};

const plan = (source_code: string): GeneratedAnalysisPlan => ({
  schema_version: "1.0.0",
  study_family: "association",
  language: "python",
  method: "Aggregate count",
  method_rationale: "Validate the guarded execution path.",
  required_conditions: ["Controlled aggregate-safe input"],
  packages: ["json", "sys"],
  source_code,
  required_result_keys: ["n", "mean"],
});

const canApplyMacOsSandbox = (): boolean => spawnSync(
  "/usr/bin/sandbox-exec",
  ["-p", "(version 1) (allow default)", "/usr/bin/true"],
  { stdio: "ignore" },
).status === 0;

test("rejects generated network, process, environment, and dynamic-evaluation access", () => {
  const reviewer = new GeneratedSourceReviewer();
  for (const [source, expected] of [
    ["import requests\nrequests.get('https://example.com')", "NETWORK_ACCESS"],
    ["import subprocess\nsubprocess.run(['id'])", "PROCESS_ACCESS"],
    ["import os\nprint(os.environ)", "ENVIRONMENT_ACCESS"],
    ["eval('1+1')", "DYNAMIC_EVALUATION"],
  ] as const) {
    const review = reviewer.review(plan(source), policy);
    assert.equal(review.status, "rejected");
    assert.ok(review.violations.some(({ code }) => code === expected));
  }
});

test("records content-free safety and reliability counters", async () => {
  const service = new GeneratedAnalysisService(policy);
  await assert.rejects(
    () => service.execute(plan("import requests\nrequests.get('https://example.com')"), {}),
    (error: unknown) => error instanceof GeneratedAnalysisError && error.code === "GENERATED_SOURCE_REJECTED",
  );
  assert.deepEqual(service.metrics(), {
    attempts: 1,
    completed: 0,
    source_rejected: 1,
    runtime_failed: 0,
    timed_out: 0,
    output_invalid: 0,
    completion_rate: 0,
  });
});

test("executes approved Python in a network-denied temporary sandbox", async (context) => {
  try {
    await access("/usr/bin/sandbox-exec");
    await access(policy.python_binary);
  } catch {
    context.skip("macOS sandbox runtime is unavailable");
    return;
  }
  if (!canApplyMacOsSandbox()) {
    context.skip("macOS sandbox application is blocked by the parent test sandbox");
    return;
  }
  const source = `import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
values = payload["values"]
result = {"n": len(values), "mean": sum(values) / len(values)}
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump(result, handle)
`;
  const result = await new GeneratedAnalysisService(policy).execute(plan(source), { values: [1, 2, 3, 4] });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.aggregate_result, { n: 4, mean: 2.5 });
  assert.match(result.source_sha256, /^sha256:[a-f0-9]{64}$/u);
});

test("fails closed when generated output violates its aggregate contract", async (context) => {
  try {
    await access("/usr/bin/sandbox-exec");
    await access(policy.python_binary);
  } catch {
    context.skip("macOS sandbox runtime is unavailable");
    return;
  }
  if (!canApplyMacOsSandbox()) {
    context.skip("macOS sandbox application is blocked by the parent test sandbox");
    return;
  }
  const source = `import json
import sys
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump({"n": 1}, handle)
`;
  await assert.rejects(
    () => new GeneratedAnalysisService(policy).execute(plan(source), { values: [1] }),
    (error: unknown) => error instanceof GeneratedAnalysisError && error.code === "GENERATED_OUTPUT_INVALID",
  );
});
