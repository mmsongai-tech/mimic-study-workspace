import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MimicTerminologyMatch } from "./terminology-gateway.js";
import { variableDictionaryEvidenceKey, type VariableMappingRecord } from "./variable-mapping.js";

/** `counted_local_forms`: the groups of `local_dosage_forms` that are this class's own route (eye forms for ophthalmic beta blockers); every other locally applied form is left out. */
export interface DrugClass { class_id: string; atc: string; labels: { en: string; zh: string }; synonyms: string[]; ingredients: string[]; counted_local_forms?: string[] }
/**
 * `ingredient_names`: other names (Chinese names, trade or international names) of an ingredient, matched by rule so a small model never has to translate a drug name. `label_exclusions`: prescription labels containing the listed words are not counted for that ingredient (valsartan excludes the sacubitril combination, a different drug).
 * `local_dosage_forms`: words, by group, that name a locally applied dosage form ("oint", "ophth", "enema"); a label naming one, as a whole word, is left out of every class that does not count that group.
 */
export interface DrugClassKnowledge { schema_version: "1.0.0"; knowledge_version: string; provenance: string; classes: DrugClass[]; label_exclusions?: Record<string, string[]>; ingredient_names?: Record<string, string[]>; local_dosage_forms?: Record<string, string[]> }

const key = (value: string): string => value.normalize("NFKC").toLocaleLowerCase().replaceAll("β", "beta").replaceAll(/[^\p{L}\p{N}]+/gu, "");

/** Reads the versioned drug-class file; the only filesystem access of this concern. */
export class FileDrugClassRepository {
  constructor(private readonly file: URL) {}
  async load(): Promise<DrugClassKnowledge> {
    const parsed = JSON.parse(await readFile(this.file, "utf8")) as DrugClassKnowledge;
    if (parsed.schema_version !== "1.0.0" || !Array.isArray(parsed.classes)) throw new Error("The drug-class knowledge file has an unsupported format.");
    // A misspelt group would silently leave a class's own route out.
    const unknown = parsed.classes.flatMap(({ counted_local_forms }) => counted_local_forms ?? []).filter((group) => !(group in (parsed.local_dosage_forms ?? {})));
    if (unknown.length) throw new Error(`The drug-class knowledge file counts unknown local dosage forms: ${[...new Set(unknown)].join(", ")}.`);
    return parsed;
  }
}

/**
 * The locally applied dosage forms a prescription label names ("Lidocaine 5% /diltiazem oint" → topical). Whole words only, so an
 * abbreviation is found wherever it stands and a word that merely starts like a form ("gelcap", "supplement") is not one.
 */
export const localDosageForms = (knowledge: DrugClassKnowledge, label: string): string[] => {
  const words = new Set(label.normalize("NFKC").toLocaleLowerCase().match(/\p{L}+/gu) ?? []);
  return Object.entries(knowledge.local_dosage_forms ?? {}).filter(([, forms]) => forms.some((form) => words.has(form))).map(([group]) => group);
};

/** A label counts for a class unless it names only locally applied forms the class does not count (a rectal opioid is systemic, a nifedipine ointment is not a calcium-channel blocker). */
const countsForClass = (knowledge: DrugClassKnowledge, drugClass: DrugClass, label: string): boolean => {
  const forms = localDosageForms(knowledge, label);
  return !forms.length || forms.some((group) => drugClass.counted_local_forms?.includes(group));
};

/**
 * A drug named with how it was given ("beta-blocker use", "statin therapy", "他汀使用") is the drug: these words are dropped before the name
 * is looked up, so the result does not depend on whether the model happened to keep or drop them.
 */
const USE_WORDS = /\b(?:use|used|using|usage|therapy|treatment|treated|administration|administered|exposure|medication|medications|drug|drugs)\b|使用|用药|治疗|药物|药品/giu;
const withoutUseWords = (term: string): string => term.replaceAll(USE_WORDS, " ").trim();

/** Finds the class a requested term names (label or synonym, ignoring case, spacing and punctuation; plural "s" tolerated). */
export const matchDrugClass = (knowledge: DrugClassKnowledge, term: string | undefined): DrugClass | undefined => {
  if (!term) return undefined;
  const stripped = withoutUseWords(term);
  if (stripped && stripped !== term.trim()) { const named = matchDrugClass(knowledge, stripped); if (named) return named; }
  const wanted = key(term);
  if (wanted.length < 3) return undefined;
  return knowledge.classes.find((drugClass) => [drugClass.labels.en, drugClass.labels.zh, ...drugClass.synonyms].some((name) => {
    const candidate = key(name);
    return candidate === wanted || `${candidate}s` === wanted || candidate === `${wanted}s`;
  }));
};

/** The catalog ingredient a term names (by its English name or a listed other name, "奥美沙坦" → olmesartan), or undefined. */
export const ingredientFor = (knowledge: DrugClassKnowledge, term: string | undefined): string | undefined => {
  if (!term) return undefined;
  const stripped = withoutUseWords(term);
  if (stripped && stripped !== term.trim()) { const named = ingredientFor(knowledge, stripped); if (named) return named; }
  const wanted = key(term);
  if (wanted.length < 2) return undefined;
  for (const [ingredient, names] of Object.entries(knowledge.ingredient_names ?? {})) if (key(ingredient) === wanted || names.some((name) => key(name) === wanted)) return ingredient;
  return knowledge.classes.flatMap((drugClass) => drugClass.ingredients).find((ingredient) => key(ingredient) === wanted);
};

