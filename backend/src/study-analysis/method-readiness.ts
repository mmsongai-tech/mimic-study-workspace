import type { AnalysisMethodOption } from "./method-registry.js";

/** Aggregate facts about an analysis dataset; computed before any method runs, never patient-level. */
export interface AnalysisDatasetProfile {
  rows: number;
  outcome_type: "binary" | "continuous" | "count" | "time_to_event";
  /** Binary outcome: the rarer level count; time-to-event: number of events. */
  events?: number;
  exposure_kind?: "binary" | "continuous" | "categorical";
  exposure_group_sizes?: number[];
  covariates: number;
  modifier_levels?: number[];
  has_mediator: boolean;
  predictors: number;
  has_time_to_event: boolean;
}

export interface MethodReadiness {
  method_id: string;
  available: boolean;
  reasons: Array<{ en: string; zh: string }>;
}

/** Checks one method's data requirements; unavailable options stay visible with their reasons. */
export const assessMethodReadiness = (method: AnalysisMethodOption, profile: AnalysisDatasetProfile): MethodReadiness => {
  const reasons: MethodReadiness["reasons"] = [];
  const need = method.requirements;
  if (profile.rows < need.min_rows) reasons.push({ en: `Needs at least ${need.min_rows} complete rows; ${profile.rows} are available.`, zh: `至少需要 ${need.min_rows} 例完整数据，目前 ${profile.rows} 例。` });
  // Event minimums only apply where events exist (binary and time-to-event outcomes).
  const eventOutcome = profile.outcome_type === "binary" || profile.outcome_type === "time_to_event";
  if (need.min_events !== undefined && eventOutcome && (profile.events ?? 0) < need.min_events) reasons.push({ en: `Needs at least ${need.min_events} events; ${profile.events ?? 0} are available.`, zh: `至少需要 ${need.min_events} 个结局事件，目前 ${profile.events ?? 0} 个。` });
  // A yes/no outcome that happens to nobody, or to everybody, has nothing to compare; every method would fail or print an empty test.
  if (profile.outcome_type === "binary" && profile.events !== undefined && profile.events === 0) reasons.push({ en: "The outcome does not vary: it happens to every patient or to none, so there is nothing to compare (check the outcome definition and window).", zh: "结局没有变化：所有患者都发生或都不发生，无从比较（请核对结局定义和时间窗）。" });
  if (need.needs_binary_exposure && profile.exposure_kind !== "binary") reasons.push({ en: "Needs a two-group (yes/no) exposure.", zh: "需要二分类（是/否）暴露。" });
  if (need.needs_binary_exposure && profile.exposure_group_sizes?.some((size) => size < 10)) reasons.push({ en: "Each exposure group needs at least 10 patients.", zh: "每个暴露组至少需要 10 例患者。" });
  if (need.needs_continuous_exposure && profile.exposure_kind !== "continuous") reasons.push({ en: "Needs a continuous exposure (a dose or level).", zh: "需要连续型暴露（剂量或水平）。" });
  if (need.needs_covariates && profile.covariates < 1) reasons.push({ en: "Needs at least one adjustment variable.", zh: "至少需要一个校正变量。" });
  if (need.needs_modifier && !(profile.modifier_levels && profile.modifier_levels.length >= 2 && profile.modifier_levels.every((size) => size >= 20))) reasons.push({ en: "Needs a modifier with at least two levels of 20 or more patients.", zh: "需要至少两个水平且每个水平不少于 20 例的效应修饰因素。" });
  if (need.needs_mediator && !profile.has_mediator) reasons.push({ en: "Needs a mapped mediator variable.", zh: "需要已映射的中介变量。" });
  if (need.needs_predictors && profile.predictors < need.needs_predictors) reasons.push({ en: `Needs at least ${need.needs_predictors} predictor(s).`, zh: `至少需要 ${need.needs_predictors} 个预测因子。` });
  if (need.needs_time_to_event && !profile.has_time_to_event) reasons.push({ en: "Needs follow-up time and event status.", zh: "需要随访时间与事件状态。" });
  return { method_id: method.method_id, available: reasons.length === 0, reasons };
};
