import type { LactateMortalityGateway } from "./lactate-mortality-gateway.js";

export class SyntheticLactateMortalityGateway implements LactateMortalityGateway {
  async load() {
    return {
      records: [
        { synthetic_subject_id: "SYN-001", max_lactate_first_6h: 1.2, in_hospital_death: false },
        { synthetic_subject_id: "SYN-002", max_lactate_first_6h: 1.7, in_hospital_death: false },
        { synthetic_subject_id: "SYN-003", max_lactate_first_6h: 1.9, in_hospital_death: true },
        { synthetic_subject_id: "SYN-004", max_lactate_first_6h: 2.4, in_hospital_death: false },
        { synthetic_subject_id: "SYN-005", max_lactate_first_6h: 3.1, in_hospital_death: true },
        { synthetic_subject_id: "SYN-006", max_lactate_first_6h: 4.6, in_hospital_death: true },
      ],
      provenance: {
        data_source_id: "synthetic-lactate-mortality-fixture",
        data_source_version: "1.0.0",
        data_mode: "synthetic" as const,
        retrieved_at: "2026-08-31T00:00:00.000Z",
      },
    };
  }
}
