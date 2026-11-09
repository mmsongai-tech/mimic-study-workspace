import { createHash } from "node:crypto";
import type { ClinicalDatabaseCatalog } from "../clinical-database/index.js";
import type { MimicTerminologyMatch, MimicTerminologySearchGateway, ClinicalTermExpander, ClinicalTermExpansion } from "./terminology-gateway.js";
import { isVariableDefinition, semanticCodeHintCoverage, variableDictionaryEvidenceKey, type VariableDictionaryEvidence, type VariableMappingAssessment, type VariableMappingCandidate, type VariableMappingRecord } from "./variable-mapping.js";
import type { VariableMappingRepository } from "./variable-mapping-repository.js";
import { normalizeClinicalConcept } from "./concept-normalization.js";
import { contentWords, entryCarriesRequest, uncoveredWords } from "./match-fidelity.js";
import { parseDerivedVariableRequest } from "./derived-variable-mapping.js";
import { drugClassMapping, ingredientClass, ingredientFor, matchDrugClass, namesIngredient, uncataloguedIngredientClass, type DrugClass, type DrugClassKnowledge } from "./drug-class-catalog.js";

const normalize = (value: string): string => normalizeClinicalConcept(value).normalized;
const id = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
const dictionaryEvidence = (match: MimicTerminologyMatch): VariableDictionaryEvidence => {
  const entry = {
    dictionary: match.dictionary,
    identifier: match.identifier,
    label: match.label,
    ...(match.code_version ? { code_version: match.code_version } : {}),
    ...(match.category ? { category: match.category } : {}),
    ...(match.source_table ? { source_table: match.source_table } : {}),
  };
  return { evidence_key: variableDictionaryEvidenceKey(entry), ...entry };
};
const sharesClinicalHanPhrase = (left: string, right: string, minimumLength = 3): boolean => {
  const first = (left.match(/\p{Script=Han}+/gu) ?? []).join("");
  const second = (right.match(/\p{Script=Han}+/gu) ?? []).join("");
  const shortest = first.length <= second.length ? first : second;
  const longest = first.length <= second.length ? second : first;
  for (let length = shortest.length; length >= minimumLength; length -= 1) {
    for (let start = 0; start + length <= shortest.length; start += 1) {
      if (longest.includes(shortest.slice(start, start + length))) return true;
    }
  }
  return false;
};
const sharesMixedLanguageAnchor = (left: string, right: string): boolean => {
  const leftLatin = new Set((left.match(/[\p{Script=Latin}\p{N}]+/gu) ?? []).map((value) => value.toLocaleLowerCase()));
  const rightLatin = new Set((right.match(/[\p{Script=Latin}\p{N}]+/gu) ?? []).map((value) => value.toLocaleLowerCase()));
  const sharedLatin = [...leftLatin].some((value) => value.length >= 2 && rightLatin.has(value));
  if (!sharedLatin) return false;
  const leftHan = left.match(/\p{Script=Han}+/gu) ?? [];
  const rightHan = right.match(/\p{Script=Han}+/gu) ?? [];
  return leftHan.some((leftPart) => rightHan.some((rightPart) => sharesClinicalHanPhrase(leftPart, rightPart, 4)));
};
const sharesTrustedMixedLanguageAnchor = (left: string, right: string): boolean => {
  const leftLatin = new Set((left.match(/[\p{Script=Latin}\p{N}]+/gu) ?? []).map((value) => value.toLocaleLowerCase()));
  const rightLatin = new Set((right.match(/[\p{Script=Latin}\p{N}]+/gu) ?? []).map((value) => value.toLocaleLowerCase()));
  if (![...leftLatin].some((value) => value.length >= 2 && rightLatin.has(value))) return false;
  const leftHan = left.match(/\p{Script=Han}+/gu) ?? [];
  const rightHan = right.match(/\p{Script=Han}+/gu) ?? [];
  if (leftHan.join("").length > 4 || rightHan.join("").length > 4) return false;
  return leftHan.some((leftPart) => rightHan.some((rightPart) => leftPart[0] === rightPart[0]));
};
/** True when every word of `phrase` appears, in order and adjacent, among the words of `text` ("age" is not in "stage"). */
export const containsWords = (text: string, phrase: string): boolean => {
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean); const wanted = phrase.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!wanted.length || wanted.length > words.length) return false;
  for (let start = 0; start + wanted.length <= words.length; start += 1) if (wanted.every((word, offset) => words[start + offset] === word)) return true;
  return false;
};
// A class reached through the model's English reading of a Chinese term must share a Chinese phrase with the class's own Chinese
// names: the 7B model once read 地平类药物 (the dihydropyridines) as "Benzodiazepines", whose Chinese names share nothing with it.
const classReadableFrom = (term: string, drugClass: DrugClass): boolean =>
  !/\p{Script=Han}/u.test(term) || [drugClass.labels.zh, ...drugClass.synonyms].some((name) => sharesClinicalHanPhrase(term, name, 2));
const containsAlias = (text: string, alias: string): boolean => {
  const candidate = normalize(alias);
  if (!/\p{Script=Han}/u.test(alias)) return containsWords(text, candidate) || containsWords(candidate, text);
  const compactText = text.replaceAll(" ", "");
  const compactCandidate = candidate.replaceAll(" ", "");
  const requestedHanLength = (text.match(/\p{Script=Han}/gu) ?? []).length;
  if (compactCandidate.length < 2) return text.split(/[^\p{L}\p{N}]+/u).includes(candidate);
  const semanticParts = candidate.match(/[\p{Script=Latin}\p{N}]+|\p{Script=Han}{2,}/gu) ?? [];
  return compactText.includes(compactCandidate)
    || requestedHanLength >= 4 && compactCandidate.includes(compactText)
    || semanticParts.length > 1 && semanticParts.every((part) => compactText.includes(part))
    || sharesMixedLanguageAnchor(text, candidate);
};
const matchesReusableAlias = (mapping: VariableMappingRecord, term: string, alias: string, role: VariableMappingCandidate["role"]): boolean =>
  containsAlias(term, alias)
  || mapping.status === "clinician_confirmed" && sharesClinicalHanPhrase(term, alias)
  || mapping.status === "model_reviewed" && roleCategoryRank(role, mapping.category) > 0 && sharesClinicalHanPhrase(term, alias, 4)
  || mapping.status === "validated" && sharesTrustedMixedLanguageAnchor(term, normalize(alias));

