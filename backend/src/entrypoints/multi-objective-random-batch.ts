import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { generateUnseededQuestions } from "./router-random-sweep.js";
import { FROZEN_ACCEPTANCE_QUESTIONS } from "./frozen-acceptance-questions.js";
import { loadRouterApiKey, requireRouterBaseUrl, resolveBackendRuntimeConfig, routerEnvironmentLayer } from "../runtime/index.js";

const executeFile = promisify(execFile);

interface RunSummary {
  status: "completed" | "partial" | "blocked";
  report_id: string;
  objective_counts: { total: number; completed: number; blocked: number };
  output_path: string;
  markdown_path: string;
  model: string;
}

const main = async (): Promise<void> => {
  const archivePath = process.env.MIMIC_LOCAL_ARCHIVE;
  if (!archivePath) throw new Error("MIMIC_LOCAL_ARCHIVE is required; the batch has no synthetic fallback.");
  const apiKey = loadRouterApiKey({ environment: process.env });
  if (!apiKey) throw new Error("Router Virtual Key is not configured.");
  const concurrency = Math.max(1, Math.min(4, Number(process.env.MULTI_OBJECTIVE_BATCH_CONCURRENCY ?? "2")));
  const model = process.env.OPENROUTER_MODEL ?? "aws/gpt-5.3-codex-spark";
  const timeoutMs = Number(process.env.OBJECTIVE_MODEL_TIMEOUT_MS ?? "60000");
  const outputDirectory = resolve(process.env.MULTI_OBJECTIVE_BATCH_OUTPUT_DIR ?? ".local/multi-objective-random-batch");
  await mkdir(outputDirectory, { recursive: true });
  const isRandomMode = process.env.MULTI_OBJECTIVE_BATCH_RANDOM === "1";
  const supplied = isRandomMode && process.env.MULTI_OBJECTIVE_BATCH_QUESTIONS_JSON ? JSON.parse(process.env.MULTI_OBJECTIVE_BATCH_QUESTIONS_JSON) as unknown : undefined;
  if (supplied !== undefined && (!Array.isArray(supplied) || supplied.some((value) => typeof value !== "string" || !value.trim()))) throw new Error("MULTI_OBJECTIVE_BATCH_QUESTIONS_JSON must be an array of non-empty strings.");
  const count = isRandomMode ? Math.max(1, Math.min(20, Number(process.env.MULTI_OBJECTIVE_BATCH_COUNT ?? "10"))) : FROZEN_ACCEPTANCE_QUESTIONS.length;
  const questions = supplied as string[] | undefined ?? (isRandomMode ? await generateUnseededQuestions({ baseUrl: requireRouterBaseUrl(resolveBackendRuntimeConfig({ environment: { research_design: routerEnvironmentLayer(process.env) } })), apiKey, model, count, timeoutMs }) : [...FROZEN_ACCEPTANCE_QUESTIONS]);
  const summaries: Array<RunSummary | { status: "failed"; error: string } | undefined> = new Array(questions.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < questions.length) {
      const index = cursor++;
      const runNumber = index + 1;
      const outputPath = join(outputDirectory, `run-${runNumber}.json`);
      const databasePath = join(outputDirectory, `run-${runNumber}.sqlite`);
      process.stderr.write(`${JSON.stringify({ event: "multi_objective_batch", run: runNumber, status: "started" })}\n`);
      try {
        const { stdout } = await executeFile(process.execPath, ["--import", "tsx", "backend/src/entrypoints/multi-objective-local-run.ts"], {
          cwd: process.cwd(),
          env: { ...process.env, MIMIC_RESEARCH_IDEA: questions[index]!, MIMIC_LOCAL_ARCHIVE: archivePath, OPENROUTER_MODEL: model, MULTI_OBJECTIVE_DATABASE_PATH: databasePath, MULTI_OBJECTIVE_OUTPUT_PATH: outputPath },
          timeout: Math.max(timeoutMs * 20, 300_000), maxBuffer: 2_000_000,
        });
        summaries[index] = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as RunSummary;
      } catch (error) {
        summaries[index] = { status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "Unknown batch execution failure." };
      }
      process.stderr.write(`${JSON.stringify({ event: "multi_objective_batch", run: runNumber, status: summaries[index]?.status })}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, questions.length) }, worker));
  const reportStatuses = await Promise.all(questions.map(async (_question, index) => {
    try {
      const report = JSON.parse(await readFile(join(outputDirectory, `run-${index + 1}.json`), "utf8")) as { report?: { artifact?: { status?: string; objective_counts?: unknown } } };
      return report.report?.artifact;
    } catch { return undefined; }
  }));
  const result = { schema_version: "1.0.0", generation: isRandomMode ? (supplied ? "supplied" : "real_model_unseeded") : "frozen_acceptance", question_source: isRandomMode ? "regression_or_random" : "frozen_formal", model, count: questions.length, terminal_reports: reportStatuses.filter(Boolean).length, completed: reportStatuses.filter((value) => value?.status === "completed").length, partial: reportStatuses.filter((value) => value?.status === "partial").length, blocked: reportStatuses.filter((value) => value?.status === "blocked").length, failed: summaries.filter((value) => value?.status === "failed").length, questions: questions.map((question, index) => ({ index: index + 1, question, summary: summaries[index], report: reportStatuses[index] })) };
  const summaryPath = join(outputDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...result, questions: undefined, summary_path: summaryPath })}\n`);
};

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Multi-objective random batch failed."}\n`); process.exitCode = 1; });
