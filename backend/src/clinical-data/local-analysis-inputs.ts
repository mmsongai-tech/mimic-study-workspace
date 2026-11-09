import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import type { AggregateContinuousAssociationResult } from "../association-analysis/aggregate-continuous-association.js";
import type { CoxSurvivalRecord } from "../association-analysis/cox-survival-executor.js";
import type { VentilationPredictionRecord } from "../prediction-analysis/domain/prediction-analysis.js";
import type { VasopressorTreatmentRecord } from "../treatment-effect-analysis/domain/treatment-effect-analysis.js";

export type LocalMimicRow = Readonly<Record<string, unknown>>;
export type LocalMimicRowSource = Iterable<LocalMimicRow> | AsyncIterable<LocalMimicRow>;

const parseDelimited = (line: string): string[] => {
  const values: string[] = []; let value = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) { const char = line[index]; if (char === '"') { if (quoted && line[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted; } else if (char === "," && !quoted) { values.push(value); value = ""; } else value += char; }
  values.push(value); return values;
};

const validateArchiveMember = (member: string): void => {
  if (!member || member.startsWith("/") || member.includes("..") || !member.endsWith(".csv.gz")) throw new Error("Only relative CSV.GZ archive members are allowed.");
};

/** Streams an extracted MIMIC CSV/CSV.GZ table without loading the table into memory. */
export const streamDelimitedRows = async function* (filename: string): AsyncGenerator<LocalMimicRow> {
  const input = createReadStream(filename); const readable = filename.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  const lines = createInterface({ input: readable }); let headers: string[] | undefined;
  for await (const line of lines) { if (!headers) { headers = parseDelimited(line); continue; } const values = parseDelimited(line); if (values.length !== headers.length) continue; yield Object.fromEntries(headers.map((header, index) => [header, values[index]])); }
};

/** Streams one CSV.GZ member directly from a local MIMIC ZIP archive. */
export const streamArchiveRows = async function* (archivePath: string, member: string): AsyncGenerator<LocalMimicRow> {
  validateArchiveMember(member);
  const process = spawn("unzip", ["-p", archivePath, member], { stdio: ["ignore", "pipe", "pipe"] });
  const completion = new Promise<number>((resolve) => process.once("close", (code) => resolve(code ?? 1)));
  const readable = process.stdout.pipe(createGunzip()); const lines = createInterface({ input: readable }); let headers: string[] | undefined;
  for await (const line of lines) { if (!headers) { headers = parseDelimited(line); continue; } const values = parseDelimited(line); if (values.length === headers.length) yield Object.fromEntries(headers.map((header, index) => [header, values[index]])); }
  const exitCode = await completion;
  if (exitCode !== 0) throw new Error(`Unable to read archive member: ${member}`);
};

const quickField = (line: string, columnIndex: number): string => {
  let field = 0; let start = 0; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      if (field === columnIndex) return line.slice(start, index);
      field += 1; start = index + 1;
    }
  }
  return field === columnIndex ? line.slice(start) : "";
};

/** Streams only rows whose simple scalar column is in an approved value set. */
export const streamArchiveRowsFiltered = async function* (archivePath: string, member: string, filter: { column: string; values: readonly string[] }): AsyncGenerator<LocalMimicRow> {
  validateArchiveMember(member);
  const allowed = new Set(filter.values.map(String));
  const process = spawn("unzip", ["-p", archivePath, member], { stdio: ["ignore", "pipe", "pipe"] });
  const completion = new Promise<number>((resolve) => process.once("close", (code) => resolve(code ?? 1)));
  const readable = process.stdout.pipe(createGunzip()); const lines = createInterface({ input: readable }); let headers: string[] | undefined; let columnIndex = -1;
  for await (const line of lines) {
    if (!headers) { headers = parseDelimited(line); columnIndex = headers.indexOf(filter.column); continue; }
    if (columnIndex < 0 || !allowed.has(quickField(line, columnIndex).replace(/^"|"$/gu, ""))) continue;
    const values = parseDelimited(line); if (values.length === headers.length) yield Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  }
  const exitCode = await completion;
  if (exitCode !== 0) throw new Error(`Unable to read archive member: ${member}`);
};

export interface AnalysisInputManifest {
  subject_id: string;
  exposure: string;
  outcome: string;
  predictors?: Readonly<Record<string, string>>;
  treatment?: string;
  strata?: readonly string[];
  time_origin?: string;
  time_end?: string;
}

export interface CohortQualitySummary {
  rows_seen: number;
  complete_rows: number;
  excluded_rows: number;
  exclusion_reasons: Record<string, number>;
  strata_counts: Record<string, number>;
}

const count = (target: Record<string, number>, key: string): void => { target[key] = (target[key] ?? 0) + 1; };
const numeric = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
const truthy = (value: unknown): boolean | undefined => value === true || value === 1 || value === "1" || value === "true" ? true : value === false || value === 0 || value === "0" || value === "false" ? false : undefined;
const dateMillis = (value: unknown): number | undefined => typeof value === "string" || value instanceof Date ? Date.parse(String(value)) : numeric(value);
const strataKey = (row: LocalMimicRow, fields: readonly string[]): string => fields.map((field) => String(row[field] ?? "<missing>")).join("|");

export const toAsyncRows = async function* (source: LocalMimicRowSource): AsyncGenerator<LocalMimicRow> {
  if (Symbol.asyncIterator in Object(source)) { for await (const row of source as AsyncIterable<LocalMimicRow>) yield row; return; }
  for (const row of source as Iterable<LocalMimicRow>) yield row;
};

