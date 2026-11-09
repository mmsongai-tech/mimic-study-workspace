import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { QuestionRunResult } from "../question-pipeline/index.js";
import { buildReportDocument, type ReportLanguage } from "./report-document.js";
import { renderMarkdown, renderText } from "./text-renderers.js";

const DOCX_SCRIPT = fileURLToPath(new URL("./runtimes/python/render_docx.py", import.meta.url));

export interface WrittenReport { language: ReportLanguage; markdown: string; text: string; docx?: string; docx_error?: string }

const runPython = (python: string, args: string[], timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(python, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1000); });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim().split("\n").at(-1) ?? `exit ${code}`)); });
});

/**
 * Writes Markdown, plain text and Word reports in each requested language. Word output needs the report
 * Python runtime (scripts/setup-report-runtime.zsh); when it is missing, the text formats are still written
 * and the Word failure is reported rather than hidden.
 */
export const writeQuestionReports = async (result: QuestionRunResult, directory: string, options: { languages?: ReportLanguage[]; python_binary?: string; limitations?: Partial<Record<ReportLanguage, string[]>> } = {}): Promise<WrittenReport[]> => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "run.json"), `${JSON.stringify(result, null, 2)}\n`);
  const written: WrittenReport[] = [];
  for (const language of options.languages ?? ["zh", "en"]) {
    const document = buildReportDocument(result, language, options.limitations?.[language] ?? []);
    const markdown = join(directory, `report.${language}.md`); const text = join(directory, `report.${language}.txt`); const docx = join(directory, `report.${language}.docx`);
    await writeFile(markdown, renderMarkdown(document, directory));
    await writeFile(text, renderText(document));
    const documentJson = join(directory, `.report.${language}.json`);
    await writeFile(documentJson, JSON.stringify(document));
    try {
      await runPython(options.python_binary ?? ".venv/bin/python3", [DOCX_SCRIPT, documentJson, docx], 120_000);
      written.push({ language, markdown, text, docx });
    } catch (error) {
      written.push({ language, markdown, text, docx_error: error instanceof Error ? error.message : "Word rendering failed." });
    }
  }
  return written;
};
