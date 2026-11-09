import type { PredictionGateway } from "../domain/prediction-analysis.js";

const logistic = (value: number): number => 1 / (1 + Math.exp(-value));

export class PublicationSyntheticVentilationGateway implements PredictionGateway {
  async load() {
    const records = Array.from({ length: 1_000 }, (_, index) => {
      const position = index + 1;
      const age = 35 + ((position * 17) % 55);
      const respiratoryRate = 12 + ((position * 11) % 26);
      const ratio = 90 + ((position * 37) % 330);
      const gcs = 5 + ((position * 7) % 11);
      const probability = logistic(-3.6 + 0.018 * (age - 60) + 0.11 * (respiratoryRate - 20) - 0.006 * (ratio - 200) - 0.18 * (gcs - 10));
      const deterministicUniform = ((position * 7919) % 1000) / 1000;
      return {
        synthetic_subject_id: `VENT-SYN-${String(position).padStart(4, "0")}`,
        age_years: age,
        respiratory_rate: respiratoryRate,
        spo2_fio2_ratio: ratio,
        gcs,
        invasive_ventilation_24h: deterministicUniform < probability,
      };
    });
    return { records, provenance: { data_source_id: "publication-synthetic-ventilation-fixture", data_source_version: "1.0.0", data_mode: "synthetic" as const, retrieved_at: "2026-08-31T00:00:00.000Z" } };
  }
}

