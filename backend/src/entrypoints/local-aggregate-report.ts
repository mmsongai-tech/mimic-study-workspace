import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createReproducibleAnalysisReport, validateAggregateBinaryProfile } from "../clinical-data/index.js";

interface LocalAggregateProfile {
  profile_id: string;
  data_mode: "local_mimic_archive";
  source: { archive_sha256: string; tables: string[]; generated_at: string };
  definition: { exposure: string; mortality: string; scope: string; exposure_label?: string; caveat?: string };
  scan_counts: Record<string, number>;
  contingency_table: { exposure: { death: number; survived: number }; no_exposure: { death: number; survived: number } };
  totals: { admissions: number; exposure_admissions: number; deaths: number; exposure_deaths: number };
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

export const buildLocalAggregateReport = async (input: { studyPath: string; manifestPath: string; profilePath: string; outputPath: string }) => {
  const study = await readJson(input.studyPath);
  const manifest = await readJson(input.manifestPath);
  const profile = await readJson(input.profilePath) as LocalAggregateProfile;
  const counts = {
    exposed_events: profile.contingency_table.exposure.death,
    exposed_non_events: profile.contingency_table.exposure.survived,
    unexposed_events: profile.contingency_table.no_exposure.death,
    unexposed_non_events: profile.contingency_table.no_exposure.survived,
  };
  const validation = validateAggregateBinaryProfile({ label: profile.definition.exposure_label ?? profile.profile_id, counts });
  const report = createReproducibleAnalysisReport({
    study,
    manifest,
    method: { method_id: "association.binary.crude.v1", estimands: ["risk_difference", "risk_ratio", "odds_ratio"], diagnostics: ["cohort_reconciliation", "event_information", "repeatability"] },
    data_provenance: { ...profile.source, data_mode: profile.data_mode, profile_id: profile.profile_id, definition: profile.definition, scan_counts: profile.scan_counts },
    validation,
  });
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return { output: input.outputPath, report_integrity_id: report.report_integrity_id, rows: profile.totals.admissions, validation_status: validation.scenarios[0]?.status, repeated_baseline_equal: validation.stability.repeated_baseline_equal };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [studyPath, manifestPath, profilePath, outputPath] = process.argv.slice(2);
  if (!studyPath || !manifestPath || !profilePath || !outputPath) throw new Error("Usage: local-aggregate-report <study.json> <manifest.json> <profile.json> <output.json>");
  buildLocalAggregateReport({ studyPath, manifestPath, profilePath, outputPath }).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Local aggregate report failed."}\n`); process.exitCode = 1; });
}
