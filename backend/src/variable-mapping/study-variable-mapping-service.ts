import { listStudyConditions, type StudyCondition, type StudySpec } from "../research-design/index.js";
import type { MappingCandidateEvidenceReview, VariableMappingAssessment, VariableMappingCandidate, VariableMappingRecord } from "./variable-mapping.js";
import { semanticCodeHintCoverage, VariableMappingError } from "./variable-mapping.js";
import type { VariableMappingRepository } from "./variable-mapping-repository.js";
import type { VariableMappingDiscoveryService } from "./variable-mapping-discovery-service.js";
import type { VariableMappingLifecycleService } from "./variable-mapping-lifecycle-service.js";
import type { VariableMappingVerificationService } from "./variable-mapping-verification-service.js";
import type { MappingEvidenceProfiler } from "./local-archive-mapping-evidence-profiler.js";
import { applyMappingCandidateReview, mappingCandidateEvidenceDigest, mappingCandidateEvidenceSummary, type MappingCandidateReviewer, type MappingCandidateReviewInput } from "./mapping-candidate-review.js";
import { createDerivedVariableCandidates, explicitDerivedVariableRequest, type DerivedVariableRequest } from "./derived-variable-mapping.js";
import { projectAnalysisObjective } from "../research-design/index.js";

export interface StudyVariableMappingReview {
  schema_version: "1.0.0";
  status: "ready" | "needs_confirmation" | "blocked";
  variables: Array<VariableMappingAssessment & { role: VariableMappingCandidate["role"]; condition_id?: string; semantic_condition?: StudyCondition; objective_id?: string }>;
  summary: { resolved: number; needs_confirmation: number; unmapped: number };
  verification_available: boolean;
}

type MappingTarget = { term: string; search_term?: string; dictionary_code_hints?: string[]; role: VariableMappingCandidate["role"]; expected_value_type?: VariableMappingRecord["value_type"] | undefined; condition_id?: string; semantic_condition?: StudyCondition; derivation?: DerivedVariableRequest };
const contextualTerm = (...parts: string[]): string => parts.filter(Boolean).join(". ").slice(0, 120);

const conditionTargets = (condition: StudyCondition | undefined, role: VariableMappingCandidate["role"]): MappingTarget[] => condition
  ? listStudyConditions(condition).filter(({ kind }) => !["all", "any", "not"].includes(kind)).map((leaf) => {
    const term = "concept" in leaf ? leaf.concept : leaf.source_text;
    // English dictionaries cannot match Chinese source text; an English concept is searched on its own.
    const latinConceptFromHan = /\p{Script=Latin}/u.test(term) && !/\p{Script=Han}/u.test(term) && /\p{Script=Han}/u.test(leaf.source_text);
    return { term, search_term: latinConceptFromHan ? term : contextualTerm(term, leaf.source_text), role, condition_id: leaf.condition_id, semantic_condition: leaf, ...(leaf.kind === "category_comparison" ? { dictionary_code_hints: leaf.values } : {}) };
  })
  : [];

const namedConditionTargets = (name: string, condition: StudyCondition, role: VariableMappingCandidate["role"]): MappingTarget[] => {
  const targets = conditionTargets(condition, role);
  return targets.length === 1 ? [{ ...targets[0]!, term: name }] : targets;
};

const conditionValueType = (condition: StudyCondition | undefined): VariableMappingRecord["value_type"] | undefined => {
  if (condition?.kind === "numeric_comparison") return "continuous";
  if (condition?.kind === "category_comparison") return "categorical";
  if (condition?.kind === "event_exists") return "binary";
  return undefined;
};
const enrichVariableTarget = (target: MappingTarget, variable: NonNullable<StudySpec["outcome"]>, fallbackValueType?: VariableMappingRecord["value_type"]): MappingTarget => {
  const derivation = variable.derivation ? explicitDerivedVariableRequest(variable.name, variable.derivation) : undefined;
  return {
    ...target,
    expected_value_type: fallbackValueType ?? conditionValueType(target.semantic_condition),
    search_term: derivation?.source_term ?? target.search_term ?? contextualTerm(target.term, variable.operational_definition),
    ...(derivation ? { derivation } : {}),
  };
};

