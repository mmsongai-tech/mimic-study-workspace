import type { TreatmentEffectGateway } from "../domain/treatment-effect-analysis.js";

const logistic = (value: number): number => 1 / (1 + Math.exp(-value));

export class PublicationSyntheticVasopressorGateway implements TreatmentEffectGateway {
  async load() {
    const records = Array.from({ length: 1_000 }, (_, index) => {
      const position = index + 1;
      const age = 40 + ((position * 13) % 48);
      const sofa = 3 + ((position * 7) % 15);
      const lactate = 1 + ((position * 19) % 65) / 10;
      const female = position % 2 === 0;
      const treatmentProbability = logistic(-2.1 + 0.13 * sofa + 0.22 * lactate + 0.006 * (age - 60));
      const early = ((position * 3571) % 1000) / 1000 < treatmentProbability;
      const deathProbability = logistic(-4.2 + 0.16 * sofa + 0.23 * lactate + 0.018 * (age - 60) - 0.28 * Number(early));
      const death = ((position * 6271 + 113) % 1000) / 1000 < deathProbability;
      return {
        synthetic_subject_id: `VASO-SYN-${String(position).padStart(4, "0")}`,
        early_vasopressor: early,
        in_hospital_death: death,
        age_years: age,
        sofa_score: sofa,
        baseline_lactate: lactate,
        sex: female ? "female" as const : "male" as const,
      };
    });
    return { records, provenance: { data_source_id: "publication-synthetic-vasopressor-fixture", data_source_version: "1.0.0", data_mode: "synthetic" as const, retrieved_at: "2026-08-31T00:00:00.000Z" } };
  }
}
