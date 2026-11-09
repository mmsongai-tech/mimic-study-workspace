import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenAiCompatibleStructuredChatClient } from "../model-output/index.js";
import { StudyFramingService, type StudyFrame, type StudyFrameSet } from "../study-framing/index.js";
import { OpenAiCompatibleClinicalTermExpander } from "../variable-mapping/index.js";
import { createRepositoryProductPromptRegistry } from "../runtime/index.js";
import { labels, overlaps, typeMatches } from "./framing-benchmark-scoring.js";

// Measures whether translating a Chinese question to English before framing beats framing the Chinese directly.
// Variants per literature-benchmark case, same local model and same scorer as study-framing-benchmark.ts:
//   zh_direct  frame(question_zh)                       — what the platform does today
//   zh_via_en  frame(translate(question_zh))            — translate first (translation by the same local model)
//   en_native  frame(question_en)                       — the paper's own English wording: the ceiling for the English path
// The four formal questions are framed both ways and printed side by side with the translation, to expose mistranslated terms.
// Experimental tool: the translation prompt lives here on purpose; nothing in the product pipeline uses it.
// Usage: node --import tsx backend/src/entrypoints/framing-language-comparison.ts [--model M] [--limit N] [--ids a,b] [--out DIR]

interface BenchmarkCase {
  id: string; question_zh: string; question_en: string; study_type: string;
  population: { description: string };
  exposures_or_predictors: Array<{ name: string }>;
  outcomes: Array<{ name: string; primary?: boolean }>;
}

const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };

const TRANSLATE_PROMPT = {
  id: "experiment-question-translation", version: "0.1.0",
  body: [
    "Translate the Chinese medical research question into English.",
    "Keep every drug, disease, measurement, population, comparison and outcome; use the standard English medical term for each.",
    "Do not add, drop or explain anything, and do not answer the question.",
    'Return JSON: {"english_question": "..."}',
  ].join("\n"),
};
const TRANSLATE_SCHEMA = { id: "experiment-question-translation", version: "0.1.0", json: { type: "object", properties: { english_question: { type: "string", minLength: 3 } }, required: ["english_question"], additionalProperties: false } };

// The four questions exactly as the pilot users wrote them (2026-09-30).
const USER_QUESTIONS = [
  "高血压人群美托洛尔与不用美托洛尔对比降压疗效以及全因死亡结局的差异，及性别对药物疗效的影响。",
  "高血压人群阿替洛尔与不用阿替洛尔对比降压疗效以及全因死亡结局的差异，及性别对药物疗效的影响。",
  "阿片类药物镇痛剂量-疗效性别差异",
  "降压药对心血管结局的疗效及降压作用在其中的贡献度\n降压药：血管紧张素转化酶抑制剂（普利类药物）、血管紧张素II受体拮抗剂（沙坦类药物）、β受体阻滞剂、钙通道拮抗剂、利尿剂\n心血管结局：主要心血管事件（包括：因心血管死亡，心肌梗死，中风）等\n降压作用：降压速度、降压幅度、降压稳定度等",
];

const VARIANTS = ["zh_direct", "zh_via_en", "en_native"] as const;
type Variant = typeof VARIANTS[number];

