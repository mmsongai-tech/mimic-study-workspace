import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { benchmarkReport, scoreCase, summarize, type BenchmarkCase, type RunSummary } from "../literature-benchmark/index.js";

// Scores finished workspace runs of the literature benchmark against the published results and writes a bilingual
// report. Usage: node --import tsx backend/src/entrypoints/literature-benchmark-score.ts --runs map.json [--out DIR]
//   map.json: { "<case id>": "<workspace run id>" }. Runs are read from .local/question-workspace/runs/<id>/.
// The report holds MIMIC-derived aggregates, so it is written under .local (never committed).

const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };

const readRun = async (directory: string): Promise<RunSummary> => {
  try {
    const result = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as { plans: RunSummary["plans"]; unanswered_frames?: unknown[] };
    return { status: "completed", plans: result.plans, unanswered: result.unanswered_frames?.length ?? 0 };
  } catch {
    try {
      const status = JSON.parse(await readFile(join(directory, "status.json"), "utf8")) as { status: string; error?: string };
      return { status: "failed", plans: [], error: status.error ?? `run ${status.status}` };
    } catch { return { status: "missing", plans: [], error: "run not found" }; }
  }
};

const main = async (): Promise<void> => {
  const mapFile = argument("--runs");
  if (!mapFile) throw new Error("Pass --runs with a JSON map of case id to workspace run id.");
  const runs = JSON.parse(await readFile(mapFile, "utf8")) as Record<string, string>;
  const cases = JSON.parse(await readFile(new URL("../validation-fixtures/literature-benchmark/cases.json", import.meta.url), "utf8")) as BenchmarkCase[];
  const root = join(".local", "question-workspace", "runs");
  const scores = [];
  for (const item of cases.filter(({ id }) => runs[id])) scores.push(scoreCase(item, await readRun(join(root, runs[item.id]!))));
  const date = new Date().toISOString().slice(0, 10);
  const outDir = argument("--out") ?? join(".local", "benchmark", date);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "literature-benchmark.en.md"), benchmarkReport(scores, "en", date));
  await writeFile(join(outDir, "literature-benchmark.zh.md"), benchmarkReport(scores, "zh", date));
  await writeFile(join(outDir, "literature-benchmark.json"), `${JSON.stringify({ date, summary: summarize(scores), scores }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ out: outDir, summary: summarize(scores) }, null, 2)}\n`);
};

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Benchmark scoring failed."}\n`); process.exitCode = 1; });
