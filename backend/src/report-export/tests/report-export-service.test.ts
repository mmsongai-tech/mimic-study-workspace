import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryRunEvidenceRepository } from "../../run-evidence/index.js";
import type { RunEvidenceBundle } from "../../run-evidence/index.js";
import { ReportExportError, ReportExportService } from "../index.js";

const bundle = {
  artifact: {
    run_id: "report-run-1",
    study: { spec: { title: "Lactate analysis" } },
    integrity_id: "sha256:report",
  },
  report_markdown: "# Report",
} as unknown as RunEvidenceBundle;

test("exports a persisted aggregate run and removes temporary inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "report-export-test-"));
  const builder = join(directory, "builder.mjs");
  await writeFile(builder, [
    "import { readFile, writeFile } from 'node:fs/promises';",
    "const [, , input, output, format, language] = process.argv;",
    "const data = JSON.parse(await readFile(input, 'utf8'));",
    "await writeFile(output, Buffer.from(`${format}:${language}:${data.artifact.run_id}:${'x'.repeat(128)}`));",
  ].join("\n"));
  const repository = new InMemoryRunEvidenceRepository();
  await repository.save(bundle);
  const service = new ReportExportService({
    runs: repository,
    python_binary: process.execPath,
    builder_path: builder,
    timeout_ms: 5_000,
  });
  try {
    const exported = await service.create("report-run-1", "docx", "zh");
    assert.equal(exported.content_type, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal(exported.filename, "lactate-analysis-report-r.docx");
    assert.match(exported.content.toString("utf8"), /^docx:zh:report-run-1:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails explicitly for an unknown run", async () => {
  const service = new ReportExportService({
    runs: new InMemoryRunEvidenceRepository(),
    python_binary: process.execPath,
    builder_path: "unused",
    timeout_ms: 5_000,
  });
  await assert.rejects(
    service.create("missing", "pdf", "en"),
    (error: unknown) => error instanceof ReportExportError && error.code === "REPORT_NOT_FOUND",
  );
});

test("exports a dynamic local run from the fallback repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-report-export-test-"));
  const builder = join(directory, "builder.mjs");
  await writeFile(builder, [
    "import { readFile, writeFile } from 'node:fs/promises';",
    "const [, , input, output, format, language] = process.argv;",
    "const data = JSON.parse(await readFile(input, 'utf8'));",
    "await writeFile(output, Buffer.from(`${format}:${language}:${data.artifact.run_id}:${'x'.repeat(128)}`));",
  ].join("\n"));
  const localBundle = {
    artifact: { run_id: "run:local-report", study: { title: "Local MIMIC report" }, integrity_id: "sha256:local" },
    report_markdown: "# Local report",
  };
  const service = new ReportExportService({
    runs: { findByRunId: async () => undefined },
    fallback_runs: { findByRunId: async (runId) => runId === "run:local-report" ? localBundle : undefined },
    python_binary: process.execPath,
    builder_path: builder,
    timeout_ms: 5_000,
  });
  try {
    const exported = await service.create("run:local-report", "pdf", "en");
    assert.equal(exported.filename, "local-mimic-report-run-loca.pdf");
    assert.match(exported.content.toString("utf8"), /^pdf:en:run:local-report:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not expose report-runtime paths or tracebacks", async () => {
  const repository = new InMemoryRunEvidenceRepository();
  await repository.save(bundle);
  const service = new ReportExportService({
    runs: repository,
    python_binary: process.execPath,
    builder_path: "/private/report-builder-that-does-not-exist.py",
    timeout_ms: 5_000,
  });
  await assert.rejects(
    service.create("report-run-1", "docx", "zh"),
    (error: unknown) => error instanceof ReportExportError &&
      error.code === "REPORT_EXPORT_UNAVAILABLE" &&
      !error.message.includes("/private/") &&
      !error.message.includes("Traceback"),
  );
});
