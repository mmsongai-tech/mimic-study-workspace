import type { AssociationInput, AssociationAnalysisResult } from "../domain/association-analysis.js";
import { AssociationAnalysisError } from "../domain/association-analysis.js";

export const executeCrudeLactateAssociation = (
  input: AssociationInput,
  studyIntegrityId: string,
  threshold: number,
): AssociationAnalysisResult => {
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new AssociationAnalysisError("ANALYSIS_INPUT_INVALID", "The lactate threshold is invalid.");
  }
  const valid = input.records.filter((record) =>
    Number.isFinite(record.max_lactate_first_6h) && typeof record.in_hospital_death === "boolean");
  const exposed = valid.filter((record) => record.max_lactate_first_6h > threshold);
  const unexposed = valid.filter((record) => record.max_lactate_first_6h <= threshold);
  if (exposed.length === 0 || unexposed.length === 0) {
    throw new AssociationAnalysisError("ANALYSIS_INPUT_INVALID", "Both exposure groups require observations.");
  }
  const exposedEvents = exposed.filter((record) => record.in_hospital_death).length;
  const unexposedEvents = unexposed.filter((record) => record.in_hospital_death).length;
  const exposedNonEvents = exposed.length - exposedEvents;
  const unexposedNonEvents = unexposed.length - unexposedEvents;
  const hasZeroCell = [exposedEvents, exposedNonEvents, unexposedEvents, unexposedNonEvents]
    .some((value) => value === 0);
  const correction = hasZeroCell ? 0.5 : 0;
  const a = exposedEvents + correction;
  const b = exposedNonEvents + correction;
  const c = unexposedEvents + correction;
  const d = unexposedNonEvents + correction;
  const oddsRatio = (a * d) / (b * c);
  const standardError = Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
  const logOddsRatio = Math.log(oddsRatio);
  return {
    capability_id: "association.lactate.in_hospital_mortality.v1",
    study_integrity_id: studyIntegrityId,
    threshold_mmol_l: threshold,
    counts: {
      total: valid.length,
      exposed: exposed.length,
      unexposed: unexposed.length,
      exposed_events: exposedEvents,
      unexposed_events: unexposedEvents,
    },
    estimates: {
      exposed_risk: exposedEvents / exposed.length,
      unexposed_risk: unexposedEvents / unexposed.length,
      risk_difference: exposedEvents / exposed.length - unexposedEvents / unexposed.length,
      odds_ratio: oddsRatio,
      odds_ratio_ci_95: [
        Math.exp(logOddsRatio - 1.96 * standardError),
        Math.exp(logOddsRatio + 1.96 * standardError),
      ],
    },
    method: {
      id: "crude_binary_association",
      version: "1.0.0",
      zero_cell_correction: "haldane_anscombe_if_needed",
    },
    provenance: input.provenance,
    warnings: [
      "Synthetic fixture result; not clinical or real-data evidence.",
      "Crude association does not establish a causal treatment effect.",
    ],
  };
};
