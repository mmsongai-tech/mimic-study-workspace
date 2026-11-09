export interface AggregateDataProfile {
  schema_version: "1.0.0";
  row_count: number;
  missing_count: number;
  non_missing_count: number;
  distinct_count: number;
  numeric?: { minimum: number; maximum: number; mean: number };
  top_values: Array<{ value: string; count: number }>;
}

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

/** Profiles values into aggregate-only diagnostics; it never returns source rows. */
export const profileValues = (values: readonly unknown[], topLimit = 10): AggregateDataProfile => {
  const counts = new Map<string, number>();
  const numbers: number[] = [];
  let missing_count = 0;
  for (const value of values) {
    if (value === null || value === undefined || value === "") { missing_count += 1; continue; }
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const numeric = asNumber(value);
    if (numeric !== undefined) numbers.push(numeric);
  }
  const top_values = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topLimit).map(([value, count]) => ({ value, count }));
  return {
    schema_version: "1.0.0", row_count: values.length, missing_count,
    non_missing_count: values.length - missing_count, distinct_count: counts.size, top_values,
    ...(numbers.length === values.length - missing_count && numbers.length ? {
      numeric: { minimum: Math.min(...numbers), maximum: Math.max(...numbers), mean: numbers.reduce((sum, value) => sum + value, 0) / numbers.length },
    } : {}),
  };
};
