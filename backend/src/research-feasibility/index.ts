import { ResearchPreflightService } from "./services/research-preflight-service.js";

export const createInitialResearchPreflightService = (): ResearchPreflightService =>
  new ResearchPreflightService([
    {
      id: "association.lactate.in_hospital_mortality.v1",
      intent_family: "association",
      analysis_family: "association",
      exposure_concepts: ["lactate", "乳酸", "血乳酸"],
      outcome_concepts: ["in-hospital mortality", "hospital mortality", "院内死亡", "住院死亡"],
      required_data_concepts: [
        "icu_admission_time",
        "lactate_measurement",
        "hospital_discharge_status",
      ],
      unsupported_summary_measure_terms: ["adjusted", "multivariable", "adjusted odds ratio"],
    },
    {
      id: "prediction.invasive_ventilation_24h.v1",
      intent_family: "prediction",
      analysis_family: "binary_prediction",
      exposure_concepts: ["age", "respiratory rate", "spo2/fio2", "glasgow coma scale"],
      outcome_concepts: ["invasive mechanical ventilation within 24 hours", "invasive ventilation within 24 hours"],
      required_data_concepts: ["icu_admission_time", "age", "respiratory_rate", "spo2_fio2_ratio", "gcs", "invasive_ventilation_start"],
      unsupported_summary_measure_terms: ["external validation", "deep learning"],
    },
    {
      id: "treatment_effect.early_vasopressor.in_hospital_mortality.v1",
      intent_family: "treatment_effect",
      analysis_family: "propensity_weighted_treatment_effect",
      exposure_concepts: ["early vasopressor initiation", "vasopressor"],
      outcome_concepts: ["in-hospital mortality", "hospital mortality"],
      required_data_concepts: ["icu_admission_time", "hypotension_time", "vasopressor_start", "hospital_discharge_status", "age", "sex", "sofa", "lactate"],
      unsupported_summary_measure_terms: ["instrumental variable", "target trial emulation"],
    },
  ]);

export type {
  DataSourceDescriptor,
  PreflightInput,
  PreflightResult,
  ResearchCapability,
} from "./domain/preflight.js";
export * from "./data-feasibility.js";