// A readmission or history concept answers only a request that says so. "Heart failure" as an outcome is the diagnosis of
// the admission, never "readmission for heart failure", however alike their stored names are.
const READMISSION_WORDING = /readmi|re-?hospitali[sz]|re-?admit|再入院|再住院|再次入院|再次住院|重复入院|重新入院|二次入院|入院率|因[^，。,]{1,12}(入院|住院)|(hospitali[sz]ation|admission)\s+(for|due to)/iu;
const SEPSIS3_WORDING = /sepsis[\s-]?3|脓毒症\s*3|sepsis\s*3\.0/iu;
const HISTORY_WORDING = /history of|prior |previous|earlier|既往|病史|以往|曾[有患]|过去/iu;
const derivedConceptAllowed = (conceptId: string, requested: ReadonlyArray<string | undefined>): boolean => {
  const text = requested.filter((value): value is string => Boolean(value)).join(" ");
  if (conceptId.startsWith("readmission_")) return READMISSION_WORDING.test(text);
  if (conceptId.startsWith("history_of_")) return HISTORY_WORDING.test(text);
  if (conceptId.startsWith("sepsis3_")) return SEPSIS3_WORDING.test(text);
  return true;
};
const statusRank: Record<VariableMappingRecord["status"], number> = { validated: 6, clinician_confirmed: 5, model_reviewed: 4, database_verified: 3, discovered: 2, deprecated: 0 };
const basisRank: Record<VariableMappingCandidate["match_basis"][number], number> = {
  validated_mapping: 5, schema_catalog: 4, database_dictionary: 3, synonym: 2, model_suggestion: 1,
};
const roleCategoryRank = (role: VariableMappingCandidate["role"], category: VariableMappingRecord["category"]): number => {
  if (role === "population" || role === "index_time") return category === "encounter" ? 3 : category === "diagnosis" || category === "demographic" ? 1 : 0;
  if (role === "outcome") return category === "outcome" ? 3 : category === "laboratory" || category === "score" || category === "intervention" ? 1 : 0;
  if (role === "covariate") return ["demographic", "laboratory", "vital_sign", "score", "diagnosis"].includes(category) ? 2 : 0;
  return ["laboratory", "vital_sign", "medication", "intervention", "diagnosis", "score"].includes(category) ? 2 : 0;
};
// An encounter itself (the ICU stay, the admission) is never an exposure or adjustment variable, but a yes/no attribute
// of the encounter (emergency admission) is.
const roleCategoryCompatible = (role: VariableMappingCandidate["role"], category: VariableMappingRecord["category"], valueType?: VariableMappingRecord["value_type"]): boolean => {
  const encounterAttribute = category === "encounter" && valueType === "binary";
  if (role === "outcome") return category !== "encounter" && category !== "demographic" && category !== "medication";
  if (role === "exposure") return (category !== "encounter" || encounterAttribute) && category !== "outcome";
  if (role === "index_time") return category === "encounter";
  if (role === "covariate") return (category !== "encounter" || encounterAttribute) && category !== "outcome";
  return true;
};

const fromCatalog = (term: string, catalog: ClinicalDatabaseCatalog, now: string): VariableMappingRecord[] => {
  const requested = normalize(term);
  if (requested.length < 3) return [];
  return catalog.relations.flatMap((relation) => relation.columns
    .filter((column) => normalize(`${relation.name} ${column.name}`).includes(requested) || requested.includes(normalize(column.name)))
    .slice(0, 3)
    .map((column) => ({
      schema_version: "1.0.0" as const,
      mapping_id: `mimic-iv.catalog.${id([relation.schema, relation.name, column.name])}.v1`,
      concept_id: `catalog_${relation.schema}_${relation.name}_${column.name}`,
      mapping_version: "1.0.0",
      labels: { en: `${relation.name}.${column.name}` }, synonyms: [term], category: "encounter" as const,
      value_type: /int|numeric|double|real|decimal/iu.test(column.data_type) ? "continuous" as const : "categorical" as const,
      definition: { summary: `Schema-catalog candidate for ${term}`, temporal_rule: "Confirm the index-relative time window.", value_rule: "Confirm the field semantics and coding before use.", missingness_rule: "Missing values remain explicit." },
      sources: [{ kind: "direct_field" as const, schema: relation.schema, table: relation.name, columns: [column.name] }],
      status: "database_verified" as const, provenance: "realtime_discovery" as const,
      evidence: { catalog_integrity_id: `${catalog.source_service}:${catalog.inspected_at}`, database_checked_at: now }, created_at: now, updated_at: now,
    })));
};

const fromDictionary = (term: string, match: MimicTerminologyMatch, now: string): VariableMappingRecord => {
  const diagnosis = match.dictionary === "d_icd_diagnoses";
  const procedure = match.dictionary === "d_icd_procedures";
  const lab = match.dictionary === "d_labitems";
  const medication = match.dictionary === "prescriptions_drug";
  const medicationLike = medication || /medication/iu.test(match.category ?? "");
  const icuTable = ["chartevents", "inputevents", "outputevents", "procedureevents"].includes(match.source_table ?? "") ? match.source_table! : "chartevents";
  const icuColumns = icuTable === "inputevents" ? ["subject_id", "hadm_id", "stay_id", "itemid", "starttime", "endtime", "amount", "amountuom"] : icuTable === "outputevents" ? ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "value", "valueuom"] : ["stay_id", "itemid", "charttime", "valuenum", "valueuom"];
  // How the entry was found is not part of its identity: the same item found by text or by embedding search is one mapping.
  const { retrieved_by: _retrievedBy, ...entry } = match;
  const mappingId = `mimic-iv.discovered.${id([term, entry])}.v1`;
  return {
    schema_version: "1.0.0", mapping_id: mappingId, concept_id: `discovered_${id(term)}`, mapping_version: "1.0.0",
    labels: { en: match.label }, synonyms: [term],
    category: diagnosis ? "diagnosis" : procedure ? "intervention" : lab ? "laboratory" : medication || /medication/iu.test(match.category ?? "") ? "medication" : "vital_sign",
    value_type: diagnosis || procedure || medicationLike ? "binary" : "continuous",
    definition: {
      summary: `Candidate mapping for ${term}`,
      temporal_rule: "The researcher must confirm the index-relative time window.",
      ...(medicationLike ? { aggregation: "any" as const } : { aggregation: "mean" as const }),
      value_rule: "The candidate dictionary identifier must be reviewed before formal execution.",
      missingness_rule: "Missing source records remain explicit and are not interpreted as normal or absent disease without confirmation.",
    },
    sources: [{
      kind: diagnosis ? "diagnosis_code" : procedure ? "procedure_code" : medication ? "medication_label" : "dictionary_item",
      schema: diagnosis || procedure || lab || medication ? "mimiciv_hosp" : "mimiciv_icu",
      table: diagnosis ? "diagnoses_icd" : procedure ? "procedures_icd" : lab ? "labevents" : medication ? "prescriptions" : icuTable,
      columns: diagnosis || procedure ? ["subject_id", "hadm_id", "icd_code", "icd_version"] : lab ? ["subject_id", "hadm_id", "itemid", "charttime", "valuenum", "valueuom"] : medication ? ["subject_id", "hadm_id", "starttime", "stoptime", "drug", "dose_val_rx", "dose_unit_rx", "route"] : icuColumns,
      dictionary_table: match.dictionary,
      ...(diagnosis || procedure ? { codes: [{ code: match.identifier, version: match.code_version ?? 10 }] } : medication ? { value_filters: [{ column: "drug", values: [match.identifier] }] } : { item_ids: [Number(match.identifier)] }),
    }],
    status: "discovered", provenance: "realtime_discovery", evidence: { dictionary_entries: [dictionaryEvidence(match)] }, created_at: now, updated_at: now,
  };
};