const main = async (): Promise<void> => {
  const model = argument("--model") ?? process.env.MIMIC_LOCAL_MODEL_PROFILE ?? "qwen2.5:7b-instruct-q4_K_M";
  const baseUrl = process.env.MIMIC_LOCAL_MODEL_BASE_URL || "http://127.0.0.1:11434/v1";
  const limit = Number(argument("--limit") ?? "0");
  const ids = argument("--ids")?.split(",");
  const outDir = argument("--out") ?? join(".local", "benchmarks", `framing-language-${new Date().toISOString().slice(0, 16).replaceAll(":", "")}`);
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
    normalizer: { normalize: async ({ text, role }) => { const result = await expander.expand({ term: text, role }); return { label_en: result.normalized_label_en, category: result.category }; } },
  });
  const translate = async (chinese: string): Promise<string> => (await client.call<{ english_question: string }>({ stage: "experiment_translation", prompt: TRANSLATE_PROMPT, schema: TRANSLATE_SCHEMA, input: { question: chinese }, max_output_tokens: 300 })).value.english_question;

  let cases = JSON.parse(await readFile(new URL("../validation-fixtures/literature-benchmark/cases.json", import.meta.url), "utf8")) as BenchmarkCase[];
  if (ids) cases = cases.filter(({ id }) => ids.includes(id));
  if (limit > 0) cases = cases.slice(0, limit);
  await mkdir(outDir, { recursive: true });

  const frameOf = async (question: string): Promise<{ frames: StudyFrame[]; failure?: string }> => {
    try { return { frames: (await service.frame(question)).frame_set.frames }; } catch (error) { return { frames: [], failure: error instanceof Error ? error.message : "failed" }; }
  };
  const score = (benchmark: BenchmarkCase, frames: StudyFrame[]) => ({
    type_match: typeMatches(benchmark.study_type, frames),
    population_match: overlaps(labels(frames, (frame) => [frame.population]), [benchmark.population.description]),
    exposure_match: benchmark.exposures_or_predictors.length === 0 ? null : overlaps(labels(frames, (frame) => [frame.exposure, ...frame.predictors, ...frame.modifiers]), benchmark.exposures_or_predictors.map(({ name }) => name)),
    outcome_match: overlaps(labels(frames, (frame) => [frame.outcome]), benchmark.outcomes.map(({ name }) => name)),
  });

  const rows: Array<Record<string, unknown>> = [];
  for (const benchmark of cases) {
    const row: Record<string, unknown> = { id: benchmark.id, expected_type: benchmark.study_type };
    let translation = "";
    try { translation = await translate(benchmark.question_zh); } catch (error) { row.translation_failure = error instanceof Error ? error.message : "failed"; }
    row.translation = translation; row.question_en = benchmark.question_en;
    for (const variant of VARIANTS) {
      const started = Date.now();
      const question = variant === "zh_direct" ? benchmark.question_zh : variant === "zh_via_en" ? translation : benchmark.question_en;
      const { frames, failure } = question ? await frameOf(question) : { frames: [], failure: "no translation" };
      row[variant] = { ...score(benchmark, frames), seconds: Math.round((Date.now() - started) / 1000), failure, frame_types: frames.map(({ study_type }) => study_type) };
    }
    rows.push(row);
    const cell = (variant: Variant): string => { const r = row[variant] as ReturnType<typeof score> & { failure?: string }; return r.failure ? "FAIL" : `${r.type_match ? 1 : 0}${r.population_match ? 1 : 0}${r.exposure_match === null ? "-" : r.exposure_match ? 1 : 0}${r.outcome_match ? 1 : 0}`; };
    process.stdout.write(`${benchmark.id}\t${benchmark.study_type}\tzh=${cell("zh_direct")}\tvia_en=${cell("zh_via_en")}\ten=${cell("en_native")}\n`);
    await writeFile(join(outDir, "results.partial.json"), `${JSON.stringify(rows, null, 2)}\n`);
  }

  const rate = (variant: Variant, key: "type_match" | "population_match" | "exposure_match" | "outcome_match"): string => {
    const scored = rows.filter((row) => (row[variant] as Record<string, unknown>)[key] !== null);
    return `${scored.filter((row) => (row[variant] as Record<string, unknown>)[key] === true).length}/${scored.length}`;
  };
  const summary = Object.fromEntries(VARIANTS.map((variant) => [variant, {
    type: rate(variant, "type_match"), population: rate(variant, "population_match"), exposure: rate(variant, "exposure_match"), outcome: rate(variant, "outcome_match"),
    failures: rows.filter((row) => (row[variant] as { failure?: string }).failure).length,
    mean_seconds: Math.round(rows.reduce((sum, row) => sum + ((row[variant] as { seconds: number }).seconds), 0) / Math.max(1, rows.length)),
  }]));
  process.stdout.write(`## summary ${JSON.stringify({ model, cases: rows.length, ...summary })}\n`);

  const formal: Array<Record<string, unknown>> = [];
  for (const question of USER_QUESTIONS) {
    let translation = "";
    try { translation = await translate(question); } catch { /* recorded as empty */ }
    const describe = (frames: StudyFrame[]): string[] => frames.map((frame) => `${frame.frame_id}:${frame.study_type}[${frame.exposure?.text ?? "-"}${frame.exposure?.categories ? ` {${frame.exposure.categories.join("; ")}}` : ""} → ${frame.outcome?.text ?? "-"}${frame.outcome?.components?.length ? ` {${frame.outcome.components.join("; ")}}` : ""}${frame.modifiers.length ? ` | mod ${frame.modifiers.map(({ text }) => text).join(",")}` : ""}${frame.mediators.length ? ` | med ${frame.mediators.map(({ text }) => text).join(",")}` : ""}] ${frame.status}`);
    const direct = await frameOf(question); const viaEnglish = translation ? await frameOf(translation) : { frames: [] as StudyFrame[], failure: "no translation" };
    formal.push({ question, translation, zh_direct: describe(direct.frames), zh_via_en: describe(viaEnglish.frames), failures: [direct.failure, viaEnglish.failure].filter(Boolean) });
    process.stdout.write(`## formal ${formal.length}\n  question: ${question.replaceAll("\n", " / ")}\n  translated: ${translation}\n  zh_direct: ${describe(direct.frames).join("; ")}\n  zh_via_en: ${describe(viaEnglish.frames).join("; ")}\n`);
  }
  await writeFile(join(outDir, "results.json"), `${JSON.stringify({ model, summary, rows, formal }, null, 2)}\n`);
  process.stdout.write(`Results: ${join(outDir, "results.json")}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Framing language comparison failed."}\n`);
  process.exitCode = 1;
});
