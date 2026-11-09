import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleGeneratedAnalysisPlanner } from "../index.js";
import type { AnalysisPlan } from "../../analysis-planning/index.js";

const plan = {
  schema_version: "1.0.0",
  study_family: "association",
  language: "python",
  method: "Descriptive summary",
  method_rationale: "Report the prespecified denominator and summary.",
  required_conditions: ["Fixed denominator"],
  packages: ["json", "sys"],
  source_code: "import json\nimport sys",
  required_result_keys: ["n"],
} as const;

test("accepts a schema-valid generated plan from an OpenAI-compatible Router", async () => {
  const planner = new OpenAiCompatibleGeneratedAnalysisPlanner({
    base_url: "https://router.invalid/v1",
    api_key: "secret",
    model: "low-cost-model",
    system_prompt: "Generate a controlled plan.",
    timeout_ms: 1_000,
    max_output_tokens: 1_200,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        max_tokens: number;
        temperature?: number;
        response_format: { type: string; json_schema: { strict: boolean; schema: unknown } };
        messages: Array<{ content: string }>;
      };
      assert.equal(body.max_tokens, 1_200);
      assert.equal(body.temperature, undefined);
      assert.equal(body.response_format.type, "json_schema");
      assert.equal(body.response_format.json_schema.strict, true);
      assert.deepEqual(JSON.parse(body.messages[1]?.content ?? "{}").output_schema, body.response_format.json_schema.schema);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200 });
    },
  });
  const result = await planner.propose({
    analysis_plan: { method: { study_family: "association", outcome_structure: "continuous" } } as AnalysisPlan,
    field_manifest: [{ name: "age", type: "number", role: "covariate" }],
    allowed_language: "python",
    allowed_packages: ["json", "sys"],
  });
  assert.deepEqual(result, plan);
});