const fromDictionaryCodeSet = (term: string, matches: MimicTerminologyMatch[], now: string, requestedPrefixes: string[] = []): VariableMappingRecord => {
  const dictionary = matches[0]?.dictionary;
  const diagnosis = dictionary === "d_icd_diagnoses";
  const codes = [...new Map(matches
    .filter((match) => match.code_version === 9 || match.code_version === 10)
    .map((match) => [`${match.code_version}:${match.identifier}`, { code: match.identifier, version: match.code_version! }])).values()];
  const mappingId = `mimic-iv.discovered-set.${id([term, dictionary, codes])}.v1`;
  return {
    schema_version: "1.0.0", mapping_id: mappingId, concept_id: `discovered_set_${id([term, dictionary])}`, mapping_version: "1.0.0",
    labels: { en: `${diagnosis ? "Diagnosis" : "Procedure"} code set matching “${term}”`, ...(/\p{Script=Han}/u.test(term) ? { zh: `${term}候选编码集` } : {}) },
    synonyms: [term], category: diagnosis ? "diagnosis" : "intervention", value_type: "binary",
    definition: {
      summary: `Dictionary-label-matched candidate code set for ${term}`,
      temporal_rule: "Confirm whether the coded event and its timing represent the intended study definition.",
      value_rule: `Presence of any of ${codes.length} frozen dictionary-matched codes; clinical code-set review is required.`,
      missingness_rule: "No matching code is not interpreted as confirmed absence until the phenotype definition is approved.",
    },
    sources: [{
      kind: diagnosis ? "diagnosis_code" : "procedure_code", schema: "mimiciv_hosp",
      table: diagnosis ? "diagnoses_icd" : "procedures_icd",
      columns: diagnosis ? ["subject_id", "hadm_id", "seq_num", "icd_code", "icd_version"] : ["subject_id", "hadm_id", "seq_num", "chartdate", "icd_code", "icd_version"],
      dictionary_table: dictionary as "d_icd_diagnoses" | "d_icd_procedures", codes,
    }],
    status: "discovered", provenance: "realtime_discovery", evidence: {
      dictionary_entries: matches.map(dictionaryEvidence),
      ...(requestedPrefixes.length ? { semantic_code_hints: {
        requested_prefixes: requestedPrefixes,
        checked_prefixes: requestedPrefixes,
        matched_prefixes: requestedPrefixes.filter((prefix) => matches.some(({ identifier }) => identifier.replaceAll(".", "").toLocaleLowerCase().startsWith(prefix.replaceAll(".", "").toLocaleLowerCase()))),
        match_mode: "dictionary_prefix" as const,
      } } : {}),
    }, created_at: now, updated_at: now,
  };
};

const fromMedicationSet = (term: string, matches: MimicTerminologyMatch[], now: string): VariableMappingRecord => {
  const values = [...new Set(matches.map(({ identifier }) => identifier))].slice(0, 100);
  const mappingId = `mimic-iv.discovered-medication.${id([term, values])}.v1`;
  return {
    schema_version: "1.0.0", mapping_id: mappingId, concept_id: `discovered_medication_${id(term)}`, mapping_version: "1.0.0",
    labels: { en: `Medication labels matching “${term}”`, ...(/\p{Script=Han}/u.test(term) ? { zh: `${term}候选药名集` } : {}) }, synonyms: [term], category: "medication", value_type: "binary",
    definition: { summary: `Prescription exposure matching ${term}`, temporal_rule: "Apply the confirmed index-relative prescription window.", aggregation: "any", value_rule: `Presence of one of ${values.length} frozen source drug labels.`, missingness_rule: "No matching prescription is treated as no recorded exposure only within the reviewed source and window." },
    sources: [{ kind: "medication_label", schema: "mimiciv_hosp", table: "prescriptions", columns: ["subject_id", "hadm_id", "starttime", "stoptime", "drug", "dose_val_rx", "dose_unit_rx", "route"], dictionary_table: "prescriptions_drug", value_filters: [{ column: "drug", values }] }],
    status: "discovered", provenance: "realtime_discovery", evidence: { dictionary_entries: matches.map(dictionaryEvidence) }, created_at: now, updated_at: now,
  };
};

// A validated direct field of an admission or stay table (hospitalized patient, ICU stay) is executable without identifiers.
const hasExecutableIdentifiers = (mapping: VariableMappingRecord): boolean => mapping.sources.some((source) => source.item_ids?.length || source.codes?.length || source.value_filters?.some(({ values }) => values.length) || (mapping.status === "validated" && source.kind === "direct_field"));
const semanticCodeCoverageRank = (mapping: VariableMappingRecord): number => mapping.evidence.semantic_code_hints?.matched_prefixes.length ?? 0;
// A definition a researcher saved is that researcher's own choice of items; the report states that it is unreviewed (docs/decisions/0009).
const requiresClinicalConfirmation = (mapping: VariableMappingRecord, activeCodeHints: string[] = []): boolean => !["validated", "clinician_confirmed", "model_reviewed"].includes(mapping.status) && !isVariableDefinition(mapping)
  && !(mapping.status === "database_verified" && mapping.provenance === "realtime_discovery" && activeCodeHints.length > 0
    && semanticCodeHintCoverage(mapping).has_verified_matches);
