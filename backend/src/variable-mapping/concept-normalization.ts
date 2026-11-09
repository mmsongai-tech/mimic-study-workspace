export type ConceptLanguage = "zh" | "en" | "mixed" | "unknown";

export interface NormalizedClinicalConcept {
  input: string;
  normalized: string;
  language: ConceptLanguage;
  tokens: string[];
  surface_forms: string[];
}

const normalizeText = (value: string): string => value
  .normalize("NFKC")
  .toLocaleLowerCase("en-US")
  .replaceAll(/[_–—-]+/gu, " ")
  .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
  .replaceAll(/\s+/gu, " ")
  .trim();

const detectLanguage = (value: string): ConceptLanguage => {
  const hasChinese = /\p{Script=Han}/u.test(value);
  const hasLatin = /\p{Script=Latin}/u.test(value);
  return hasChinese && hasLatin ? "mixed" : hasChinese ? "zh" : hasLatin ? "en" : "unknown";
};

/** Creates a stable, language-aware search representation without choosing a clinical meaning. */
export const normalizeClinicalConcept = (input: string): NormalizedClinicalConcept => {
  const value = input.trim();
  const normalized = normalizeText(value);
  const tokens = normalized ? normalized.split(" ") : [];
  const compact = normalized.replaceAll(" ", "");
  return {
    input,
    normalized,
    language: detectLanguage(value),
    tokens,
    surface_forms: [...new Set([value, normalized, compact].filter(Boolean))],
  };
};
