import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { GeneratedAnalysisPlan } from "../domain/generated-analysis.js";
import { GeneratedAnalysisError } from "../domain/generated-analysis.js";
import type { GeneratedAnalysisPlanner } from "./generated-analysis-planner.js";
import { nodeHttp1Fetch } from "../../runtime/node-http1-fetch.js";

const schema = JSON.parse(readFileSync(new URL("../../../../contracts/generated-analysis/plan.schema.json", import.meta.url), "utf8")) as object;

export class OpenAiCompatibleGeneratedAnalysisPlanner implements GeneratedAnalysisPlanner {
  private readonly validate: ValidateFunction<GeneratedAnalysisPlan>;

  constructor(private readonly options: {
    base_url: string;
    api_key: string;
    model: string;
    system_prompt: string;
    timeout_ms: number;
    max_output_tokens: number;
    fetch?: typeof fetch;
  }) {
    this.validate = new Ajv2020({ allErrors: true, strict: true }).compile<GeneratedAnalysisPlan>(schema);
  }

  async propose(input: Parameters<GeneratedAnalysisPlanner["propose"]>[0]): Promise<GeneratedAnalysisPlan> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeout_ms);
    let response: Response;
    try {
      response = await (this.options.fetch ?? nodeHttp1Fetch)(`${this.options.base_url.replace(/\/$/u, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.api_key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: this.options.max_output_tokens,
          response_format: {
            type: "json_schema",
            json_schema: { name: "generated_analysis_plan", strict: true, schema },
          },
          messages: [
            { role: "system", content: this.options.system_prompt },
            { role: "user", content: JSON.stringify({ ...input, output_schema: schema }) },
          ],
        }),
        signal: controller.signal,
      });
    } catch {
      throw new GeneratedAnalysisError("GENERATED_RUNTIME_UNAVAILABLE", "The generated-analysis planner is unavailable.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new GeneratedAnalysisError("GENERATED_RUNTIME_UNAVAILABLE", "The generated-analysis planner rejected the request.");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "The generated-analysis planner returned invalid JSON.");
    }
    const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "The generated-analysis planner returned no plan.");
    let plan: unknown;
    try {
      plan = JSON.parse(content);
    } catch {
      throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "The generated-analysis planner returned malformed content.");
    }
    if (!this.validate(plan)) {
      throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "The generated-analysis plan failed schema validation.");
    }
    return plan;
  }
}
