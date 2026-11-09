import type { StudySpec } from "../research-design/study-spec.js";
import { buildMethodOptions, type AnalysisMethodOption } from "./method-options.js";
import { selectStatisticalMethod } from "./statistical-method-catalog.js";

export interface MethodDataEvidence { complete_rows?: number; outcome_events?: number; outcome_non_events?: number; missing_fraction?: number; has_time_origin?: boolean; }
export interface MethodDecision { method: ReturnType<typeof selectStatisticalMethod>; options: AnalysisMethodOption[]; blocking_reasons: string[]; warnings: string[]; }

export const decideStatisticalMethods = (study: StudySpec, evidence: MethodDataEvidence, registeredMethodIds: readonly string[] = []): MethodDecision => {
  const method = selectStatisticalMethod(study); const blocking: string[] = []; const warnings: string[] = [];
  if (!evidence.complete_rows || evidence.complete_rows < 1) blocking.push("The confirmed manifest produced no complete analysis rows.");
  if (method.outcome_structure === "binary" && (evidence.outcome_events === 0 || evidence.outcome_non_events === 0)) blocking.push("A binary outcome requires both event and non-event records.");
  if ((method.outcome_structure === "time_to_event" || method.outcome_structure === "competing_risk") && evidence.has_time_origin === false) blocking.push("A time-to-event method requires a confirmed time origin.");
  if (evidence.missing_fraction !== undefined && evidence.missing_fraction > 0.2) warnings.push("More than 20% of candidate records are incomplete; the missing-data strategy requires review.");
  const primaryAvailable = blocking.length === 0 && registeredMethodIds.includes(`${method.method_id}.primary`);
  if (!primaryAvailable) warnings.push("The primary method is not executable until its registered executor and data prerequisites are confirmed.");
  return { method, options: buildMethodOptions({ method, primary_available: primaryAvailable, available_method_ids: registeredMethodIds }), blocking_reasons: blocking, warnings };
};
