import { contentWords } from "../variable-mapping/index.js";
import type { DictionaryIndex } from "./dictionary-index.js";
import { DEFINITION_ID, type VariableDefinition } from "./variable-definition.js";

/** A definition the platform drafts from a dictionary search, with the counts the researcher sees before accepting it. */
export interface ProposedDefinition { definition: VariableDefinition; facts: { codes: number; admissions: number; rows: number } }

const MAX_CODES = 60;
/** A drafted definition that few admissions carry is probably the wrong item or code; it is not offered. */
const MIN_ADMISSIONS = 200;
/** Marks a definition the platform drafted from the dictionary (not written by a person); a later concept of the pack with the same name replaces it. */
export const DRAFT_AUTHOR = "platform-draft";

/** Acronyms and clinical equivalents the dictionaries spell differently (config/dictionary-synonyms): phrase -> spellings to try. */
export interface SynonymTable { phrases: Record<string, string[]> }

/** The spellings of a term to search with: the term itself, then each synonym phrase it contains replaced by its equivalents. */
export const alternativeForms = (term: string, synonyms?: SynonymTable): string[] => {
  const forms = [term];
  if (!synonyms) return forms;
  const lower = term.toLocaleLowerCase();
  for (const [phrase, equivalents] of Object.entries(synonyms.phrases).sort((a, b) => b[0].length - a[0].length)) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
    if (!pattern.test(lower)) continue;
    for (const equivalent of equivalents) forms.push(lower.replace(pattern, (_match, before: string) => `${before}${equivalent}`));
  }
  return [...new Set(forms)];
};
const slug = (term: string): string => {
  const base = term.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 60);
  const id = /^[a-z]/u.test(base) ? base : `v_${base}`;
  return DEFINITION_ID.test(id) ? id : `${id}_x`.slice(0, 63);
};
// "non-traumatic" is "nontraumatic" in the ICD titles.
const dictionaryForm = (term: string): string => term.replace(/\bnon[-\s]+(?=[a-z])/giu, "non");

/**
 * Draft a diagnosis definition for a population or exposure term: every dictionary code whose title carries all of the term's words
 * (the same test the resolver applies to a concept). Nothing is proposed when no code carries them, or when so many do that the term
 * is plainly not specific enough to read as a code set.
 */
export const proposeDiagnosisDefinition = (index: DictionaryIndex, term: string, synonyms?: SynonymTable): ProposedDefinition | undefined => {
  let hits: ReturnType<DictionaryIndex["search"]> = [];
  for (const form of alternativeForms(term, synonyms)) {
    hits = index.search("diagnosis", nameWords(form) || dictionaryForm(form), MAX_CODES + 1).filter((hit) => hit.admissions > 0 && hit.code && hit.version);
    if (hits.length) break;
  }
  if (!hits.length || hits.length > MAX_CODES || hits.reduce((sum, hit) => sum + hit.admissions, 0) < MIN_ADMISSIONS) return undefined;
  const definition: VariableDefinition = {
    schema_version: "1.0.0", definition_id: slug(term), version: "1.0.0", kind: "diagnosis", labels: { en: term }, synonyms: [],
    meaning: `Diagnosis codes whose dictionary title carries “${term}”, drafted by the platform from the dictionary; not reviewed.`,
    status: "researcher_defined", author: DRAFT_AUTHOR, diagnosis: { codes: hits.map((hit) => ({ code: hit.code!, version: hit.version! })) },
  };
  return { definition, facts: { codes: hits.length, admissions: hits.reduce((sum, hit) => sum + hit.admissions, 0), rows: hits.reduce((sum, hit) => sum + hit.rows, 0) } };
};

