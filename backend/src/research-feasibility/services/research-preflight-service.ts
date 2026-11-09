import type {
  PreflightInput,
  PreflightResult,
  ResearchCapability,
} from "../domain/preflight.js";

const normalize = (value: string): string => value.trim().toLowerCase().replaceAll(/[_-]+/gu, " ");

const includesConcept = (value: string, concepts: string[]): boolean => {
  const normalized = normalize(value);
  return concepts.some((concept) => normalized.includes(normalize(concept)));
};

export class ResearchPreflightService {
  constructor(private readonly capabilities: ResearchCapability[]) {}

  check(input: PreflightInput): PreflightResult {
    const base = {
      confirmed_study_integrity_id: input.study.integrity_id,
      data_source: {
        id: input.data_source.id,
        version: input.data_source.version,
        data_mode: input.data_source.data_mode,
      },
      evidence_class: "catalog_match" as const,
    };
    if (!input.study.spec.analysis_family) {
      return {
        ...base,
        status: "unsupported",
        missing_requirements: ["A registered executable StudySpec is required."],
        warnings: ["The study was not converted to another research intent."],
      };
    }

    const exposureText = input.study.spec.exposure_or_predictors?.map(({ name, operational_definition }) =>
      `${name} ${operational_definition}`).join(" ") ?? "";
    const outcomeText = input.study.spec.outcome
      ? `${input.study.spec.outcome.name} ${input.study.spec.outcome.operational_definition}`
      : "";
    const capability = this.capabilities.find((candidate) =>
      candidate.intent_family === input.study.spec.intent_family &&
      candidate.analysis_family === input.study.spec.analysis_family &&
      includesConcept(exposureText, candidate.exposure_concepts) &&
      includesConcept(outcomeText, candidate.outcome_concepts));
    if (!capability) {
      return {
        ...base,
        status: "unsupported",
        missing_requirements: ["No registered capability matches the confirmed exposure and outcome."],
        warnings: ["The original study remains saved and was not silently converted."],
      };
    }

    const summaryMeasure = normalize(input.study.spec.estimand?.summary_measure ?? "");
    const unsupportedMethod = capability.unsupported_summary_measure_terms.find((term) =>
      summaryMeasure.includes(normalize(term)));
    if (unsupportedMethod) {
      return {
        ...base,
        status: "unsupported",
        capability_id: capability.id,
        missing_requirements: [`The registered executor does not support: ${unsupportedMethod}.`],
        warnings: ["The requested method was preserved and was not replaced by a crude analysis."],
      };
    }

    const available = new Set(input.data_source.available_concepts.map(normalize));
    const missing = capability.required_data_concepts.filter((concept) => !available.has(normalize(concept)));
    return {
      ...base,
      status: missing.length ? "unsupported" : "supported",
      capability_id: capability.id,
      missing_requirements: missing.map((concept) => `Missing data concept: ${concept}`),
      warnings: ["Catalog support does not prove statistical validity or successful execution."],
    };
  }
}
