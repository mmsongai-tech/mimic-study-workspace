import { createHash } from "node:crypto";

/**
 * The derived-variable layer numbers its readmission and history items by the position of a coded diagnosis concept and computes
 * them from the concept's codes (scripts/derived/stay.py). A layer built from other definitions would answer a question with
 * another meaning, so the build stores this fingerprint (scripts/derived/common.py) and the platform refuses a layer whose
 * fingerprint differs from the one computed from the current definitions.
 */
export interface DiagnosisConceptCodes { concept_id: string; codes: ReadonlyArray<{ code: string; version: number }> }

export const diagnosisFingerprint = (order: readonly string[], concepts: readonly DiagnosisConceptCodes[]): string => {
  const byId = new Map(concepts.map((concept) => [concept.concept_id, concept]));
  const lines = order.filter((id) => byId.has(id)).map((id) => `${id}:${byId.get(id)!.codes.map(({ version, code }) => `${version}:${code}`).sort().join(",")}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
};