/** True when the term names one ingredient of some class ("candesartan"), not the class itself. */
export const namesIngredient = (knowledge: DrugClassKnowledge, term: string | undefined): boolean => Boolean(ingredientFor(knowledge, term));

/** One ingredient of a class as a class of its own, so a named drug maps to its own labels by the same deterministic rule. */
export const ingredientClass = (knowledge: DrugClassKnowledge, term: string | undefined): DrugClass | undefined => {
  const ingredient = ingredientFor(knowledge, term);
  if (!ingredient) return undefined;
  // An ingredient can be in a class and in a wider one (warfarin: vitamin K antagonists and oral anticoagulants); it takes the ATC and the
  // counted forms of its narrowest class, whatever the order of the file.
  const parent = knowledge.classes.filter((drugClass) => drugClass.ingredients.includes(ingredient)).reduce((narrowest, drugClass) => drugClass.ingredients.length < narrowest.ingredients.length ? drugClass : narrowest);
  return { class_id: `ingredient_${ingredient}`, atc: parent.atc, labels: { en: `${ingredient[0]!.toUpperCase()}${ingredient.slice(1)}`, zh: ingredient }, synonyms: [term!], ingredients: [ingredient], ...(parent.counted_local_forms ? { counted_local_forms: parent.counted_local_forms } : {}) };
};

/**
 * A drug the catalogue does not list ("heparin", "mupirocin") as a class of its own. Nothing says which route is its own, so every
 * form is counted, as before the local-form rule.
 */
export const uncataloguedIngredientClass = (knowledge: DrugClassKnowledge, name: string, term: string): DrugClass => ({
  class_id: `ingredient_${name}`, atc: "not catalogued", labels: { en: `${name[0]!.toUpperCase()}${name.slice(1)}`, zh: name }, synonyms: [term], ingredients: [name], counted_local_forms: Object.keys(knowledge.local_dosage_forms ?? {}),
});

/**
 * A class exposure is every prescription label that contains one of its member ingredients' names, except labels of a
 * locally applied form the class does not count. Selection is a deterministic rule over the local dictionary, so the
 * mapping records the class knowledge version it came from.
 */
export const drugClassMapping = (knowledge: DrugClassKnowledge, drugClass: DrugClass, requestedTerm: string, matches: MimicTerminologyMatch[], now: string): VariableMappingRecord | undefined => {
  const leftOut = Object.keys(knowledge.local_dosage_forms ?? {}).filter((group) => !drugClass.counted_local_forms?.includes(group));
  const labels = [...new Map(matches
    .filter(({ dictionary, label }) => dictionary === "prescriptions_drug" && countsForClass(knowledge, drugClass, label) && drugClass.ingredients.some((ingredient) => label.toLocaleLowerCase().includes(ingredient) && !(knowledge.label_exclusions?.[ingredient] ?? []).some((word) => label.toLocaleLowerCase().includes(word))))
    .map((match) => [match.identifier, match])).values()].sort((a, b) => a.identifier.localeCompare(b.identifier));
  if (!labels.length) return undefined;
  const values = labels.map(({ identifier }) => identifier);
  const identity = createHash("sha256").update(JSON.stringify([drugClass.class_id, knowledge.knowledge_version, values])).digest("hex").slice(0, 16);
  return {
    schema_version: "1.0.0", mapping_id: `mimic-iv.drug-class.${drugClass.class_id}.${identity}.v1`, concept_id: drugClass.class_id.startsWith("ingredient_") ? `drug_${drugClass.class_id.slice("ingredient_".length)}` : `drug_class_${drugClass.class_id}`, mapping_version: knowledge.knowledge_version,
    labels: { en: `${drugClass.labels.en} (ATC ${drugClass.atc})`, zh: drugClass.labels.zh }, synonyms: [...new Set([requestedTerm, drugClass.labels.en, ...drugClass.synonyms])],
    category: "medication", value_type: "binary",
    definition: {
      summary: `Any prescription of a ${drugClass.labels.en.toLowerCase()} member: ${drugClass.ingredients.join(", ")}.`,
      temporal_rule: "Apply the StudySpec exposure window to prescription start times.", aggregation: "any",
      value_rule: `Presence of one of ${values.length} local prescription labels containing a member ingredient name (combination products included${leftOut.length ? `; labels of a locally applied form left out: ${leftOut.join(", ")}` : ""}).`,
      missingness_rule: "No matching prescription in the window is treated as unexposed during the index admission.",
    },
    sources: [{ kind: "medication_label", schema: "mimiciv_hosp", table: "prescriptions", columns: ["subject_id", "hadm_id", "starttime", "stoptime", "drug", "dose_val_rx", "dose_unit_rx", "route"], dictionary_table: "prescriptions_drug", value_filters: [{ column: "drug", values }] }],
    status: "validated", provenance: "realtime_discovery",
    evidence: {
      dictionary_entries: labels.map((match) => { const entry = { dictionary: match.dictionary, identifier: match.identifier, label: match.label }; return { evidence_key: variableDictionaryEvidenceKey(entry), ...entry }; }),
      derived_from: { mapping_id: `drug-class:${drugClass.class_id}`, mapping_version: knowledge.knowledge_version },
    },
    created_at: now, updated_at: now,
  };
};
