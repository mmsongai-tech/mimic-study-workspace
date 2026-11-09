import type { FrameSlot, StudyFrame } from "./domain/study-frame.js";

/**
 * Nothing a question names should vanish silently. Every clinical concept the question names must appear in one of the frame's
 * slots (population, exposure, comparator, outcome, modifiers, mediators, predictors, characteristics); a concept that does not is reported to the
 * researcher at plan confirmation, so a dropped condition or drug is seen instead of discovered in the numbers.
 */
export interface NamedConcept { id: string; label: string; names: readonly string[]; category?: string }

const HAN = /\p{Script=Han}/u;
const normalize = (text: string): string => text.toLowerCase().replace(/[\s\-_()（）[\]/]+/gu, " ").trim();
const longEnough = (name: string): boolean => (HAN.test(name) ? (name.match(/\p{Script=Han}/gu) ?? []).length >= 2 : name.replace(/[^a-z0-9]/giu, "").length >= 4);

/** Builds a finder that returns the concepts whose name occurs in a text. A Latin name must match whole words; a Chinese name matches as a substring. */
export const buildConceptFinder = (concepts: readonly NamedConcept[]): ((text: string) => Set<string>) => {
  const entries = concepts.map((concept) => ({ id: concept.id, names: [...new Set([concept.label, ...concept.names].filter(longEnough).map(normalize))] }));
  return (text) => {
    const haystack = ` ${normalize(text)} `; const compact = haystack.replaceAll(" ", "");
    const found = new Set<string>();
    for (const { id, names } of entries) {
      if (names.some((name) => HAN.test(name) ? compact.includes(name.replaceAll(" ", "")) : haystack.includes(` ${name} `))) found.add(id);
    }
    return found;
  };
};

/**
 * The drugs a text names as written ("senna", "docusate sodium"): ingredient concepts only, longest name first, a name inside a longer
 * found name dropped. Undefined unless at least two different ingredients are named, so a one-drug text is untouched.
 */
export const drugNamesIn = (concepts: readonly NamedConcept[], text: string): string[] | undefined => {
  const lower = text.toLowerCase(); const found: Array<{ id: string; start: number; end: number }> = [];
  for (const concept of concepts) {
    if (concept.category !== "medication" || !concept.id.startsWith("drug:")) continue;
    for (const name of [...new Set([concept.label, ...concept.names].filter(longEnough))].sort((a, b) => b.length - a.length)) {
      const needle = name.toLowerCase(); let from = 0;
      while (true) {
        const at = HAN.test(needle) ? lower.indexOf(needle, from) : lower.search(new RegExp(`(?<![a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "u"));
        if (at < 0 || (!HAN.test(needle) && at < from)) break;
        found.push({ id: concept.id, start: at, end: at + needle.length }); break;
      }
    }
  }
  const kept = found.filter((item) => !found.some((other) => other !== item && other.start <= item.start && other.end >= item.end && (other.end - other.start) > (item.end - item.start)));
  const byId = new Map<string, { start: number; end: number }>(); for (const item of kept.sort((a, b) => a.start - b.start)) if (!byId.has(item.id)) byId.set(item.id, item);
  const names = [...byId.values()].sort((a, b) => a.start - b.start).map(({ start, end }) => text.slice(start, end));
  return names.length >= 2 ? names : undefined;
};

const slotTexts = (slot: FrameSlot | undefined): string[] => slot ? [slot.text, slot.qualified_text, slot.normalized?.label_en, ...(slot.categories ?? []), ...(slot.categories_normalized ?? []).flatMap((item) => [item.text, item.label_en]), ...(slot.components ?? [])].filter((value): value is string => Boolean(value)) : [];

/** Concepts named in the frame's sub-question that no slot of the frame carries (ids of the named concepts). */
export const unaccountedConcepts = (frame: StudyFrame, find: (text: string) => Set<string>): string[] => {
  const named = find(frame.sub_question);
  if (!named.size) return [];
  const carried = [frame.population, frame.exposure, frame.outcome, ...frame.modifiers, ...frame.mediators, ...frame.predictors, ...(frame.characteristics ?? [])].flatMap(slotTexts);
  const comparator = frame.comparator ? [frame.comparator.text, ...(frame.comparator.levels ?? []), ...(frame.comparator.levels_normalized ?? []).flatMap((item) => [item.text, item.label_en])].filter((value): value is string => Boolean(value)) : [];
  const used = new Set<string>();
  for (const text of [...carried, ...comparator]) for (const id of find(text)) used.add(id);
  return [...named].filter((id) => !used.has(id));
};

/** `attribute`: a yes/no property of the admission that defines who is studied ("discharged alive", "emergency admission"). */
const POPULATION_CATEGORIES = new Set(["diagnosis", "intervention", "medication", "attribute"]);

/**
 * A population phrase that names two or more conditions or treatments ("mechanically ventilated patients with sepsis") is their
 * conjunction. Returns the labels of the concepts found, longest names first and a name inside a longer found name dropped
 * ("diabetes" inside "type 2 diabetes"); undefined unless at least two remain, so a one-condition phrase is untouched.
 */
export const populationConcepts = (concepts: readonly NamedConcept[], text: string): string[] | undefined => {
  const haystack = ` ${normalize(text)} `; const compact = haystack.replaceAll(" ", "");
  const found: Array<{ label: string; name: string }> = [];
  for (const concept of concepts) {
    if (!concept.category || !POPULATION_CATEGORIES.has(concept.category)) continue;
    const names = [...new Set([concept.label, ...concept.names].filter(longEnough).map(normalize))].filter((name) => HAN.test(name) ? compact.includes(name.replaceAll(" ", "")) : haystack.includes(` ${name} `));
    const longest = names.sort((a, b) => b.length - a.length)[0];
    if (longest) found.push({ label: concept.label, name: longest });
  }
  const kept = found.filter((item) => !found.some((other) => other !== item && other.name.length > item.name.length && other.name.includes(item.name)));
  const labels = [...new Set(kept.map((item) => item.label))];
  return labels.length >= 2 ? labels : undefined;
};
