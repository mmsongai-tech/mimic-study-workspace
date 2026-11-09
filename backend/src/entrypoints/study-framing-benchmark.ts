import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenAiCompatibleStructuredChatClient } from "../model-output/index.js";
import { StudyFramingService, type StudyFrame, type StudyFrameSet } from "../study-framing/index.js";
import { OpenAiCompatibleClinicalTermExpander } from "../variable-mapping/index.js";
import { createRepositoryProductPromptRegistry } from "../runtime/index.js";
import { FROZEN_ACCEPTANCE_QUESTIONS } from "./frozen-acceptance-questions.js";
import { labels, overlaps, typeMatches } from "./framing-benchmark-scoring.js";

// Scores study framing on the literature benchmark (dev set) and runs the frozen acceptance questions (held out).
// Usage: node --import tsx backend/src/entrypoints/study-framing-benchmark.ts [--model M] [--limit N] [--ids a,b] [--no-normalize] [--no-formal]

interface BenchmarkCase {
  id: string; question_zh: string; study_type: string;
  population: { description: string };
  exposures_or_predictors: Array<{ name: string }>;
  outcomes: Array<{ name: string; primary?: boolean }>;
  effect_modifiers?: string[]; mediators?: string[];
}

const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const flag = (name: string): boolean => process.argv.includes(name);

const main = async (): Promise<void> => {
  const model = argument("--model") ?? process.env.MIMIC_LOCAL_MODEL_PROFILE ?? "qwen2.5:7b-instruct-q4_K_M";
  const baseUrl = process.env.MIMIC_LOCAL_MODEL_BASE_URL || "http://127.0.0.1:11434/v1";
  const limit = Number(argument("--limit") ?? "0");
  const ids = argument("--ids")?.split(",");
  const outDir = argument("--out") ?? join(".local", "benchmarks", `framing-${new Date().toISOString().slice(0, 16).replaceAll(":", "")}`);
  const prompts = createRepositoryProductPromptRegistry();
  const [split, extraction, extractionEn, mapping] = await Promise.all([
    prompts.load({ id: "study-question-split", version: "1.0.0" }),
    prompts.load({ id: "study-frame-extraction", version: "1.0.0" }),
    prompts.load({ id: "study-frame-extraction-en", version: "1.0.0" }),
    prompts.load({ id: "variable-mapping", version: "0.3.0" }),
  ]);
  const client = new OpenAiCompatibleStructuredChatClient({ provider: "local", base_url: baseUrl, model, timeout_ms: 300_000 });
  const expander = new OpenAiCompatibleClinicalTermExpander({ base_url: baseUrl, model, system_prompt: mapping.body, timeout_ms: 300_000, max_output_tokens: 400 });
  const service = new StudyFramingService({
    model: client,
    prompts: { split, extraction, extraction_en: extractionEn },
    ...(flag("--no-normalize") ? {} : { normalizer: { normalize: async ({ text, role }) => { const result = await expander.expand({ term: text, role }); return { label_en: result.normalized_label_en, category: result.category }; } } }),
  });

  let cases = JSON.parse(await readFile(new URL("../validation-fixtures/literature-benchmark/cases.json", import.meta.url), "utf8")) as BenchmarkCase[];
  if (ids) cases = cases.filter(({ id }) => ids.includes(id));
  if (limit > 0) cases = cases.slice(0, limit);
  await mkdir(outDir, { recursive: true });

  const rows: Array<Record<string, unknown>> = [];
  for (const benchmark of cases) {
    const started = Date.now();
    let frameSet: StudyFrameSet | undefined; let failure: string | undefined;
    try { frameSet = (await service.frame(benchmark.question_zh)).frame_set; } catch (error) { failure = error instanceof Error ? error.message : "failed"; }
    const frames = frameSet?.frames ?? [];
    const row = {
      id: benchmark.id, expected_type: benchmark.study_type, seconds: Math.round((Date.now() - started) / 1000), failure,
      frame_types: frames.map(({ study_type }) => study_type),
      type_match: typeMatches(benchmark.study_type, frames),
      population_match: overlaps(labels(frames, (frame) => [frame.population]), [benchmark.population.description]),
      exposure_match: benchmark.exposures_or_predictors.length === 0 ? null : overlaps(labels(frames, (frame) => [frame.exposure, ...frame.predictors, ...frame.modifiers]), benchmark.exposures_or_predictors.map(({ name }) => name)),
      outcome_match: overlaps(labels(frames, (frame) => [frame.outcome]), benchmark.outcomes.map(({ name }) => name)),
      ready_frames: frames.filter(({ status }) => status === "ready").length,
      frames,
    };
    rows.push(row);
    process.stdout.write(`${row.id}\t${row.expected_type}\t${row.frame_types.join(",") || "-"}\ttype=${row.type_match ? 1 : 0}\tpop=${row.population_match ? 1 : 0}\texp=${row.exposure_match === null ? "-" : row.exposure_match ? 1 : 0}\tout=${row.outcome_match ? 1 : 0}\t${row.seconds}s${failure ? `\t${failure}` : ""}\n`);
  }
  const rate = (key: string): string => {
    const scored = rows.filter((row) => row[key] !== null);
    return `${scored.filter((row) => row[key] === true).length}/${scored.length}`;
  };
  const summary = {
    model, cases: rows.length, failures: rows.filter(({ failure }) => failure).length,
    type_match: rate("type_match"), population_match: rate("population_match"), exposure_match: rate("exposure_match"), outcome_match: rate("outcome_match"),
    mean_seconds: Math.round(rows.reduce((sum, row) => sum + (row.seconds as number), 0) / Math.max(1, rows.length)),
  };
  process.stdout.write(`## dev summary ${JSON.stringify(summary)}\n`);

  const formal: Array<{ question: string; frame_set?: StudyFrameSet; failure?: string; seconds: number }> = [];
  if (!flag("--no-formal")) {
    for (const question of FROZEN_ACCEPTANCE_QUESTIONS) {
      const started = Date.now();
      try { formal.push({ question, frame_set: (await service.frame(question)).frame_set, seconds: Math.round((Date.now() - started) / 1000) }); }
      catch (error) { formal.push({ question, failure: error instanceof Error ? error.message : "failed", seconds: Math.round((Date.now() - started) / 1000) }); }
      const last = formal.at(-1)!;
      process.stdout.write(`## formal ${FROZEN_ACCEPTANCE_QUESTIONS.indexOf(question) + 1}: ${last.failure ?? last.frame_set!.frames.map((frame) => `${frame.frame_id}:${frame.study_type}[${frame.exposure?.text ?? "-"} vs ${frame.comparator?.kind ?? "-"} → ${frame.outcome?.text ?? "-"}${frame.modifiers.length ? ` | mod ${frame.modifiers.map(({ text }) => text).join(",")}` : ""}${frame.mediators.length ? ` | med ${frame.mediators.map(({ text }) => text).join(",")}` : ""}] ${frame.status}`).join("; ")} (${last.seconds}s)\n`);
    }
  }
  await writeFile(join(outDir, "results.json"), `${JSON.stringify({ summary, rows, formal }, null, 2)}\n`);
  process.stdout.write(`Results: ${join(outDir, "results.json")}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Study framing benchmark failed."}\n`);
  process.exitCode = 1;
});