/** Applies the confirmed manifest and time window while retaining only in-memory analysis records. */
export const collectManifestRows = async (source: LocalMimicRowSource, manifest: AnalysisInputManifest): Promise<{ rows: LocalMimicRow[]; quality: CohortQualitySummary }> => {
  const rows: LocalMimicRow[] = []; const reasons: Record<string, number> = {}; const strata_counts: Record<string, number> = {};
  let rows_seen = 0;
  for await (const row of toAsyncRows(source)) {
    rows_seen += 1;
    if (row[manifest.subject_id] === undefined || row[manifest.subject_id] === null) { count(reasons, "subject_id_missing"); continue; }
    if (manifest.time_origin && manifest.time_end) {
      const start = dateMillis(row[manifest.time_origin]); const end = dateMillis(row[manifest.time_end]);
      if (start === undefined || end === undefined) { count(reasons, "time_window_missing_or_invalid"); continue; }
      if (end < start) { count(reasons, "time_window_reversed"); continue; }
    }
    rows.push(row); count(strata_counts, strataKey(row, manifest.strata ?? []));
  }
  const excluded_rows = rows_seen - rows.length;
  return { rows, quality: { rows_seen, complete_rows: rows.length, excluded_rows, exclusion_reasons: reasons, strata_counts } };
};

export const buildContinuousGroups = async (source: LocalMimicRowSource, manifest: AnalysisInputManifest): Promise<{ groups: AggregateContinuousAssociationResult["groups"]; quality: CohortQualitySummary }> => {
  const collected = await collectManifestRows(source, manifest);
  const sums = { exposed: { n: 0, sum: 0, sum_of_squares: 0 }, unexposed: { n: 0, sum: 0, sum_of_squares: 0 } };
  for (const row of collected.rows) { const exposure = truthy(row[manifest.exposure]); const value = numeric(row[manifest.outcome]); if (exposure === undefined) { count(collected.quality.exclusion_reasons, "exposure_unrecognized"); continue; } if (value === undefined) { count(collected.quality.exclusion_reasons, "outcome_missing_or_non_numeric"); continue; } const group = exposure ? sums.exposed : sums.unexposed; group.n += 1; group.sum += value; group.sum_of_squares += value * value; }
  return { groups: sums, quality: collected.quality };
};

export const buildCoxRecords = async (source: LocalMimicRowSource, manifest: AnalysisInputManifest): Promise<{ records: CoxSurvivalRecord[]; quality: CohortQualitySummary }> => {
  const collected = await collectManifestRows(source, manifest); const records: CoxSurvivalRecord[] = [];
  for (const row of collected.rows) { const exposure = truthy(row[manifest.exposure]); const event = truthy(row[manifest.outcome]); const duration = numeric(row[manifest.time_end ?? "duration"]); if (exposure === undefined) { count(collected.quality.exclusion_reasons, "exposure_unrecognized"); continue; } if (event === undefined) { count(collected.quality.exclusion_reasons, "event_unrecognized"); continue; } if (duration === undefined || duration < 0) { count(collected.quality.exclusion_reasons, "duration_invalid"); continue; } records.push({ duration, event, exposure }); }
  return { records, quality: collected.quality };
};

export const buildPredictionRecords = async (source: LocalMimicRowSource, manifest: AnalysisInputManifest): Promise<{ records: VentilationPredictionRecord[]; quality: CohortQualitySummary }> => {
  const collected = await collectManifestRows(source, manifest); const p = manifest.predictors ?? {}; const records: VentilationPredictionRecord[] = [];
  for (const row of collected.rows) { const age_years = numeric(row[p.age ?? "age"]); const respiratory_rate = numeric(row[p.respiratory_rate ?? "respiratory_rate"]); const spo2_fio2_ratio = numeric(row[p.spo2_fio2_ratio ?? "spo2_fio2_ratio"]); const gcs = numeric(row[p.gcs ?? "gcs"]); const outcome = truthy(row[manifest.outcome]); if ([age_years, respiratory_rate, spo2_fio2_ratio, gcs].some((value) => value === undefined) || outcome === undefined) { count(collected.quality.exclusion_reasons, "predictor_or_outcome_invalid"); continue; } records.push({ synthetic_subject_id: String(row[manifest.subject_id]), age_years: age_years!, respiratory_rate: respiratory_rate!, spo2_fio2_ratio: spo2_fio2_ratio!, gcs: gcs!, invasive_ventilation_24h: outcome }); }
  return { records, quality: collected.quality };
};

export const buildTreatmentRecords = async (source: LocalMimicRowSource, manifest: AnalysisInputManifest): Promise<{ records: VasopressorTreatmentRecord[]; quality: CohortQualitySummary }> => {
  const collected = await collectManifestRows(source, manifest); const p = manifest.predictors ?? {}; const records: VasopressorTreatmentRecord[] = [];
  for (const row of collected.rows) { const treatment = truthy(row[manifest.treatment ?? manifest.exposure]); const outcome = truthy(row[manifest.outcome]); const age_years = numeric(row[p.age ?? "age"]); const sofa_score = numeric(row[p.sofa_score ?? "sofa"]); const baseline_lactate = numeric(row[p.baseline_lactate ?? "lactate"]); const sex = row[p.sex ?? "sex"]; if (treatment === undefined || outcome === undefined || age_years === undefined || sofa_score === undefined || baseline_lactate === undefined || (sex !== "female" && sex !== "male")) { count(collected.quality.exclusion_reasons, "treatment_covariate_or_outcome_invalid"); continue; } records.push({ synthetic_subject_id: String(row[manifest.subject_id]), early_vasopressor: treatment, in_hospital_death: outcome, age_years, sofa_score, baseline_lactate, sex }); }
  return { records, quality: collected.quality };
};
