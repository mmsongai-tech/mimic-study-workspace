import type { AggregateDataProfile } from "../variable-mapping/data-profile.js";
import type { StatisticalDiagnosticAssessment, StatisticalDiagnosticObservation, StatisticalMethodProfile } from "./analysis-plan.js";
import { assessStatisticalDiagnostics } from "./statistical-diagnostic-policy.js";

export interface MethodReadinessAssessment extends StatisticalDiagnosticAssessment {
  status: "ready" | "needs_confirmation" | "blocked";
  method_id: string;
  sample_size: number;
}

/** Evaluates method prerequisites from aggregate profiles; it never inspects or returns patient rows. */
export const assessMethodReadiness = (input: {
  method: StatisticalMethodProfile;
  profiles: Partial<Record<"population" | "exposure" | "predictor" | "outcome" | "covariate", AggregateDataProfile>>;
}): MethodReadinessAssessment => {
  const population = input.profiles.population;
  const outcome = input.profiles.outcome;
  const observations: StatisticalDiagnosticObservation[] = [
    { code: "cohort_reconciliation", state: population?.row_count ? "pass" : "fail", summary: population?.row_count ? `Aggregate cohort contains ${population.row_count} records.` : "No aggregate cohort records are available." },
    { code: "missingness", state: Object.values(input.profiles).some((profile) => (profile?.missing_count ?? 0) > 0) ? "warning" : "pass", summary: Object.values(input.profiles).some((profile) => (profile?.missing_count ?? 0) > 0) ? "At least one mapped variable contains missing values." : "No missing values were reported in the supplied profiles." },
    { code: "event_information", state: outcome && outcome.distinct_count >= 2 ? "pass" : "fail", summary: outcome && outcome.distinct_count >= 2 ? "Outcome profile contains at least two observed values." : "Outcome profile is missing or has no observed variation." },
  ];
  // C2 is a preflight, so only diagnostics actually computed from the supplied
  // aggregate profiles can block here; execution-time diagnostics remain pending.
  const preflightMethod = {
    ...input.method,
    blocking_diagnostic_codes: input.method.blocking_diagnostic_codes.filter((code) => observations.some((observation) => observation.code === code)),
  };
  const diagnostics = assessStatisticalDiagnostics(preflightMethod, observations);
  return {
    ...diagnostics,
    status: diagnostics.decision === "blocked" ? "blocked" : diagnostics.decision === "reportable_with_warnings" ? "needs_confirmation" : "ready",
    method_id: input.method.method_id,
    sample_size: population?.row_count ?? 0,
  };
};
