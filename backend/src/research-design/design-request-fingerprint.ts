import { createHash } from "node:crypto";

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

export const createDesignRequestFingerprint = (operation: string, request: unknown): string => {
  const payload = JSON.stringify(canonicalize({ operation, request }));
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
};