const variables = (spec: StudySpec): MappingTarget[] => {
  const targets: MappingTarget[] = [];
  if (spec.population?.criteria) targets.push(...conditionTargets(spec.population.criteria, "population"));
  else if (spec.population) targets.push({ term: spec.population.description, role: "population" });
  if (spec.index_time) targets.push({ term: spec.index_time.event, search_term: contextualTerm(spec.index_time.event, spec.index_time.selection_rule), role: "index_time" });
  for (const variable of spec.exposure_or_predictors ?? []) {
    const role = variable.role === "predictor" ? "predictor" : "exposure";
    // A summed amount (a dose) is a continuous measurement, so a drug-class presence mapping cannot stand in for it.
    const expected_value_type = variable.contrast?.kind === "binary_presence" || variable.definition?.kind === "category_comparison" ? "binary" as const
      : variable.contrast?.kind === "as_recorded" && variable.aggregation === "sum" ? "continuous" as const : undefined;
    if (variable.definition) targets.push(...namedConditionTargets(variable.name, variable.definition, role).map((target) => enrichVariableTarget(target, variable, expected_value_type))); else targets.push({ term: variable.name, role, expected_value_type });
  }
  if (spec.outcome?.definition) {
    const outcome = spec.outcome;
    const definition = spec.outcome.definition;
    const fallback = definition.kind === "any" || definition.kind === "all" ? undefined : spec.outcome_structure === "binary" ? "binary" as const : spec.outcome_structure === "continuous" ? "continuous" as const : undefined;
    targets.push(...namedConditionTargets(outcome.name, definition, "outcome").map((target) => enrichVariableTarget(target, outcome, fallback)));
  }
  else if (spec.outcome) targets.push({ term: spec.outcome.name, role: "outcome", expected_value_type: spec.outcome_structure === "binary" ? "binary" : undefined });
  for (const variable of spec.covariates ?? []) {
    if (variable.definition) targets.push(...namedConditionTargets(variable.name, variable.definition, "covariate").map((target) => ({ ...target, search_term: target.search_term ?? contextualTerm(target.term, variable.operational_definition) }))); else targets.push({ term: variable.name, role: "covariate" });
  }
  // A description's characteristics are mapped by what they are: an outcome-type concept (death, length of stay) as an outcome, any
  // other as a baseline variable, so the usual category rules apply; their condition ids keep them apart from the plan's own variables.
  for (const variable of spec.characteristics ?? []) {
    const role = variable.role === "outcome" ? "outcome" as const : "covariate" as const;
    if (variable.definition) targets.push(...namedConditionTargets(variable.name, variable.definition, role).map((target) => enrichVariableTarget(target, variable)));
    else targets.push({ term: variable.name, role });
  }
  return targets;
};

/**
 * The labels of a verified drug-label set that name the requested drug: they contain the name, or are a truncation
 * of it of at least six letters ("Metoprol"). Undefined unless most of the set names the drug.
 */
const nameContainedMedicationSet = (requestedTerm: string, candidate: VariableMappingCandidate | undefined): VariableMappingCandidate | undefined => {
  const name = requestedTerm.trim().toLocaleLowerCase();
  if (!candidate || name.length < 4 || !/^[a-z][a-z0-9 -]+$/u.test(name) || candidate.mapping.status !== "database_verified") return undefined;
  const source = candidate.mapping.sources.find(({ kind }) => kind === "medication_label");
  const labels = source?.value_filters?.flatMap(({ values }) => values) ?? [];
  const names = (label: string): boolean => { const text = label.trim().toLocaleLowerCase(); return text.includes(name) || (text.length >= 6 && name.startsWith(text)); };
  const kept = labels.filter(names);
  if (!source || !kept.length || kept.length < 0.8 * labels.length) return undefined;
  return { ...candidate, requires_clinician_confirmation: false, explanation: "Every kept verified label names the requested drug; accepted by rule after the automated review returned an invalid selection.",
    mapping: { ...candidate.mapping, sources: candidate.mapping.sources.map((item) => item === source ? { ...item, value_filters: [{ column: "drug", values: kept }] } : item) } };
};

