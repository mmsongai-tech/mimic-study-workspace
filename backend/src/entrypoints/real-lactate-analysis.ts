import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AssociationAnalysisService,
  AssociationAnalysisError,
  PsqlMimicIvLactateMortalityGateway,
  RAssociationStatisticalExecutor,
} from "../association-analysis/index.js";
import {
  createConfirmedStudySpecIntegrityId,
  type ConfirmedStudySpec,
  type StudySpec,
} from "../research-design/index.js";
import { createInitialResearchPreflightService } from "../research-feasibility/index.js";
import { InMemoryRunEvidenceRepository, RunEvidenceService } from "../run-evidence/index.js";
import { ReportExportService } from "../report-export/index.js";
import { resolveBackendRuntimeConfig } from "../runtime/index.js";

let currentStage = "initialization";

const buildStudy = (): ConfirmedStudySpec => {
  const sessionId = "real-mimic-lactate-mortality-v1";
  const revision = 1;
  const spec: StudySpec = {
    schema_version: "1.0.0",
    intent_family: "association",
    title: "Early lactate and in-hospital mortality",
    research_question: "Among adult first ICU admissions, is maximum lactate in the first six hours associated with in-hospital mortality?",
    population: {
      description: "Adult patients at their first recorded ICU admission",
      inclusion_criteria: ["Age 18 years or older", "First ICU admission per patient"],
      exclusion_criteria: ["No valid lactate result in the first six hours"],
    },
    index_time: { event: "ICU admission", selection_rule: "First recorded ICU admission per patient" },
    exposure_or_predictors: [{
      name: "Lactate",
      role: "exposure",
      operational_definition: "Maximum valid lactate (>0 and <=30 mmol/L) from item IDs 50813 or 53154 during the first six hours after ICU admission",
    }],
    outcome: {
      name: "In-hospital mortality",
      role: "outcome",
      operational_definition: "hospital_expire_flag for the hospital admission containing the index ICU stay",
    },
    outcome_structure: "binary",
    time_windows: [{ purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 6, unit: "hour" }],
    covariates: [
      { name: "Age", role: "covariate", operational_definition: "MIMIC-IV anchor age adjusted to ICU admission year" },
      { name: "Sex", role: "covariate", operational_definition: "Sex recorded in patients.gender" },
    ],
    estimand: {
      target_population: "Adult patients at their first recorded ICU admission with a valid early lactate result",
      exposure_contrast: "Maximum lactate >2 versus <=2 mmol/L",
      outcome_measure: "In-hospital mortality",
      summary_measure: "Crude odds ratio and risk difference",
    },
    analysis_family: "association",
    assumptions: [
      "One eligible ICU admission per patient",
      "Lactate is measured before outcome ascertainment",
      "Complete-case results may be affected by selective lactate measurement",
    ],
  };
  return {
    schema_version: "1.0.0",
    session_id: sessionId,
    revision,
    confirmed_at: new Date().toISOString(),
    spec,
    integrity_id: createConfirmedStudySpecIntegrityId(sessionId, revision, spec),
  };
};

export const runRealLactateAnalysis = async (): Promise<{
  outputDirectory: string;
  runId: string;
  total: number;
  oddsRatio: number;
}> => {
  currentStage = "configuration";
  const reportPythonBinary = process.env.MIMIC_REPORT_PYTHON_BINARY;
  const config = resolveBackendRuntimeConfig({
    environment: {
      clinical_database: { enabled: true },
      ...(reportPythonBinary ? { report_exports: { python_binary: reportPythonBinary } } : {}),
    },
  });
  const study = buildStudy();
  const dataSource = {
    id: "mimic-iv-company-readonly",
    version: "lactate-mortality-cohort-1.0.0",
    data_mode: "approved_safety_database" as const,
    available_concepts: ["icu_admission_time", "lactate_measurement", "hospital_discharge_status"],
  };
  const preflightService = createInitialResearchPreflightService();
  const preflight = preflightService.check({ study, data_source: dataSource });
  currentStage = "data_and_statistics";
  const analysis = await new AssociationAnalysisService(
    new PsqlMimicIvLactateMortalityGateway({
      service: config.clinical_database.service,
      binary: config.clinical_database.psql_binary,
      connect_timeout_seconds: config.clinical_database.connect_timeout_seconds,
    }),
    new RAssociationStatisticalExecutor({
      rscript_binary: config.statistical_execution.rscript_binary,
      script_path: fileURLToPath(new URL("../association-analysis/runtimes/r/crude_binary_association.R", import.meta.url)),
      timeout_ms: config.statistical_execution.timeout_ms,
    }),
  ).execute({ study, preflight, threshold_mmol_l: 2 });
  currentStage = "evidence";
  const evidence = new RunEvidenceService({ now: () => new Date() }).create({ study, preflight, analysis });
  const runs = new InMemoryRunEvidenceRepository();
  await runs.save(evidence);
  const outputDirectory = await mkdir(join(tmpdir(), `mimic-real-lactate-${evidence.artifact.run_id}`), { recursive: true })
    .then(() => join(tmpdir(), `mimic-real-lactate-${evidence.artifact.run_id}`));
  await Promise.all([
    writeFile(join(outputDirectory, "run-artifact.json"), JSON.stringify(evidence.artifact, null, 2), { mode: 0o600 }),
    writeFile(join(outputDirectory, "report.md"), evidence.report_markdown, { mode: 0o600 }),
    ...(analysis.publication_outputs?.figures.map((figure) =>
      writeFile(join(outputDirectory, `${figure.id}.svg`), figure.content, { mode: 0o600 })) ?? []),
  ]);
  currentStage = "report_export";
  const exporter = new ReportExportService({
    runs,
    python_binary: config.report_exports.python_binary,
    builder_path: fileURLToPath(new URL("../report-export/runtimes/python/build_clinical_report.py", import.meta.url)),
    timeout_ms: config.report_exports.timeout_ms,
  });
  for (const format of ["docx", "pdf"] as const) {
    const exported = await exporter.create(evidence.artifact.run_id, format, "en");
    await writeFile(join(outputDirectory, exported.filename), exported.content, { mode: 0o600 });
  }
  currentStage = "completed";
  return {
    outputDirectory,
    runId: evidence.artifact.run_id,
    total: analysis.counts.total,
    oddsRatio: analysis.estimates.odds_ratio,
  };
};

const main = async (): Promise<void> => {
  const result = await runRealLactateAnalysis();
  process.stdout.write(`${JSON.stringify({
    status: "completed",
    evidence_level: "approved_safety_database_execution",
    run_id: result.runId,
    total: result.total,
    odds_ratio: result.oddsRatio,
    output_directory: result.outputDirectory,
  }, null, 2)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const code = error instanceof AssociationAnalysisError ? error.code : "REAL_LACTATE_ANALYSIS_FAILED";
    process.stderr.write(`${code}:${currentStage}: The approved MIMIC-IV analysis did not complete.\n`);
    process.exitCode = 1;
  });
}