const semanticCategoryRank = (requested: ClinicalTermExpansion["category"] | undefined, actual: VariableMappingRecord["category"]): number => {
  if (!requested || requested === "unknown") return 0;
  if (requested === actual) return 6;
  if ((requested === "medication" && actual === "intervention") || (requested === "intervention" && actual === "medication")) return 2;
  if (requested === "outcome" && actual === "demographic") return 1;
  return -6;
};

const STEM_STOP = new Set(["disease", "disorder", "unspecified", "other", "patient", "patients", "chronic", "acute", "primary", "secondary", "without", "with", "history"]);
const stems = (value: string): Set<string> => new Set((value.toLocaleLowerCase().match(/[a-z]{5,}/gu) ?? []).filter((word) => !STEM_STOP.has(word)).map((word) => word.slice(0, 6)));
/** True when the label and any requested term share a word stem (first six letters of a content word). */
export const sharesWordStem = (label: string, requested: Array<string | undefined>): boolean => {
  const wanted = new Set(requested.flatMap((term) => term ? [...stems(term)] : []));
  if (!wanted.size) return true;
  return [...stems(label)].some((stem) => wanted.has(stem));
};

const NON_CLINICAL_OPERATION_TOKENS = new Set([
  "absolute", "average", "baseline", "change", "changes", "delta", "first", "index", "last", "maximum", "mean", "measurement", "measurements", "minimum", "outcome", "record", "recorded", "value", "values",
]);
const clinicalLatinTokens = (value: string): string[] => [...new Set((value.replace(/([a-z\d])([A-Z])/gu, "$1 $2").toLocaleLowerCase().match(/[a-z][a-z0-9]*/gu) ?? [])
  .filter((token) => token.length > 1 && !NON_CLINICAL_OPERATION_TOKENS.has(token)))];
const hasDictionarySemanticCoverage = (mapping: VariableMappingRecord, requestedTerms: Array<string | undefined>, activeCodeHints: string[]): boolean => {
  if (["validated", "clinician_confirmed"].includes(mapping.status)) return true;
  if (activeCodeHints.length && semanticCodeHintCoverage(mapping).has_verified_matches) return true;
  const dictionaryEntries = mapping.evidence.dictionary_entries ?? [];
  if (!dictionaryEntries.length) return true;
  const dictionaryLabels = dictionaryEntries
    ?.filter(({ label, category }) => !/(?:alarm|报警)/iu.test(`${label} ${category ?? ""}`))
    .map(({ label }) => label).filter(Boolean) ?? [];
  if (!dictionaryLabels.length) return false;
  const requestedTokenSets = requestedTerms.map((term) => clinicalLatinTokens(term ?? "")).filter(({ length }) => length > 0);
  if (!requestedTokenSets.length) return true;
  return requestedTokenSets.some((requestedTokens) => dictionaryLabels.some((label) => {
    const labelTokens = new Set(clinicalLatinTokens(label));
    const shared = requestedTokens.filter((token) => labelTokens.has(token)).length;
    return requestedTokens.length === 1 ? shared === 1 : shared >= 2 && shared / requestedTokens.length >= 0.6;
  }));
};

const medicationLabels = (mapping: VariableMappingRecord): string[] => mapping.sources.flatMap((source) => source.kind === "medication_label" ? source.value_filters?.flatMap(({ values }) => values) ?? [] : []);
/**
 * Synonym searches ("Metoprolol Tartrate") produce drug-label sets that are strict subsets of the set for the requested
 * ingredient ("Metoprolol"). The ranking otherwise prefers fewer identifiers, so a subset would silently narrow the
 * exposure; it is dropped when a superset exists in which at least 80% of labels name the requested drug.
 */
const dropRedundantMedicationSubsets = (candidates: VariableMappingCandidate[], requestedTerm: string): void => {
  const name = requestedTerm.trim().toLocaleLowerCase();
  if (name.length < 4) return;
  const namesDrug = (label: string): boolean => { const text = label.trim().toLocaleLowerCase(); return text.includes(name) || (text.length >= 6 && name.startsWith(text)); };
  const sets = candidates.map((candidate) => new Set(medicationLabels(candidate.mapping)));
  const redundant = new Set<number>();
  sets.forEach((subset, index) => {
    if (!subset.size) return;
    if (sets.some((superset, other) => other !== index && superset.size > subset.size && [...subset].every((label) => superset.has(label)) && [...superset].filter(namesDrug).length >= 0.8 * superset.size)) redundant.add(index);
  });
  for (const index of [...redundant].sort((a, b) => b - a)) candidates.splice(index, 1);
};

export class VariableMappingDiscoveryService {
  constructor(private readonly dependencies: {
    mappings: VariableMappingRepository;
    terminology?: MimicTerminologySearchGateway;
    termExpander?: ClinicalTermExpander;
    catalog?: ClinicalDatabaseCatalog;
    drugClasses?: DrugClassKnowledge;
    now?: () => string;
  }) {}

