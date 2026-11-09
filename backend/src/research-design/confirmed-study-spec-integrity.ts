import { createHash } from "node:crypto";
import type { StudySpec } from "./study-spec.js";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
};

export const createConfirmedStudySpecIntegrityId = (
  sessionId: string,
  revision: number,
  spec: StudySpec,
): string => {
  const payload = JSON.stringify(canonicalize({ schema_version: "1.0.0", sessionId, revision, spec }));
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
};