export class StudyVariableMappingService {
  private readonly assessmentCache = new Map<string, Promise<StudyVariableMappingReview>>();
  private readonly candidateReviewCache = new Map<string, Promise<MappingCandidateEvidenceReview>>();
  /** Forgets earlier assessments, for a run that has just added a variable definition and must see it. */
  forgetAssessments(): void { this.assessmentCache.clear(); this.candidateReviewCache.clear(); }

  constructor(private readonly dependencies: {
    discovery: VariableMappingDiscoveryService;
    mappings: VariableMappingRepository;
    lifecycle: VariableMappingLifecycleService;
    verification?: VariableMappingVerificationService;
    evidenceProfiler?: MappingEvidenceProfiler;
    candidateReviewer?: MappingCandidateReviewer;
    onExecutableMapping?: (mapping: VariableMappingRecord) => void;
  }) {}

  private reviewCandidateEvidence(input: MappingCandidateReviewInput): Promise<MappingCandidateEvidenceReview> {
    const key = mappingCandidateEvidenceDigest(input);
    const cached = this.candidateReviewCache.get(key);
    if (cached) return cached;
    const review = this.dependencies.candidateReviewer!.review(input);
    this.candidateReviewCache.set(key, review);
    void review.catch(() => {
      if (this.candidateReviewCache.get(key) === review) this.candidateReviewCache.delete(key);
    });
    return review;
  }

  async assess(spec: StudySpec, allowLiveSearch = false): Promise<StudyVariableMappingReview> {
    const cacheKey = `${allowLiveSearch ? "live" : "catalog"}:${JSON.stringify(spec)}`;
    const cached = this.assessmentCache.get(cacheKey);
    if (cached) return structuredClone(await cached);
    const assessment = this.assessUncached(spec, allowLiveSearch);
    this.assessmentCache.set(cacheKey, assessment);
    try {
      const result = await assessment;
      if (allowLiveSearch) this.assessmentCache.delete(`catalog:${JSON.stringify(spec)}`);
      return structuredClone(result);
    } catch (error) { this.assessmentCache.delete(cacheKey); throw error; }
  }