  /** A requested drug class (ACEI, β-blockers, opioids…) resolves to the local labels of its member ingredients. */
  /**
   * A single drug name the catalogue does not list ("heparin") is an ingredient like any other: every prescription label that contains
   * the name, by the same deterministic rule as a catalogued ingredient, instead of leaving the choice among several label sets to a model.
   * Only when the model's own category for the term is medication, so a laboratory name such as "glucose" is never read as a drug.
   */
  private async searchUncataloguedIngredient(input: { term: string; role: VariableMappingCandidate["role"] }, expansion: ClinicalTermExpansion | undefined): Promise<VariableMappingAssessment | undefined> {
    const knowledge = this.dependencies.drugClasses; const terminology = this.dependencies.terminology;
    if (!knowledge || !terminology?.searchMedication || expansion?.category !== "medication" || !["exposure", "predictor", "covariate", "population"].includes(input.role)) return undefined;
    const content = contentWords(input.term);
    const name = content.length === 1 ? content[0]! : undefined;
    if (!name || !/^[a-z][a-z-]{4,}$/u.test(name)) return undefined;
    // The rule keeps every label that contains the name; only labels text search found by the whole word may reach it (an embedding
    // neighbour such as "arformoterol" contains "formoterol" but is another drug, as "nystatin" contains "statin").
    const matches = (await terminology.searchMedication(name)).filter(({ label, retrieved_by }) => retrieved_by !== "embedding" && label.toLocaleLowerCase().includes(name));
    const adHoc = uncataloguedIngredientClass(knowledge, name, input.term);
    const mapping = drugClassMapping(knowledge, adHoc, input.term, matches, this.dependencies.now?.() ?? new Date().toISOString());
    if (!mapping) return undefined;
    await this.dependencies.mappings.save(mapping);
    return { schema_version: "1.0.0", requested_term: input.term, status: "resolved", candidates: [{ candidate_id: `candidate:${mapping.mapping_id}`, requested_term: input.term, normalized_term: normalize(input.term), role: input.role, mapping, match_basis: ["database_dictionary"], confidence: "medium", requires_clinician_confirmation: false,
      explanation: `${adHoc.labels.en} is not in the drug catalogue; every local prescription label containing the name is used (${mapping.sources[0]?.value_filters?.[0]?.values.length ?? 0} labels).` }] };
  }

  private async searchDrugClass(input: { term: string; role: VariableMappingCandidate["role"] }, expansion: ClinicalTermExpansion | undefined): Promise<VariableMappingAssessment | undefined> {
    const knowledge = this.dependencies.drugClasses; const terminology = this.dependencies.terminology;
    if (!knowledge || !terminology?.searchMedication || !["exposure", "predictor", "covariate", "population"].includes(input.role)) return undefined;
    // Only the requested term or its English label may name a class: a specific drug's synonyms often mention its
    // class ("atenolol" → "beta blocker"), which must not turn a drug into the whole class.
    // A named ingredient ("candesartan") maps to its own labels by the same rule as a class, never to the class it belongs to.
    const modelClass = matchDrugClass(knowledge, expansion?.normalized_label_en);
    const drugClass = matchDrugClass(knowledge, input.term) ?? ingredientClass(knowledge, input.term) ?? (modelClass && classReadableFrom(input.term, modelClass) ? modelClass : undefined) ?? ingredientClass(knowledge, expansion?.normalized_label_en);
    if (!drugClass) return undefined;
    // As for a single ingredient: the class rule reads only labels text search found, never embedding neighbours.
    const matches = (await Promise.all(drugClass.ingredients.map((ingredient) => terminology.searchMedication!(ingredient)))).flat().filter(({ retrieved_by }) => retrieved_by !== "embedding");
    const mapping = drugClassMapping(knowledge, drugClass, input.term, matches, this.dependencies.now?.() ?? new Date().toISOString());
    // A named drug with no prescription record in the archive is reported as absent; it must never fall back to a neighbouring drug.
    if (!mapping && drugClass.class_id.startsWith("ingredient_")) return { schema_version: "1.0.0", requested_term: input.term, status: "unmapped", candidates: [], reason: `${drugClass.labels.en} has no prescription record in MIMIC-IV.` } as VariableMappingAssessment;
    if (!mapping) return undefined;
    await this.dependencies.mappings.save(mapping);
    return {
      schema_version: "1.0.0", requested_term: input.term, status: "resolved",
      candidates: [{ candidate_id: `candidate:${mapping.mapping_id}`, requested_term: input.term, normalized_term: normalize(input.term), role: input.role, mapping, match_basis: ["validated_mapping", "database_dictionary"], confidence: "high", requires_clinician_confirmation: false,
        explanation: `The drug class ${drugClass.labels.en} (ATC ${drugClass.atc}) expands to local prescription labels containing its member ingredients.` }],
    };
  }

  /**
   * An automatically derived variable is only reusable while its source mapping is unchanged; one built from an older
   * source version (or before provenance was recorded) is skipped and re-derived. Clinician-reviewed ones are kept.
   * The source of a drug-class or drug mapping is the drug catalogue: one built from another catalogue version is found
   * again from the current one (a stored validated class is otherwise reused for good, with labels later versions left out).
   */
  private async withoutStaleDerivations(mappings: VariableMappingRecord[]): Promise<VariableMappingRecord[]> {
    const kept: VariableMappingRecord[] = [];
    const catalogueVersion = this.dependencies.drugClasses?.knowledge_version;
    for (const mapping of mappings) {
      if (mapping.provenance !== "realtime_discovery") { kept.push(mapping); continue; }
      const origin = mapping.evidence.derived_from;
      if (origin?.mapping_id.startsWith("drug-class:")) { if (!catalogueVersion || origin.mapping_version === catalogueVersion) kept.push(mapping); continue; }
      if (!mapping.definition.derivation) { kept.push(mapping); continue; }
      const source = origin ? await this.dependencies.mappings.findById(origin.mapping_id) : undefined;
      if (origin && source && source.mapping_version === origin.mapping_version) kept.push(mapping);
    }
    return kept;
  }

