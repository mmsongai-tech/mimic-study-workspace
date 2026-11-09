/**
 * Fidelity of a match: does the chosen concept carry everything the requested term says?
 *
 * Matching by containment is generous in one direction by design ("serum albumin" finds Albumin). Its danger is the other
 * direction: a request with a qualifier the concept does not carry ("type 2 myocardial infarction", "HbA1c", "CRP to albumin ratio",
 * "sepsis with myocardial injury") still contains the concept's name, so the concept looks like a match and the qualifier is dropped
 * without any message. A word of the request that the concept's names do not carry is therefore reported, and the mapping then needs
 * confirmation instead of resolving.
 *
 * Only a short closed list of words is ignored: grammar words, words that say how a thing was measured or given ("use", "level",
 * "serum"), and time words that the study frame carries separately. The list does not grow with failures; a word outside it is a
 * qualifier until a concept names it.
 */
const GRAMMAR = ["a", "an", "the", "of", "in", "on", "at", "to", "for", "by", "with", "and", "or", "as", "than", "among", "from", "per", "between"];
const MEASUREMENT = ["use", "used", "using", "usage", "therapy", "treatment", "treated", "administration", "administered", "exposure", "supplementation", "level", "value", "measurement", "measured", "concentration", "count", "test", "result", "infusion", "injection", "receptor", "dose", "dosage", "rate", "risk", "incidence", "occurrence", "total", "any", "patient", "patients", "serum", "plasma", "blood", "arterial", "venous", "whole"];
const TIME = ["day", "hour", "week", "month", "year", "first", "within", "before", "during", "after", "prior", "hospitalization", "hospitalisation", "hospital", "icu", "stay", "admission", "baseline", "early", "late", "long", "short", "term"];
// Plural "s", and the verb and noun forms of the same action ("ventilated", "ventilation", "ventilating" all read as "ventilat").
const stem = (word: string): string => {
  const plural = word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
  return /(?:ated|ating)$/u.test(plural) && plural.length > 6 ? plural.replace(/(?:ed|ing)$/u, "") : /ation$/u.test(plural) && plural.length > 7 ? plural.slice(0, -3) : plural;
};
const IGNORED = new Set([...GRAMMAR, ...MEASUREMENT, ...TIME].map(stem));

const HORIZON = /\d+\s*-?\s*(?:day|hour|week|month|year)s?/gu;
const words = (text: string): string[] => text.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(HORIZON, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem);

/** Words of `requested` that none of `names` carries; empty when the concept covers the request. Han text is not judged here. */
export const uncoveredWords = (requested: ReadonlyArray<string | undefined>, names: ReadonlyArray<string | undefined>): string[] => {
  const form = judgedForm(requested);
  if (!form) return [];
  const aliasSets = names.filter((name): name is string => Boolean(name) && !/\p{Script=Han}/u.test(name as string)).map((name) => new Set(words(name)));
  const content = words(form).filter((word) => !IGNORED.has(word));
  // One alias must carry the whole request.
  return aliasSets.length ? aliasSets.map((alias) => content.filter((word) => !alias.has(word))).reduce((a, b) => b.length < a.length ? b : a) : content;
};

/**
 * The text a match is judged against: the words the researcher wrote when they are English, because a model's normalised label may
 * have dropped a qualifier ("sepsis with myocardial injury" normalised to "sepsis"); the model's English label only when the request is
 * not English (the Chinese words cannot be compared with English names). Undefined when there is nothing English to judge.
 */
const judgedForm = (requested: ReadonlyArray<string | undefined>): string | undefined => {
  const [written, ...others] = requested;
  if (written && !/\p{Script=Han}/u.test(written)) return written;
  return others.find((text): text is string => Boolean(text) && !/\p{Script=Han}/u.test(text as string));
};

/**
 * Does one dictionary entry carry enough of the request to belong to its mapping? Most of the content words must be in the entry's
 * name (all of them when there are two or fewer), so "acute kidney injury" accepts the dictionary's "Acute kidney failure" while
 * "type 2 myocardial infarction" refuses "ST elevation myocardial infarction of anterior wall".
 */
export const entryCarriesRequest = (requested: ReadonlyArray<string | undefined>, label: string): boolean => {
  const form = judgedForm(requested);
  if (!form || /\p{Script=Han}/u.test(label)) return true;
  const have = new Set(words(label));
  const content = words(form).filter((word) => !IGNORED.has(word));
  if (!content.length) return true;
  const covered = content.filter((word) => have.has(word)).length;
  return content.length <= 2 ? covered === content.length : covered / content.length >= 0.6;
};

/**
 * Raised whenever a rule that decides what a live search may map changes (this file, the entry coverage, the resolver's guards).
 * A store that holds mappings found under an older version drops them and finds them again.
 */
export const DISCOVERY_RULES_VERSION = "2026-10-25.fidelity-7";

/** The words of a request that carry its meaning (grammar, measurement and time words removed). */
export const contentWords = (text: string): string[] => words(text).filter((word) => !IGNORED.has(word));
