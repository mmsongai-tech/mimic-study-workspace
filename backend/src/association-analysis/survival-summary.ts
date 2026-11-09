export interface SurvivalRecord { duration: number; event: boolean; group: "exposed" | "unexposed"; }
export interface SurvivalGroupSummary { n: number; events: number; censored: number; median_survival: number | null; survival_at: Record<string, number>; }
export interface SurvivalSummaryResult { schema_version: "1.0.0"; status: "completed"; method_id: "kaplan_meier_summary.v1"; groups: Record<"exposed" | "unexposed", SurvivalGroupSummary>; diagnostics: { invalid_records: number; time_origin: "recorded_duration"; proportional_hazards: "not_evaluated" }; model: { estimand: string; limitations: string[] }; }

const summarize = (records: SurvivalRecord[]): SurvivalGroupSummary => {
  const ordered = [...records].sort((a, b) => a.duration - b.duration);
  let atRisk = ordered.length; let survival = 1; let median: number | null = null;
  const survival_at: Record<string, number> = {};
  for (const record of ordered) {
    if (record.event) { survival *= (atRisk - 1) / atRisk; if (median === null && survival <= 0.5) median = record.duration; }
    atRisk -= 1;
  }
  for (const horizon of [7, 28, 90]) {
    let risk = 1; let remaining = ordered.length;
    for (const record of ordered) { if (record.duration > horizon) break; if (record.event) risk *= (remaining - 1) / remaining; remaining -= 1; }
    survival_at[String(horizon)] = risk;
  }
  return { n: records.length, events: records.filter(({ event }) => event).length, censored: records.filter(({ event }) => !event).length, median_survival: median, survival_at };
};

export const executeKaplanMeierSummary = (records: readonly SurvivalRecord[]): SurvivalSummaryResult => {
  const valid = records.filter(({ duration }) => Number.isFinite(duration) && duration >= 0);
  const groups = { exposed: valid.filter(({ group }) => group === "exposed"), unexposed: valid.filter(({ group }) => group === "unexposed") };
  if (!groups.exposed.length || !groups.unexposed.length) throw new Error("Both survival groups must contain valid records.");
  return { schema_version: "1.0.0", status: "completed", method_id: "kaplan_meier_summary.v1", groups: { exposed: summarize(groups.exposed), unexposed: summarize(groups.unexposed) }, diagnostics: { invalid_records: records.length - valid.length, time_origin: "recorded_duration", proportional_hazards: "not_evaluated" }, model: { estimand: "Group-specific survival probabilities and median survival", limitations: ["Descriptive Kaplan–Meier summary; no covariate adjustment or hazard ratio.", "Proportional-hazards and censoring assumptions require execution-time diagnostics."] } };
};