  async search(input: { term: string; role: VariableMappingCandidate["role"]; expected_value_type?: VariableMappingRecord["value_type"] | undefined; dictionary_code_hints?: string[]; allow_live_search?: boolean; allow_term_expansion?: boolean; exclude_derived?: boolean }): Promise<VariableMappingAssessment> {
    const normalized = normalize(input.term);
    let expansion: ClinicalTermExpansion | undefined;
    let expansionFailure: string | undefined;
    if (input.allow_live_search && input.allow_term_expansion !== false && this.dependencies.termExpander) {
      try { expansion = await this.dependencies.termExpander.expand({ term: input.term, role: input.role }); }
      catch (error) { expansionFailure = error instanceof Error ? error.message : "Clinical term normalization failed."; }
    }
    if (input.allow_live_search && input.expected_value_type !== "continuous") {
      const drugClass = await this.searchDrugClass(input, expansion);
      if (drugClass) return drugClass;
    }
    // A specific drug ("candesartan") must not resolve to the class it belongs to, whose label the model's synonyms often mention.
    const knowledge = this.dependencies.drugClasses;
    const ingredient = knowledge ? ingredientFor(knowledge, input.term) ?? (!matchDrugClass(knowledge, input.term) ? ingredientFor(knowledge, expansion?.normalized_label_en) : undefined) : undefined;
    const specificDrug = Boolean(knowledge && (namesIngredient(knowledge, input.term) || (!matchDrugClass(knowledge, input.term) && namesIngredient(knowledge, expansion?.normalized_label_en))));
    const codeHints = [...new Set([...(input.dictionary_code_hints ?? []), ...(expansion?.code_hints ?? [])].map((value) => value.trim()).filter((value) => /^(?=.*\d)[A-Za-z0-9.]{2,12}$/u.test(value)))].slice(0, 20);
    const searchTerms = [...new Set([input.term, ...codeHints, expansion?.normalized_label_en, ...(expansion?.synonyms ?? [])].filter((term): term is string => Boolean(term)))].slice(0, 25);
    const normalizedTerms = searchTerms.map(normalize);
    const direct = (await Promise.all(normalizedTerms.map((term) => this.dependencies.mappings.findByTerm(term)))).flat();
    const reusable = await this.dependencies.mappings.listByStatus(["discovered", "database_verified", "model_reviewed", "clinician_confirmed", "validated"]);
    const matchRanks = new Map<string, number>();
    const matchSpecificity = new Map<string, number>();
    // A label or synonym equal to a search term names exactly what was asked ("糖尿病" is diabetes, not DKA).
    const exactNames = new Set(reusable.filter((mapping) => [mapping.labels.en, mapping.labels.zh, ...mapping.synonyms]
      .filter((value): value is string => Boolean(value)).some((alias) => normalizedTerms.some((term) => normalize(alias).replaceAll(" ", "") === term.replaceAll(" ", "")))).map(({ mapping_id }) => mapping_id));
    for (const mapping of reusable) for (const alias of [mapping.labels.en, mapping.labels.zh, ...mapping.synonyms].filter((value): value is string => Boolean(value))) for (const term of normalizedTerms) { const normalizedAlias = normalize(alias).replaceAll(" ", ""); const exact = term.replaceAll(" ", "").includes(normalizedAlias); if (exact) { matchRanks.set(mapping.mapping_id, Math.max(matchRanks.get(mapping.mapping_id) ?? 0, 2)); matchSpecificity.set(mapping.mapping_id, Math.max(matchSpecificity.get(mapping.mapping_id) ?? 0, normalizedAlias.length)); } else if (matchesReusableAlias(mapping, term, alias, input.role)) matchRanks.set(mapping.mapping_id, Math.max(matchRanks.get(mapping.mapping_id) ?? 0, 1)); }
    const contained = reusable.filter((mapping) => [mapping.labels.en, mapping.labels.zh, ...mapping.synonyms]
      .filter((value): value is string => Boolean(value))
      .some((alias) => normalizedTerms.some((term) => matchesReusableAlias(mapping, term, alias, input.role))));
    // A drug class is rebuilt from the catalogue by rule, so its stored mapping is reused only for a term that names that class: by rule, or
    // through a model reading the term agrees with. A stored class whose name merely contains the term or is contained in it is another
    // class ("oral anticoagulants" in "direct oral anticoagulants"; "anticoagulant" in "direct oral anticoagulant", which leaves out heparin
    // and warfarin). A term that names no class reuses one only where a clinician confirmed it under exactly that name.
    const namedClass = knowledge ? matchDrugClass(knowledge, input.term) : undefined;
    const readingClass = knowledge ? matchDrugClass(knowledge, expansion?.normalized_label_en) : undefined;
    const trustedClass = namedClass ?? (readingClass && classReadableFrom(input.term, readingClass) ? readingClass : undefined);
    const storedClassAllowed = (mapping: VariableMappingRecord): boolean => {
      if (!knowledge || !mapping.concept_id.startsWith("drug_class_")) return true;
      if (trustedClass) return mapping.concept_id === `drug_class_${trustedClass.class_id}`;
      return mapping.status === "clinician_confirmed" && exactNames.has(mapping.mapping_id);
    };
    const stored = (await this.withoutStaleDerivations([...new Map([...direct, ...contained].map((mapping) => [mapping.mapping_id, mapping])).values()]))
      .filter(storedClassAllowed)
      .filter(({ status, category, value_type, definition, concept_id }) => status !== "deprecated" && !(input.exclude_derived && definition.derivation) && !(specificDrug && concept_id.startsWith("drug_class_")) && !(ingredient && concept_id.startsWith("drug_") && !concept_id.startsWith("drug_class_") && concept_id !== `drug_${ingredient}`) && derivedConceptAllowed(concept_id, [input.term, expansion?.normalized_label_en]) && roleCategoryCompatible(input.role, category, value_type))
      // Once the model has categorized an exposure, predictor or covariate, a stored mapping of a clearly different
      // category (e.g. a demographic for a medication class) cannot be what was asked for. Index time and population
      // keep role evidence ahead of the model's category.
      .filter(({ category }) => !expansion || expansion.category === "unknown" || !["exposure", "predictor", "covariate"].includes(input.role) || semanticCategoryRank(expansion.category, category) >= 0);
    const requestedSemanticTerms = [input.term, expansion?.normalized_label_en];
    const derivedRequest = parseDerivedVariableRequest({ concept: input.term, context: input.term });
    const candidates: VariableMappingCandidate[] = stored.map((mapping) => {
      const exactFrozenCodeEvidence = mapping.status === "database_verified"
        && mapping.provenance === "realtime_discovery"
        && (matchRanks.get(mapping.mapping_id) ?? 0) >= 2
        && semanticCodeHintCoverage(mapping).complete;
      return {
        candidate_id: `candidate:${mapping.mapping_id}`, requested_term: input.term, normalized_term: normalized, role: input.role,
        mapping, match_basis: mapping.status === "validated" ? ["validated_mapping"] : mapping.status === "model_reviewed" ? ["model_suggestion", "database_dictionary"] : ["synonym"],
        confidence: mapping.status === "validated" ? "high" : ["clinician_confirmed", "model_reviewed", "database_verified"].includes(mapping.status) ? "medium" : "low",
        requires_clinician_confirmation: (requiresClinicalConfirmation(mapping, codeHints) && !exactFrozenCodeEvidence)
          || (mapping.status === "model_reviewed" && roleCategoryRank(input.role, mapping.category) === 0),
        explanation: mapping.status === "validated" ? "A versioned validated mapping matched this term." : mapping.status === "model_reviewed" ? "A frozen mapping passed runtime-authorized automated dictionary-evidence review; it is not clinician-confirmed." : exactFrozenCodeEvidence ? "The identical requested term reuses a complete locally verified code-prefix expansion." : "A reusable candidate mapping matched this term and still requires study-specific review.",
      } satisfies VariableMappingCandidate;
    }).filter(({ mapping }) => hasDictionarySemanticCoverage(mapping, requestedSemanticTerms, codeHints));
    if (!candidates.length && this.dependencies.catalog) {
      const now = this.dependencies.now?.() ?? new Date().toISOString();
      for (const mapping of searchTerms.flatMap((term) => fromCatalog(term, this.dependencies.catalog!, now)).slice(0, 10)) {
        await this.dependencies.mappings.save(mapping);
        candidates.push({ candidate_id: `candidate:${mapping.mapping_id}`, requested_term: input.term, normalized_term: normalized, role: input.role, mapping, match_basis: ["schema_catalog"], confidence: "medium", requires_clinician_confirmation: true, explanation: "The field exists in the inspected MIMIC-IV schema; its clinical meaning and time window still require confirmation." });
      }
    }
    const hasExecutableDictionaryValues = candidates.some(({ mapping }) => {
      if (input.expected_value_type && mapping.value_type !== input.expected_value_type) return false;
      if (expansion && expansion.category !== "unknown" && semanticCategoryRank(expansion.category, mapping.category) < 6) return false;
      if (codeHints.length) {
        const coverage = semanticCodeHintCoverage(mapping);
        return coverage.has_verified_matches && coverage.all_prefixes_checked && mapping.sources.some((source) => source.codes?.length);
      }
      return mapping.sources.some((source) => source.item_ids?.length
        || (source.codes?.length && (mapping.evidence.semantic_code_hints ? semanticCodeHintCoverage(mapping).complete : source.codes.length <= 250))
        || source.value_filters?.some(({ values }) => values.length > 0 && values.length <= 250));
    });
    if (input.allow_live_search && !candidates.some(({ mapping }) => ["validated", "clinician_confirmed"].includes(mapping.status))) {
      const ingredient = await this.searchUncataloguedIngredient(input, expansion);
      if (ingredient) return ingredient;
    }
    if ((!candidates.length || !hasExecutableDictionaryValues) && input.allow_live_search && this.dependencies.terminology) {
      const now = this.dependencies.now?.() ?? new Date().toISOString();
      const liveSearchTerms = codeHints.length && expansion?.category !== "medication" ? codeHints : searchTerms;
      const matchesByTerm = await Promise.all(liveSearchTerms.map(async (term) => {
        const nonMedicationRole = input.role !== "exposure" && expansion?.category !== "medication";
        const matches = codeHints.includes(term) && this.dependencies.terminology!.searchCodePrefix
          ? await this.dependencies.terminology!.searchCodePrefix(term)
          : expansion?.category && this.dependencies.terminology!.searchByCategory
            ? await this.dependencies.terminology!.searchByCategory(term, expansion.category)
          : expansion?.category === "medication" && this.dependencies.terminology!.searchMedication
            ? await this.dependencies.terminology!.searchMedication(term)
          : nonMedicationRole && this.dependencies.terminology!.searchNonMedication
            ? await this.dependencies.terminology!.searchNonMedication(term)
            : await this.dependencies.terminology!.search(term);
        // Each dictionary entry must itself carry what was asked: a set that merely contains one right entry among STEMI codes is not "type 2 myocardial infarction".
        // Drug labels are exempt: a brand name or spelling variant ("Toprol XL") legitimately names the ingredient. A request such as "blood pressure change" is judged by its source ("blood pressure").
        // The exemption trusts text search, which found the label by one of the searched names; a label embedding search added only
        // because its meaning is near ("Atenolol" for metoprolol) is judged like any other entry.
        const requestedForms = [derivedRequest?.source_term ?? input.term, expansion?.normalized_label_en];
        const covering = matches.filter(({ dictionary, label, retrieved_by }) => (dictionary === "prescriptions_drug" && retrieved_by !== "embedding") || entryCarriesRequest(requestedForms, label));
        if (!codeHints.includes(term)) return { term, matches: covering };
        const normalizedPrefix = term.replaceAll(".", "").toLocaleLowerCase();
        return { term, matches: covering.filter(({ dictionary, identifier }) => (dictionary === "d_icd_diagnoses" || dictionary === "d_icd_procedures")
          && identifier.replaceAll(".", "").toLocaleLowerCase().startsWith(normalizedPrefix)) };
      }));
      // Embedding neighbours only add: every entry text search found, for any of the search terms, keeps its place ahead of them in the
      // item budget below (a neighbour of the first term must not push out a text match of a later one).
      const found = matchesByTerm.flatMap(({ matches }) => matches);
      const unique = new Map(found.filter(({ retrieved_by }) => retrieved_by !== "embedding").map((match) => [`${match.dictionary}:${match.identifier}`, match] as const));
      for (const match of found) if (match.retrieved_by === "embedding" && !unique.has(`${match.dictionary}:${match.identifier}`)) unique.set(`${match.dictionary}:${match.identifier}`, match);
      const uniqueMatches = [...unique.values()];
      const hintedMatches = matchesByTerm.filter(({ term }) => codeHints.includes(term)).flatMap(({ matches }) => matches)
        .filter(({ dictionary }) => dictionary === "d_icd_diagnoses" || dictionary === "d_icd_procedures")
        // Model-suggested prefixes can land on unrelated code families; keep a hinted code only when its label
        // shares a word stem with the requested term, its English label or a synonym.
        .filter(({ label }) => sharesWordStem(label, [input.term, expansion?.normalized_label_en, ...(expansion?.synonyms ?? [])]));
      const codeSources = hintedMatches.length ? [{ term: input.term, matches: hintedMatches, prefixes: codeHints }] : matchesByTerm.map(({ term, matches }) => ({ term, matches, prefixes: [] as string[] }));
      const codeGroups = codeSources.flatMap(({ term, matches, prefixes }) => {
        const unique = [...new Map(matches.map((match) => [`${match.dictionary}:${match.identifier}`, match])).values()]
          .filter(({ dictionary }) => dictionary === "d_icd_diagnoses" || dictionary === "d_icd_procedures");
        return [...new Set(unique.map(({ dictionary }) => dictionary))]
          .map((dictionary) => ({ term, matches: prefixes.length ? unique.filter((match) => match.dictionary === dictionary) : unique.filter((match) => match.dictionary === dictionary).slice(0, 250), prefixes }));
      });
      const mappings = [
        ...codeGroups.filter(({ matches }) => matches.length).map(({ term, matches, prefixes }) => fromDictionaryCodeSet(term, matches, now, prefixes)),
        ...matchesByTerm.filter(({ matches }) => matches.some(({ dictionary }) => dictionary === "prescriptions_drug")).map(({ term, matches }) => fromMedicationSet(term, matches.filter(({ dictionary }) => dictionary === "prescriptions_drug"), now)),
        ...uniqueMatches.filter(({ dictionary }) => dictionary !== "d_icd_diagnoses" && dictionary !== "d_icd_procedures" && dictionary !== "prescriptions_drug").map((match) => fromDictionary(input.term, match, now))
          .filter((mapping) => hasDictionarySemanticCoverage(mapping, requestedSemanticTerms, codeHints)).slice(0, 10),
      ].filter((mapping) => !expansion || expansion.category === "unknown" || semanticCategoryRank(expansion.category, mapping.category) >= 2)
        .filter((mapping) => hasDictionarySemanticCoverage(mapping, requestedSemanticTerms, codeHints));
      for (const mapping of [...new Map(mappings.map((item) => [item.mapping_id, item])).values()]) {
        await this.dependencies.mappings.save(mapping);
        candidates.push({ candidate_id: `candidate:${mapping.mapping_id}`, requested_term: input.term, normalized_term: normalized, role: input.role, mapping, match_basis: expansion ? ["model_suggestion", "database_dictionary"] : ["database_dictionary"], confidence: "low", requires_clinician_confirmation: requiresClinicalConfirmation(mapping, codeHints), explanation: `The connected MIMIC dictionary contains a reviewable candidate.${expansion?.ambiguities.length ? ` Clinical ambiguity remains: ${expansion.ambiguities.map(({ label }) => label).join(", ")}.` : ""}` });
      }
    }
    dropRedundantMedicationSubsets(candidates, input.term);
    candidates.sort((a, b) => Number(b.mapping.value_type === input.expected_value_type) - Number(a.mapping.value_type === input.expected_value_type)
      || roleCategoryRank(b.role, b.mapping.category) - roleCategoryRank(a.role, a.mapping.category)
      || semanticCategoryRank(expansion?.category, b.mapping.category) - semanticCategoryRank(expansion?.category, a.mapping.category)
      || (codeHints.length ? semanticCodeCoverageRank(b.mapping) - semanticCodeCoverageRank(a.mapping) : 0)
      || statusRank[b.mapping.status] - statusRank[a.mapping.status]
      || Number(a.requires_clinician_confirmation) - Number(b.requires_clinician_confirmation)
      || Number(hasExecutableIdentifiers(b.mapping)) - Number(hasExecutableIdentifiers(a.mapping))
      || Number(exactNames.has(b.mapping.mapping_id)) - Number(exactNames.has(a.mapping.mapping_id))
      || Math.min(...a.mapping.sources.map((source) => source.codes?.length ?? source.item_ids?.length ?? source.value_filters?.reduce((count, filter) => count + filter.values.length, 0) ?? Number.POSITIVE_INFINITY)) - Math.min(...b.mapping.sources.map((source) => source.codes?.length ?? source.item_ids?.length ?? source.value_filters?.reduce((count, filter) => count + filter.values.length, 0) ?? Number.POSITIVE_INFINITY))
      || (matchRanks.get(b.mapping.mapping_id) ?? 0) - (matchRanks.get(a.mapping.mapping_id) ?? 0)
      || (matchSpecificity.get(b.mapping.mapping_id) ?? 0) - (matchSpecificity.get(a.mapping.mapping_id) ?? 0)
      || Math.max(...b.match_basis.map((basis) => basisRank[basis])) - Math.max(...a.match_basis.map((basis) => basisRank[basis]))
      || a.mapping.mapping_id.localeCompare(b.mapping.mapping_id));
    const best = candidates[0];
    const competingStrongConcept = best && candidates.some((candidate) => candidate.mapping.concept_id !== best.mapping.concept_id
      && roleCategoryRank(candidate.role, candidate.mapping.category) === roleCategoryRank(best.role, best.mapping.category)
      && (matchRanks.get(candidate.mapping.mapping_id) ?? 0) >= 2);
    // The concept must carry everything the request says; a qualifier it does not name ("type 2", "HbA1c", "ratio") is not silently dropped.
    // A name equal to the model's English label does not excuse a request the model shortened: only the researcher's own words count.
    const writtenKey = normalize(input.term).replaceAll(" ", "");
    const namedByResearcher = best ? [best.mapping.labels.en, best.mapping.labels.zh, ...best.mapping.synonyms].some((alias) => alias && normalize(alias).replaceAll(" ", "") === writtenKey) : false;
    const uncovered = best && !namedByResearcher
      ? uncoveredWords([derivedRequest?.source_term ?? input.term, expansion?.normalized_label_en], [best.mapping.labels.en, best.mapping.labels.zh, ...best.mapping.synonyms]) : [];
    // The caller upgrades a lone validated candidate to "resolved" unless the candidate itself asks for confirmation, so the flag is set here.
    if (best && uncovered.length) best.requires_clinician_confirmation = true;
    return {
      schema_version: "1.0.0", requested_term: input.term,
      status: !best ? "unmapped" : best.requires_clinician_confirmation || uncovered.length || (!["validated", "clinician_confirmed", "model_reviewed"].includes(best.mapping.status) && competingStrongConcept) ? "needs_confirmation" : "resolved",
      candidates,
      ...(!best ? { reason: ["No reusable mapping or verified MIMIC dictionary candidate was found.", expansionFailure].filter(Boolean).join(" ") }
        : uncovered.length ? { reason: `“${input.term}” was matched to “${best.mapping.labels.en}”, which does not carry: ${uncovered.join(", ")}. The matched concept is broader than, or only a part of, what was asked.` } : {}),
    };
  }
}
