import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReportExportError,
  type ReportExport,
  type ReportExportFormat,
  type ReportExportLanguage,
} from "../domain/report-export.js";

const contentTypes: Record<ReportExportFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

const safeStem = (value: string): string => value.toLowerCase()
  .replace(/[^a-z0-9]+/gu, "-")
  .replace(/^-+|-+$/gu, "")
  .slice(0, 48) || "research-analysis";

interface ExportableRunRepository {
  findByRunId(runId: string): Promise<unknown | undefined>;
}

const artifactOf = (bundle: unknown): Record<string, unknown> | undefined => {
  if (!bundle || typeof bundle !== "object") return undefined;
  const artifact = (bundle as Record<string, unknown>).artifact;
  return artifact && typeof artifact === "object" ? artifact as Record<string, unknown> : undefined;
};

const reportTitle = (bundle: unknown): string => {
  const study = artifactOf(bundle)?.study;
  if (!study || typeof study !== "object") return "research-analysis";
  const record = study as Record<string, unknown>;
  const spec = record.spec && typeof record.spec === "object" ? record.spec as Record<string, unknown> : record;
  return typeof spec.title === "string" ? spec.title : "research-analysis";
};

export class ReportExportService {
  constructor(private readonly dependencies: {
    runs: ExportableRunRepository;
    fallback_runs?: ExportableRunRepository;
    python_binary: string;
    builder_path: string;
    timeout_ms: number;
  }) {}

  async create(runId: string, format: ReportExportFormat, language: ReportExportLanguage): Promise<ReportExport> {
    if (!runId || !["docx", "pdf"].includes(format) || !["en", "zh"].includes(language)) {
      throw new ReportExportError("REPORT_EXPORT_INVALID", "The requested report export is invalid.");
    }
    const bundle = await this.dependencies.runs.findByRunId(runId)
      ?? await this.dependencies.fallback_runs?.findByRunId(runId);
    if (!bundle) throw new ReportExportError("REPORT_NOT_FOUND", "The research run was not found.");

    const directory = await mkdtemp(join(tmpdir(), "mimic-report-export-"));
    const inputPath = join(directory, "report.json");
    const outputPath = join(directory, `report.${format}`);
    try {
      await writeFile(inputPath, JSON.stringify(bundle), { encoding: "utf8", mode: 0o600 });
      await this.runBuilder([inputPath, outputPath, format, language]);
      const content = await readFile(outputPath);
      if (content.length < 100) throw new Error("The generated report is empty.");
      return {
        filename: `${safeStem(reportTitle(bundle))}-${safeStem(runId).slice(0, 8)}.${format}`,
        content_type: contentTypes[format],
        content,
      };
    } catch (error) {
      if (error instanceof ReportExportError) throw error;
      throw new ReportExportError(
        "REPORT_EXPORT_UNAVAILABLE",
        "The report could not be generated. Check the configured report runtime and try again.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async runBuilder(arguments_: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.dependencies.python_binary, [this.dependencies.builder_path, ...arguments_], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: globalThis.process.env.PATH, LANG: "C.UTF-8" },
      });
      const errors: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Report generation timed out."));
      }, this.dependencies.timeout_ms);
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.concat(errors).length < 8_192) errors.push(chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `Report builder exited with code ${code}.`));
      });
    });
  }
}