// How a drug is given or what the measurement is read from; the dictionary names the substance, not the route or the specimen.
const ROUTE_WORDS = new Set(["intravenous", "iv", "oral", "po", "intramuscular", "subcutaneous", "serum", "plasma", "blood", "arterial", "venous"]);
/** The words of a term that name the thing itself: the fidelity rule's content words without route and specimen words. */
const nameWords = (term: string): string => dictionaryForm(term).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  .filter((word) => !ROUTE_WORDS.has(word.toLowerCase()) && contentWords(word).length > 0).join(" ");

/** The same for a drug named only by its prescription labels: every label that carries all of the term's words. */
export const proposeDrugDefinition = (index: DictionaryIndex, term: string, synonyms?: SynonymTable): ProposedDefinition | undefined => {
  let hits: ReturnType<DictionaryIndex["search"]> = [];
  for (const form of alternativeForms(term, synonyms)) { const query = nameWords(form); if (!query) continue; hits = index.search("drug", query, MAX_CODES + 1).filter((hit) => hit.admissions > 0 && hit.label.toLowerCase().startsWith(query.split(" ")[0]!.toLowerCase())); if (hits.length) break; }
  if (!hits.length || hits.length > MAX_CODES || hits.reduce((sum, hit) => sum + hit.admissions, 0) < MIN_ADMISSIONS) return undefined;
  const definition: VariableDefinition = {
    schema_version: "1.0.0", definition_id: slug(term), version: "1.0.0", kind: "drug", labels: { en: term }, synonyms: [],
    meaning: `Prescription labels that carry “${term}”, drafted by the platform from the dictionary; not reviewed.`,
    status: "researcher_defined", author: DRAFT_AUTHOR, drug: { prescription_labels: hits.map((hit) => hit.label) },
  };
  return { definition, facts: { codes: hits.length, admissions: hits.reduce((sum, hit) => sum + hit.admissions, 0), rows: hits.reduce((sum, hit) => sum + hit.rows, 0) } };
};

const MAX_ITEMS = 6;
/**
 * A measurement named only by its words: the laboratory items (blood) or, failing that, the chart items whose dictionary label carries
 * all of them. A specimen other than blood (urine, ascites, pleural fluid) is never taken. The unit is the commonest one of the items.
 */
export const proposeItemDefinition = (index: DictionaryIndex, term: string, synonyms?: SynonymTable): ProposedDefinition | undefined => {
  let hits: ReturnType<DictionaryIndex["search"]> = []; let query = "";
  for (const form of alternativeForms(term, synonyms)) { query = nameWords(form); if (!query) continue; hits = index.search("item", query, 200).filter((hit) => hit.rows > 0 && hit.id !== undefined); if (hits.length) break; }
  const labs = hits.filter((hit) => hit.table === "labevents" && /^blood$/iu.test(hit.fluid ?? ""));
  const charts = hits.filter((hit) => hit.table === "chartevents");
  const chosen = (labs.length ? labs : charts).slice(0, MAX_ITEMS);
  if (!chosen.length || chosen.reduce((sum, hit) => sum + hit.admissions, 0) < MIN_ADMISSIONS) return undefined;
  const units = new Map<string, number>(); for (const hit of chosen) for (const [unit, count] of hit.units ?? []) units.set(unit, (units.get(unit) ?? 0) + count);
  const unit = [...units.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const definition: VariableDefinition = {
    schema_version: "1.0.0", definition_id: slug(term), version: "1.0.0", kind: "lab_or_chart", labels: { en: term }, synonyms: [],
    meaning: `Dictionary items whose label carries “${query}” (${labs.length ? "laboratory, blood" : "charted"}), drafted by the platform from the dictionary; not reviewed.`,
    status: "researcher_defined", author: DRAFT_AUTHOR, items: { table: chosen[0]!.table as "labevents" | "chartevents", item_ids: chosen.map((hit) => hit.id!), ...(unit ? { unit } : {}), aggregation: "mean" },
  };
  return { definition, facts: { codes: chosen.length, admissions: chosen.reduce((sum, hit) => sum + hit.admissions, 0), rows: chosen.reduce((sum, hit) => sum + hit.rows, 0) } };
};