  private async assessUncached(spec: StudySpec, allowLiveSearch: boolean): Promise<StudyVariableMappingReview> {
    if (spec.analysis_objectives) {
      const variables: StudyVariableMappingReview["variables"] = [];
      const sharedKeys = new Set<string>();
      let verificationAvailable = true;
      for (const objective of spec.analysis_objectives.objectives) {
        if (objective.status === "blocked") continue;
        const review = await this.assess(projectAnalysisObjective(spec, objective), allowLiveSearch);
        verificationAvailable &&= review.verification_available;
        for (const variable of review.variables) {
          const key = JSON.stringify([variable.role, variable.condition_id, variable.requested_term]);
          if (variable.role !== "outcome" && sharedKeys.has(key)) continue;
          sharedKeys.add(key);
          variables.push({ ...variable, ...(variable.role === "outcome" ? { objective_id: objective.objective_id } : {}) });
        }
      }
      const summary = { resolved: variables.filter(({ status }) => status === "resolved").length,
        needs_confirmation: variables.filter(({ status }) => status === "needs_confirmation").length,
        unmapped: variables.filter(({ status }) => status === "unmapped").length };
      return { schema_version: "1.0.0", status: !variables.length || summary.unmapped ? "blocked" : summary.needs_confirmation ? "needs_confirmation" : "ready", variables, summary, verification_available: verificationAvailable };
    }
    const targets = variables(spec);
    const results = await Promise.all(targets.map(async ({ term, search_term, dictionary_code_hints, role, expected_value_type, condition_id, semantic_condition, derivation }) => {
      const search = (requestedTerm: string, live: boolean, allowTermExpansion = true) => this.dependencies.discovery.search({ term: requestedTerm, role, expected_value_type, ...(dictionary_code_hints ? { dictionary_code_hints } : {}), allow_live_search: live, allow_term_expansion: allowTermExpansion, ...(derivation ? {} : { exclude_derived: true }) });
      let assessment = await search(search_term ?? term, false);
      if (search_term && assessment.status !== "resolved") {
        const canonical = await search(term, false);
        if (canonical.status === "resolved" || (!assessment.candidates.length && canonical.candidates.length)) assessment = canonical;
      }
      if (allowLiveSearch && assessment.status !== "resolved") {
        assessment = await search(search_term ?? term, true, !derivation);
        if (derivation && !assessment.candidates.length) assessment = await search(search_term ?? term, true, true);
        if (!derivation && search_term && assessment.status !== "resolved") {
          const canonical = await search(term, true);
          if (canonical.status === "resolved" || (!assessment.candidates.length && canonical.candidates.length)) assessment = canonical;
        }
      }
      if (derivation) {
        const derivedCandidates = derivation.aggregation
          ? [...new Map(assessment.candidates
            .flatMap((candidate) => createDerivedVariableCandidates(candidate, derivation))
            .map((candidate) => [candidate.candidate_id, candidate] as const)).values()]
          : [];
        for (const candidate of derivedCandidates) {
          await this.dependencies.mappings.save(candidate.mapping);
          const stored = await this.dependencies.mappings.findById(candidate.mapping.mapping_id);
          if (stored) {
            candidate.mapping = stored;
            if (["model_reviewed", "clinician_confirmed", "validated"].includes(stored.status)) {
              candidate.requires_clinician_confirmation = false;
            }
          }
        }
        const resolved = derivedCandidates.some((candidate) => !candidate.requires_clinician_confirmation && ["validated", "clinician_confirmed", "model_reviewed"].includes(candidate.mapping.status));
        assessment = {
          ...assessment,
          status: resolved ? "resolved" : derivedCandidates.length ? "needs_confirmation" : "unmapped",
          candidates: derivedCandidates,
          ...(!derivedCandidates.length ? { reason: derivation.aggregation ? `No continuous source measurement was found for ${derivation.source_term}.` : `A fixed aggregation is required for derived change ${term}.` } : {}),
        };
      }
      assessment.requested_term = term;
      for (const candidate of assessment.candidates) candidate.requested_term = term;
      return { ...assessment, role, ...(condition_id ? { condition_id } : {}), ...(semantic_condition ? { semantic_condition } : {}) };
    }));
    if (this.dependencies.verification) {
      for (const result of results) {
        for (const candidate of result.candidates) {
          if (candidate.mapping.status !== "discovered") continue;
          try {
            const verified = this.dependencies.verification.verify(candidate.mapping);
            await this.dependencies.mappings.save(verified);
            candidate.mapping = verified;
            candidate.requires_clinician_confirmation = candidate.requires_clinician_confirmation
              && !(verified.status === "database_verified" && verified.provenance === "realtime_discovery" && semanticCodeHintCoverage(verified).has_verified_matches);
            candidate.match_basis = [...new Set([...candidate.match_basis, "schema_catalog" as const])];
          } catch {
            // Keep the candidate reviewable; the failed verification remains a blocking mapping state.
          }
        }
      }
    }
    for (const result of results) {
      if (result.status === "unmapped") continue;
      const target = targets.find(({ term, role, condition_id }) => term === result.requested_term && role === result.role && condition_id === result.condition_id);
      const compatible = target?.expected_value_type ? result.candidates.filter(({ mapping }) => mapping.value_type === target.expected_value_type) : result.candidates;
      const candidate = compatible[0];
      if (!candidate || candidate.requires_clinician_confirmation || !["validated", "clinician_confirmed", "model_reviewed", "database_verified"].includes(candidate.mapping.status)) continue;
      const coverage = candidate.mapping.evidence.semantic_code_hints?.matched_prefixes.length ?? 0;
      const competingCoverage = Math.max(0, ...compatible.slice(1).map(({ mapping }) => mapping.evidence.semantic_code_hints?.matched_prefixes.length ?? 0));
      if (compatible.length === 1 || coverage > competingCoverage) result.status = "resolved";
    }
    if (this.dependencies.candidateReviewer) {
    for (const result of results) {
      const target = targets.find(({ term, role, condition_id }) => term === result.requested_term && role === result.role && condition_id === result.condition_id);
      const reviewAssessment = target?.expected_value_type
        ? { ...result, candidates: result.candidates.filter(({ mapping }) => mapping.value_type === target.expected_value_type) }
        : result;
      const candidates = mappingCandidateEvidenceSummary(reviewAssessment);
      if (result.status !== "needs_confirmation" || !candidates.length || result.candidates.some(({ mapping }) => Boolean(mapping.definition.derivation))) continue;
      try {
        const review = await this.reviewCandidateEvidence({ requested_term: reviewAssessment.requested_term, role: reviewAssessment.role, candidates });
        const applied = applyMappingCandidateReview(reviewAssessment, review);
          result.candidate_review = applied.review;
          if (applied.status === "approved" && applied.selected_candidate) {
            const frozenMapping = {
              ...applied.selected_candidate.mapping,
              synonyms: [...new Set([...applied.selected_candidate.mapping.synonyms, result.requested_term])],
            };
            const frozenCandidate = { ...applied.selected_candidate, mapping: frozenMapping };
            if (!await this.dependencies.mappings.save(frozenMapping)) throw new VariableMappingError("MAPPING_STORAGE_FAILURE", "The model-reviewed mapping could not be frozen.");
            this.dependencies.onExecutableMapping?.(frozenMapping);
            result.candidates = [frozenCandidate, ...result.candidates];
            result.status = "resolved";
          } else if (applied.status === "blocked" && nameContainedMedicationSet(result.requested_term, reviewAssessment.candidates[0])) {
            // A malformed review is not a clinical rejection: the labels that name the requested drug are accepted
            // by rule, and the review failure stays on record in candidate_review.
            const accepted = nameContainedMedicationSet(result.requested_term, reviewAssessment.candidates[0])!;
            result.candidates = [accepted, ...result.candidates.filter((candidate) => candidate !== reviewAssessment.candidates[0])];
            result.status = "resolved";
          } else {
            result.status = "unmapped";
            result.reason = applied.status === "rejected"
              ? `Automated dictionary evidence review rejected every candidate for ${result.requested_term}.`
              : `Automated dictionary evidence review blocked execution for ${result.requested_term}: ${applied.review.reason_codes.join(", ") || "insufficient evidence"}.`;
          }
        } catch (error) {
          result.status = "unmapped";
          result.reason = error instanceof Error ? error.message : "Automated dictionary evidence review failed.";
        }
      }
    }
    if (this.dependencies.evidenceProfiler) {
      const selected = [...new Map(results.filter(({ status }) => status === "resolved").map(({ candidates }) => candidates[0]?.mapping)
        .filter((mapping): mapping is VariableMappingRecord => Boolean(mapping))
        .filter((mapping) => ["validated", "clinician_confirmed", "model_reviewed", "database_verified"].includes(mapping.status))
        .map((mapping) => [mapping.mapping_id, mapping])).values()];
      const profiles = new Map(selected
        .filter((mapping) => Boolean(mapping.evidence.data_profile))
        .map((mapping) => [mapping.mapping_id, mapping.evidence.data_profile!] as const));
      const missingProfiles = selected.filter((mapping) => !mapping.evidence.data_profile);
      const generatedProfiles = new Map<string, NonNullable<VariableMappingRecord["evidence"]["data_profile"]>>();
      const profileGroups = new Map<string, VariableMappingRecord[]>();
      for (const mapping of missingProfiles) {
        const source = mapping.sources[0];
        const key = source ? `${source.schema}.${source.table}` : `missing:${mapping.mapping_id}`;
        profileGroups.set(key, [...(profileGroups.get(key) ?? []), mapping]);
      }
      for (const group of profileGroups.values()) {
        try {
          const profiled = this.dependencies.evidenceProfiler.profileMany
            ? await this.dependencies.evidenceProfiler.profileMany(group)
            : new Map(await Promise.all(group.map(async (mapping) => [mapping.mapping_id, await this.dependencies.evidenceProfiler!.profile(mapping)] as const)));
          for (const [mappingId, profile] of profiled) generatedProfiles.set(mappingId, profile);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Local aggregate evidence profiling failed.";
          const failedIds = new Set(group.map(({ mapping_id }) => mapping_id));
          for (const result of results) if (failedIds.has(result.candidates[0]?.mapping.mapping_id ?? "")) {
            // Missing aggregate evidence does not make a validated or clinician-confirmed mapping wrong; it stays
            // executable with the reason recorded. Unreviewed mappings still need the evidence.
            const trusted = ["validated", "clinician_confirmed"].includes(result.candidates[0]!.mapping.status) && !result.candidates[0]!.requires_clinician_confirmation;
            if (trusted) { result.reason = `Aggregate evidence profile not computed: ${message}`; continue; }
            result.status = "unmapped"; result.reason = `Local aggregate evidence unavailable: ${message}`;
          }
        }
      }
      for (const [mappingId, profile] of generatedProfiles) profiles.set(mappingId, profile);
      for (const result of results) {
        const mapping = result.candidates[0]?.mapping;
        const profile = mapping ? profiles.get(mapping.mapping_id) : undefined;
        if (!mapping || !profile) continue;
        mapping.evidence.data_profile = profile;
        await this.dependencies.mappings.save(mapping);
      }
    }
    const summary = {
      resolved: results.filter(({ status }) => status === "resolved").length,
      needs_confirmation: results.filter(({ status }) => status === "needs_confirmation").length,
      unmapped: results.filter(({ status }) => status === "unmapped").length,
    };
    return { schema_version: "1.0.0", status: summary.unmapped ? "blocked" : summary.needs_confirmation ? "needs_confirmation" : "ready", variables: results, summary, verification_available: Boolean(this.dependencies.verification) };
  }

  async confirm(mappingId: string, reviewerNote: string): Promise<VariableMappingRecord> {
    if (!reviewerNote.trim()) throw new VariableMappingError("MAPPING_INVALID", "A clinical definition note is required.");
    let record = await this.dependencies.mappings.findById(mappingId);
    if (!record) throw new VariableMappingError("MAPPING_NOT_FOUND", "The variable mapping was not found.");
    if (record.status === "discovered") {
      if (!this.dependencies.verification) throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "Database catalog verification is required before confirmation.");
      record = this.dependencies.verification.verify(record);
      if (!await this.dependencies.mappings.save(record)) throw new VariableMappingError("MAPPING_STORAGE_FAILURE", "The verified mapping could not be saved.");
    }
    if (record.status === "validated" || record.status === "clinician_confirmed") {
      this.dependencies.onExecutableMapping?.(record);
      this.assessmentCache.clear();
      return record;
    }
    const confirmed = await this.dependencies.lifecycle.transition(mappingId, "clinician_confirmed", { reviewer_note: reviewerNote });
    this.dependencies.onExecutableMapping?.(confirmed);
    this.assessmentCache.clear();
    return confirmed;
  }
}
