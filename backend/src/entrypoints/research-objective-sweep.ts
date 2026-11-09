import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenAiCompatibleResearchObjectiveModel, objectiveListCanProceed } from "../research-objectives/index.js";
import { createRepositoryProductPromptRegistry, loadRouterApiKey, requireRouterBaseUrl, resolveBackendRuntimeConfig, routerEnvironmentLayer } from "../runtime/index.js";
import { SqliteModelAuditRepository } from "../model-audit/index.js";

const main = async (): Promise<void> => {
  const questions = JSON.parse(process.env.OBJECTIVE_SWEEP_QUESTIONS_JSON ?? "[]") as unknown;
  if (!Array.isArray(questions) || !questions.length || questions.some((item) => typeof item !== "string" || !item.trim())) throw new Error("OBJECTIVE_SWEEP_QUESTIONS_JSON must contain non-empty strings.");
  const key = loadRouterApiKey({ environment: process.env }); if (!key) throw new Error("Router Virtual Key is not configured.");
  const objectiveTimeoutMs = Number(process.env.OBJECTIVE_MODEL_TIMEOUT_MS ?? "60000");
  const config = resolveBackendRuntimeConfig({ environment: { research_design: { model: { profile: process.env.OPENROUTER_MODEL ?? "aws/gpt-5.3-codex-spark", timeout_ms: objectiveTimeoutMs }, ...routerEnvironmentLayer(process.env) } } });
  const registry = createRepositoryProductPromptRegistry(); const extraction = await registry.load({ id: "research-objectives", version: "1.1.0" }); const coverage = await registry.load({ id: "research-objective-coverage", version: "1.0.0" });
  const model = new OpenAiCompatibleResearchObjectiveModel({ base_url: requireRouterBaseUrl(config), api_key: key, provider: "router", model: config.research_design.model.profile, timeout_ms: config.research_design.model.timeout_ms, max_output_tokens: config.research_design.model.max_output_tokens, objective_prompt: { id: extraction.id, version: extraction.version, content: extraction.body }, coverage_prompt: { id: coverage.id, version: coverage.version, content: coverage.body } });
  const audit = new SqliteModelAuditRepository(config.storage.database_path);
  const outputDirectory = process.env.OBJECTIVE_SWEEP_OUTPUT_DIR ?? ".local/research-objective-sweep"; await mkdir(outputDirectory, { recursive: true }); const results = [];
  for (const [index, question] of questions.entries()) {
    try { const result = await model.analyze(question); audit.append(result.audit); const status = objectiveListCanProceed(result.objective_list, result.coverage) ? "ready_for_confirmation" : "needs_review"; const artifact = { index: index + 1, status, ...result }; await writeFile(join(outputDirectory, `objective-${index + 1}.json`), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 }); results.push({ index: index + 1, status, objectives: result.objective_list.objectives.length, ambiguities: result.objective_list.ambiguities.length, audit: result.audit }); }
    catch (error) { const failureAudit = error && typeof error === "object" && "audit" in error ? error.audit : undefined; if (failureAudit) audit.append([failureAudit]); const artifact = { index: index + 1, status: "blocked", error: "The objective model did not produce a valid result.", ...(failureAudit ? { audit: failureAudit } : {}) }; await writeFile(join(outputDirectory, `objective-${index + 1}.json`), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 }); results.push(artifact); }
  }
  process.stdout.write(`${JSON.stringify({ model: config.research_design.model.profile, count: results.length, results }, null, 2)}\n`);
  audit.close();
};

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Objective sweep failed."}\n`); process.exitCode = 1; });
