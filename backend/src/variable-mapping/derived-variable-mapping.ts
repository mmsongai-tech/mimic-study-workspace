import { createHash } from "node:crypto";
import type { VariableMappingCandidate, VariableMappingRecord } from "./variable-mapping.js";
import type { MeasurementDifferenceDefinition } from "../research-design/index.js";

type DerivedAggregation = NonNullable<VariableMappingRecord["definition"]["aggregation"]>;
type DifferenceDirection = "follow_up_minus_baseline" | "baseline_minus_follow_up";

export interface DerivedVariableRequest {
  schema_version: "1.0.0";
  operator: "difference";
  requested_term: string;
  source_term: string;
  aggregation?: DerivedAggregation;
  directions: DifferenceDirection[];
}

/** New execution contracts carry operations explicitly, independent of language or labels. */
export const explicitDerivedVariableRequest = (requestedTerm: string, definition: MeasurementDifferenceDefinition): DerivedVariableRequest => ({
  schema_version: "1.0.0", operator: definition.operator, requested_term: requestedTerm,
  source_term: definition.source_concept, aggregation: definition.aggregation, directions: [definition.direction],
});

const aggregationFromContext = (value: string): DerivedAggregation | undefined => {
  if (/(?:\bfirst\b|首次|首个|第一(?:个|次))/iu.test(value)) return "first";
  if (/(?:\blast\b|末次|最后(?:一个|一次)?)/iu.test(value)) return "last";
  if (/(?:\bmean\b|\baverage\b|平均)/iu.test(value)) return "mean";
  if (/(?:\bmedian\b|中位)/iu.test(value)) return "median";
  if (/(?:\bmaximum\b|\bmax\b|最大|最高)/iu.test(value)) return "maximum";
  if (/(?:\bminimum\b|\bmin\b|最小|最低)/iu.test(value)) return "minimum";
  return undefined;
};

/** Parses only generic measurement operations; clinical concepts remain data-driven. */
export const parseDerivedVariableRequest = (input: { concept: string; context: string; aggregation?: DerivedAggregation }): DerivedVariableRequest | undefined => {
  const normalized = input.concept.normalize("NFKC").trim().toLocaleLowerCase();
  const match = normalized.match(/^(.*?)(?:[_\s-]+)(absolute[_\s-]+change|change|delta|reduction|decrease|increase)$/u);
  const source = match?.[1]?.replace(/[_-]+/gu, " ").trim();
  if (!match || !source) return undefined;
  const semanticContext = `${input.concept} ${input.context}`;
  const directions: DifferenceDirection[] = /(?:reduction|decrease|lowering|降低|下降|减少)/iu.test(semanticContext)
    ? ["baseline_minus_follow_up"]
    : /(?:increase|rise|升高|上升|增加)/iu.test(semanticContext)
      ? ["follow_up_minus_baseline"]
      : ["follow_up_minus_baseline", "baseline_minus_follow_up"];
  const aggregation = input.aggregation ?? aggregationFromContext(input.context);
  return {
    schema_version: "1.0.0",
    operator: "difference",
    requested_term: input.concept,
    source_term: source,
    ...(aggregation ? { aggregation } : {}),
    directions,
  };
};

const directionLabel = (direction: DifferenceDirection): { en: string; zh: string } => direction === "baseline_minus_follow_up"
  ? { en: "baseline minus follow-up", zh: "基线减随访" }
  : { en: "follow-up minus baseline", zh: "随访减基线" };

/** Wraps verified raw measurements in a versioned fixed derivation without changing source evidence. */
export const createDerivedVariableCandidates = (candidate: VariableMappingCandidate, request: DerivedVariableRequest): VariableMappingCandidate[] => {
  const sourceEvidenceAvailable = Boolean(candidate.mapping.evidence.dictionary_entries?.length || candidate.mapping.evidence.data_profile || ["validated", "clinician_confirmed", "model_reviewed"].includes(candidate.mapping.status));
  if (!sourceEvidenceAvailable) return [];
  const existing = candidate.mapping.definition.derivation;
  if (existing) return existing.operator === request.operator && request.directions.includes(existing.direction) ? [candidate] : [];
  const aggregation = request.aggregation;
  if (!aggregation || candidate.mapping.value_type !== "continuous") return [];
  // A fixed transform of a team-validated or clinician-confirmed measurement inherits that status; its windows and
  // aggregation are explicit in the StudySpec and reported as assumptions. Other sources still need confirmation.
  const trustedSource = candidate.mapping.status === "validated" || candidate.mapping.status === "clinician_confirmed";
  return request.directions.map((direction) => {
    const label = directionLabel(direction);
    // The source version is part of the identity so a revised source (e.g. a new plausible range) yields a new derivation.
    const identity = createHash("sha256").update(JSON.stringify([candidate.mapping.mapping_id, candidate.mapping.mapping_version, request.operator, aggregation, direction])).digest("hex").slice(0, 20);
    const mapping: VariableMappingRecord = {
      ...candidate.mapping,
      mapping_id: `mimic-iv.derived.${identity}.v1`,
      concept_id: `derived_${identity}`,
      mapping_version: "1.0.0",
      labels: {
        en: `${candidate.mapping.labels.en} · ${label.en} (${aggregation})`,
        ...(candidate.mapping.labels.zh ? { zh: `${candidate.mapping.labels.zh} · ${label.zh}（${aggregation}）` } : {}),
      },
      synonyms: [...new Set([...candidate.mapping.synonyms, request.requested_term])],
      definition: {
        ...candidate.mapping.definition,
        summary: `${candidate.mapping.definition.summary}; fixed ${label.en} derivation using ${aggregation} values in each window.`,
        temporal_rule: "Use the frozen baseline and follow-up windows from StudySpec.",
        value_rule: `${label.en} on the original measurement scale.`,
        derivation: {
          schema_version: "1.0.0",
          operator: "difference",
          baseline: { purpose: "baseline", aggregation },
          follow_up: { purpose: "follow_up", aggregation },
          direction,
        },
      },
      status: trustedSource ? candidate.mapping.status : candidate.mapping.status === "discovered" ? "discovered" : "database_verified",
      provenance: "realtime_discovery",
      evidence: { ...candidate.mapping.evidence, derived_from: { mapping_id: candidate.mapping.mapping_id, mapping_version: candidate.mapping.mapping_version } },
    };
    return {
      ...candidate,
      candidate_id: `candidate:${mapping.mapping_id}`,
      requested_term: request.requested_term,
      mapping,
      confidence: candidate.confidence === "high" ? "medium" : candidate.confidence,
      requires_clinician_confirmation: !trustedSource,
      explanation: trustedSource
        ? `Fixed ${label.en} of a ${candidate.mapping.status} measurement using the StudySpec windows and ${aggregation} values.`
        : `A real source measurement was found. Confirm the source, windows, aggregation, and ${label.en} direction before execution.`,
    };
  });
};
