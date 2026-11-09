import { pathToFileURL } from "node:url";
import {
  createRepositoryProductPromptRegistry,
  loadRouterApiKey,
  OpenAiCompatibleStructuredProvider,
  requireRouterBaseUrl,
  resolveBackendRuntimeConfig,
  routerEnvironmentLayer,
} from "../runtime/index.js";
import { runRouterSyntheticSmoke } from "../runtime/router-smoke.js";

const DEFAULT_MODEL = "aws/gpt-5.3-codex-spark";

export const executeRouterSmoke = async (environment: NodeJS.ProcessEnv = process.env) => {
  const key = loadRouterApiKey({ environment });
  if (!key) throw new Error("No model router key is configured: set MIMIC_ROUTER_API_KEY (or OPENROUTER_API_KEY) in the environment. The platform itself runs on a local model and does not need one.");
  const model = environment.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = Number(environment.DESIGN_MODEL_TIMEOUT_MS ?? "120000");
  const config = resolveBackendRuntimeConfig({
    environment: { research_design: { model: { profile: model, timeout_ms: timeoutMs }, ...routerEnvironmentLayer(environment) } },
  });
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: requireRouterBaseUrl(config),
    api_key: key,
    max_output_tokens: config.research_design.model.max_output_tokens,
  });
  const prompt = await createRepositoryProductPromptRegistry().load(config.research_design.prompt);
  return runRouterSyntheticSmoke({
    provider,
    systemPrompt: prompt.body,
    model,
    timeoutMs: config.research_design.model.timeout_ms,
  });
};

const main = async (): Promise<void> => {
  process.stdout.write(`${JSON.stringify(await executeRouterSmoke(), null, 2)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? ` [${error.code}]`
      : "";
    process.stderr.write(`${error instanceof Error ? error.message : "Router synthetic smoke failed."}${code}\n`);
    process.exitCode = 1;
  });
}
