import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileLimitationKnowledgeBaseRepository, limitationSentences, matchLimitations } from "../mimic-limitations/index.js";
import { adjustForMultiplicity } from "../question-pipeline/multiplicity.js";
import { writeQuestionReports } from "../study-report/index.js";

// Re-renders the reports of finished runs from their saved run.json (no analysis, no model, no archive), for example after
// the report wording or layout changed. Writes report.{zh,en}.{md,docx,txt} next to each run.json.
// Usage: node --import tsx backend/src/entrypoints/render-reports-from-run.ts RUN_DIR [RUN_DIR ...]

const main = async (): Promise<void> => {
  const directories = process.argv.slice(2);
  if (!directories.length) throw new Error("Give at least one run folder (the one holding run.json).");
  const knowledge = await new FileLimitationKnowledgeBaseRepository(new URL("../../../config/mimic-limitations/mimic-iv-3.1.json", import.meta.url)).load();
  for (const directory of directories.map((path) => resolve(path))) {
    const result = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as Parameters<typeof writeQuestionReports>[0];
    // Runs made before the multiplicity correction existed get it from their saved estimates.
    if (!result.multiplicity) { const adjusted = adjustForMultiplicity(result.plans as never); if (adjusted) result.multiplicity = adjusted; }
    // Figures live in this folder's analyses/ directory; a copied run must link to its own copy, not to where it was first written.
    for (const plan of result.plans) {
      const outputDirectory = plan.result?.output_dir;
      const marker = "/analyses/";
      const at = outputDirectory ? outputDirectory.indexOf(marker) : -1;
      if (plan.result && outputDirectory && at >= 0) plan.result.output_dir = join(directory, "analyses", outputDirectory.slice(at + marker.length));
    }
    const matched = matchLimitations(knowledge, result.frame_set.frames);
    const reports = await writeQuestionReports(result, directory, { limitations: { zh: limitationSentences(matched, "zh"), en: limitationSentences(matched, "en") } });
    process.stdout.write(`${directory}: ${reports.map(({ language }) => language).join(", ")}\n`);
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Rendering failed."}\n`);
  process.exitCode = 1;
});
