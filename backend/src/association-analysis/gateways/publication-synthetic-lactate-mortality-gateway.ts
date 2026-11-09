import type { LactateMortalityGateway } from "./lactate-mortality-gateway.js";

export class PublicationSyntheticLactateMortalityGateway implements LactateMortalityGateway {
  async load() {
    const records = Array.from({ length: 1_000 }, (_, index) => {
      const position = index + 1;
      const lactate = 1 + ((position * 13) % 50) / 10;
      const riskScore = (position * 11) % 10;
      return {
        synthetic_subject_id: `PUBLICATION-SYN-${String(position).padStart(4, "0")}`,
        max_lactate_first_6h: lactate,
        in_hospital_death: riskScore < (lactate > 2 ? 4 : 2),
        age_years: 40 + ((position * 7) % 45),
        sex: position % 2 === 0 ? "female" as const : "male" as const,
      };
    });
    return {
      records,
      provenance: {
        data_source_id: "publication-synthetic-lactate-mortality-fixture",
        data_source_version: "3.0.0",
        data_mode: "synthetic" as const,
        retrieved_at: "2026-08-31T00:00:00.000Z",
      },
    };
  }
}
