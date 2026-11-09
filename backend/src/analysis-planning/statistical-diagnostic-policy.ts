import type { StatisticalDiagnosticAssessment, StatisticalDiagnosticObservation, StatisticalMethodProfile } from "./analysis-plan.js";

export const assessStatisticalDiagnostics = (
  method: StatisticalMethodProfile,
  observations: StatisticalDiagnosticObservation[],
): StatisticalDiagnosticAssessment => {
  const byCode = new Map(observations.map((observation) => [observation.code, observation]));
  const blockingReasons = method.blocking_diagnostic_codes.flatMap((code) => {
    const observation = byCode.get(code);
    if (!observation || observation.state === "not_evaluated") return [`Required diagnostic was not evaluated: ${code}`];
    return observation.state === "fail" ? [`${code}: ${observation.summary}`] : [];
  });
  const warnings = observations
    .filter(({ state }) => state === "warning" || state === "fail")
    .filter(({ code, state }) => state !== "fail" || !method.blocking_diagnostic_codes.includes(code))
    .map(({ code, summary }) => `${code}: ${summary}`);
  return {
    decision: blockingReasons.length > 0 ? "blocked" : warnings.length > 0 ? "reportable_with_warnings" : "reportable",
    blocking_reasons: blockingReasons,
    warnings,
    observations: observations.map((observation) => ({ ...observation })),
  };
};

