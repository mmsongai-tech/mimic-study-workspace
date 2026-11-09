import { createHash } from "node:crypto";
import { executeAggregateBinaryAssociation, type BinaryContingencyTable, type AggregateBinaryAssociationResult } from "../association-analysis/aggregate-binary-association.js";

export interface BinaryCohortFieldManifest {
  exposure: string;
  outcome: string;
  exposure_values: readonly unknown[];
  event_values: readonly unknown[];
}

export interface LocalBinaryCohortResult {
  counts: BinaryContingencyTable;
  input_integrity_id: string;
  rows_seen: number;
  rows_excluded: number;
  exclusion_reasons: Record<string, number>;
}

const increment = (target: Record<string, number>, key: string): void => { target[key] = (target[key] ?? 0) + 1; };

/** Builds a privacy-preserving binary cohort from approved local rows. Patient rows never leave this boundary. */
export const buildLocalBinaryCohort = (rows: readonly Record<string, unknown>[], manifest: BinaryCohortFieldManifest): LocalBinaryCohortResult => {
  if (!manifest.exposure.trim() || !manifest.outcome.trim()) throw new Error("Exposure and outcome fields are required.");
  const counts: BinaryContingencyTable = { exposed_events: 0, exposed_non_events: 0, unexposed_events: 0, unexposed_non_events: 0 };
  const exclusion_reasons: Record<string, number> = {};
  let rows_excluded = 0;
  for (const row of rows) {
    const exposure = row[manifest.exposure];
    const outcome = row[manifest.outcome];
    const exposed = manifest.exposure_values.some((value) => Object.is(value, exposure));
    const unexposed = !exposed && manifest.exposure_values.length > 0 && exposure !== null && exposure !== undefined;
    if (!exposed && !unexposed) { rows_excluded += 1; increment(exclusion_reasons, "exposure_missing_or_unrecognized"); continue; }
    if (outcome === null || outcome === undefined) { rows_excluded += 1; increment(exclusion_reasons, "outcome_missing"); continue; }
    const event = manifest.event_values.some((value) => Object.is(value, outcome));
    const nonEvent = !event && manifest.event_values.length > 0;
    if (!event && !nonEvent) { rows_excluded += 1; increment(exclusion_reasons, "outcome_unrecognized"); continue; }
    if (exposed && event) counts.exposed_events += 1;
    else if (exposed) counts.exposed_non_events += 1;
    else if (event) counts.unexposed_events += 1;
    else counts.unexposed_non_events += 1;
  }
  const input = { manifest, counts, rows_seen: rows.length, rows_excluded, exclusion_reasons };
  return { counts, input_integrity_id: `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`, rows_seen: rows.length, rows_excluded, exclusion_reasons };
};

export const executeLocalBinaryAssociation = (rows: readonly Record<string, unknown>[], manifest: BinaryCohortFieldManifest): AggregateBinaryAssociationResult & { cohort: Omit<LocalBinaryCohortResult, "counts"> } => {
  const cohort = buildLocalBinaryCohort(rows, manifest);
  const analysis = executeAggregateBinaryAssociation(cohort.counts);
  return { ...analysis, cohort: { input_integrity_id: cohort.input_integrity_id, rows_seen: cohort.rows_seen, rows_excluded: cohort.rows_excluded, exclusion_reasons: cohort.exclusion_reasons } };
};
