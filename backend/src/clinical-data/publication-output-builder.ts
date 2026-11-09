import type { ProjectedAnalysisRow } from "./local-execution-graph-runner.js";

export interface PublicationTable { id: string; title: string; columns: string[]; rows: string[][]; }
export interface PublicationFigure { id: string; title: string; mime_type: "image/svg+xml"; content: string; }
export interface AggregateListing { id: string; title: string; columns: string[]; rows: string[][]; privacy: "aggregate_only"; }
export interface PublicationOutputs { tables: PublicationTable[]; listings: AggregateListing[]; figures: PublicationFigure[]; }

type StatisticalProjection = {
  study_family: string;
  outcome_structure: string;
  method: string;
  counts: Record<string, number | null>;
  estimates: Record<string, number | string | null>;
  diagnostics: Record<string, number | boolean | null>;
  sensitivity: { analysis: string; estimate: number | null };
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const shown = (value: unknown): string => finite(value) ? value.toFixed(4) : value === null || value === undefined ? "NA" : String(value);
const xml = (value: unknown): string => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const numeric = (rows: ProjectedAnalysisRow[], key: string): number[] => rows.map((row) => Number(row[key])).filter(Number.isFinite);
const meanSd = (values: number[]): string => {
  if (!values.length) return "NA";
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
  return `${mean.toFixed(2)} (${Math.sqrt(variance).toFixed(2)})`;
};
const summarized = (rows: ProjectedAnalysisRow[], key: string): string => {
  const values = rows.map((row) => row[key]).filter((value) => value !== undefined && value !== null && value !== "");
  const numbers = numeric(rows, key);
  if (numbers.length === values.length) return meanSd(numbers);
  if (!values.length) return "NA";
  const counts = new Map<string, number>();
  for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value, count]) => `${value}: ${count} (${(count / values.length * 100).toFixed(1)}%)`).join("; ");
};

const estimateFigure = (result: StatisticalProjection): PublicationFigure => {
  const estimate = result.estimates.estimate;
  const lower = result.estimates.ci_lower;
  const upper = result.estimates.ci_upper;
  const values = [estimate, lower, upper].filter(finite);
  const minimum = Math.min(...values, result.estimates.effect_scale === "odds_ratio" ? 1 : 0);
  const maximum = Math.max(...values, result.estimates.effect_scale === "odds_ratio" ? 1 : 0);
  const span = maximum - minimum || 1;
  const x = (value: number): number => 90 + ((value - minimum) / span) * 620;
  const reference = result.estimates.effect_scale === "odds_ratio" ? 1 : 0;
  const interval = finite(lower) && finite(upper) ? `<line x1="${x(lower)}" y1="105" x2="${x(upper)}" y2="105" stroke="#173B33" stroke-width="4"/>` : "";
  const point = finite(estimate) ? `<circle cx="${x(estimate)}" cy="105" r="8" fill="#0B806A"/>` : "";
  return { id: "primary_effect", title: "Primary effect estimate", mime_type: "image/svg+xml", content: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="190" viewBox="0 0 800 190"><rect width="800" height="190" fill="white"/><text x="40" y="35" font-family="Arial" font-size="20" fill="#173B33">${xml(result.method)}</text><line x1="90" y1="105" x2="710" y2="105" stroke="#C8D8D3"/><line x1="${x(reference)}" y1="70" x2="${x(reference)}" y2="140" stroke="#9A6200" stroke-dasharray="5 4"/>${interval}${point}<text x="90" y="165" font-family="Arial" font-size="15">${shown(minimum)}</text><text x="710" y="165" text-anchor="end" font-family="Arial" font-size="15">${shown(maximum)}</text></svg>` };
};

/** Builds publication-facing aggregate tables and figures without exposing analysis rows. */
export const buildPublicationOutputs = (rows: ProjectedAnalysisRow[], result: StatisticalProjection): PublicationOutputs => {
  const exposureGroups = ["Overall", "Exposed", "Unexposed"];
  const subsets = [rows, rows.filter((row) => Boolean(Number(row.exposure))), rows.filter((row) => !Boolean(Number(row.exposure)))];
  const covariates = [...new Set(rows.flatMap((row) => Object.keys(row)).filter((key) => key.startsWith("covariate_") || key.startsWith("predictor_") || key.startsWith("effect_modifier_")))];
  const baselineRows = [["Analysis units", ...subsets.map((subset) => String(subset.length))], ...covariates.map((key) => [key, ...subsets.map((subset) => summarized(subset, key))])];
  const estimateRows = Object.entries(result.estimates).map(([key, value]) => [key, shown(value)]);
  const diagnosticRows = Object.entries(result.diagnostics).map(([key, value]) => [key, shown(value)]);
  const flowRows = [["Input rows", shown(result.counts.total)], ["Complete rows", shown(result.counts.complete)], ["Missing/excluded rows", shown(result.counts.missing)]];
  return {
    tables: [
      { id: "table_1", title: "Table 1. Baseline characteristics", columns: ["Characteristic", ...exposureGroups], rows: baselineRows },
      { id: "primary_results", title: "Primary statistical results", columns: ["Estimand", "Estimate"], rows: estimateRows },
      { id: "model_diagnostics", title: "Model diagnostics", columns: ["Diagnostic", "Value"], rows: diagnosticRows },
      { id: "sensitivity_analysis", title: "Sensitivity analysis", columns: ["Analysis", "Estimate"], rows: [[result.sensitivity.analysis, shown(result.sensitivity.estimate)]] },
    ],
    listings: [{ id: "cohort_flow", title: "Aggregate cohort flow", columns: ["Stage", "Count"], rows: flowRows, privacy: "aggregate_only" }],
    figures: [estimateFigure(result)],
  };
};
