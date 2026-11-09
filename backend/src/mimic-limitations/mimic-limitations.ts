import { readFile } from "node:fs/promises";
import type { SlotCategory, StudyFrame } from "../study-framing/index.js";

export interface LimitationText { en: string; zh: string }
export interface LimitationEntry {
  id: string;
  applies_to: "always" | { categories?: SlotCategory[]; keywords?: string[]; outcome_categories?: SlotCategory[] };
  statement: LimitationText;
  proxy?: LimitationText;
  /** How an outcome component this entry matches is handled: replaced by a measurable concept, or excluded. */
  outcome_rule?: { action: "substitute"; concept_en: string; concept_zh: string } | { action: "exclude_component" };
  /**
   * How a whole aim is handled: `cap_follow_up` limits a longer outcome horizon to what MIMIC-IV observes (matched on
   * the outcome); `not_answerable` stops an aim whose `slot` names something MIMIC-IV does not contain.
   */
  frame_rule?: { action: "cap_follow_up"; max_days: number; capped_label: LimitationText } | { action: "not_answerable"; slot: "population" | "exposure" | "outcome"; /** Further slots the same keywords are checked in. */ also_slots?: Array<"population" | "exposure" | "outcome">; /** The keywords are looked for in the whole sub-question, not only in the slots (wording about timing sits outside them). */ in_question?: boolean; keywords: string[]; /** With `in_question`: regular expressions (case-insensitive) for wording a fixed phrase cannot hold, such as "should <drug> be used". */ patterns?: string[] };
}

export interface FrameAssessment {
  follow_up_cap?: { max_days: number; capped_label: LimitationText; reason: LimitationText };
  not_answerable?: { slot: "population" | "exposure" | "outcome"; text: string; reason: LimitationText };
}

const slotWords = (slot: StudyFrame["population"]): string => slot ? `${slot.text} ${slot.qualified_text ?? ""} ${slot.normalized?.label_en ?? ""}`.toLocaleLowerCase() : "";
/** Applies the knowledge base's frame rules to one aim; the caller decides how to change the frame. */
export const assessFrame = (knowledge: LimitationKnowledgeBase, frame: StudyFrame): FrameAssessment => {
  const assessment: FrameAssessment = {};
  for (const entry of knowledge.entries) {
    const rule = entry.frame_rule;
    if (!rule) continue;
    if (rule.action === "not_answerable" && !assessment.not_answerable) {
      if (rule.in_question && (rule.keywords.some((keyword) => frame.sub_question.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) || (rule.patterns ?? []).some((pattern) => new RegExp(pattern, "iu").test(frame.sub_question)))) { assessment.not_answerable = { slot: rule.slot, text: frame[rule.slot]?.text ?? frame.sub_question, reason: entry.statement }; continue; }
      for (const name of [rule.slot, ...(rule.also_slots ?? [])]) {
        // A description's characteristics stand where an outcome would: a rule on the outcome holds for each of them.
        const slot = [frame[name], ...(name === "outcome" ? frame.characteristics ?? [] : [])].find((candidate) => candidate && rule.keywords.some((keyword) => slotWords(candidate).includes(keyword.toLocaleLowerCase())));
        if (slot) { assessment.not_answerable = { slot: name, text: slot.text, reason: entry.statement }; break; }
      }
    }
    if (rule.action === "cap_follow_up" && entry.applies_to !== "always" && (entry.applies_to.keywords ?? []).some((keyword) => [frame.outcome, ...(frame.characteristics ?? [])].some((slot) => slotWords(slot).includes(keyword.toLocaleLowerCase())))) {
      assessment.follow_up_cap = { max_days: rule.max_days, capped_label: rule.capped_label, reason: entry.statement };
    }
  }
  return assessment;
};

export interface ComponentAssessment {
  kept: Array<{ text: string; concept_en: string; substituted_from?: string }>;
  excluded: Array<{ text: string; reason: LimitationText }>;
}

/**
 * Decides, per composite-outcome component, whether MIMIC-IV can measure it: a component with a substitute rule is
 * replaced by the measurable concept (e.g. cardiovascular death → all-cause death); a component of an excluded outcome
 * category (e.g. an event known only from index-admission diagnosis codes) is dropped with the reason; others are kept.
 */
export const assessOutcomeComponents = (knowledge: LimitationKnowledgeBase, components: Array<{ text: string; label_en?: string; category?: SlotCategory }>): ComponentAssessment => {
  const assessment: ComponentAssessment = { kept: [], excluded: [] };
  for (const component of components) {
    const text = `${component.text} ${component.label_en ?? ""}`.toLocaleLowerCase();
    const substitute = knowledge.entries.find((entry) => entry.outcome_rule?.action === "substitute" && entry.applies_to !== "always" && (entry.applies_to.keywords ?? []).some((keyword) => text.includes(keyword.toLocaleLowerCase())));
    if (substitute?.outcome_rule?.action === "substitute") { assessment.kept.push({ text: component.text, concept_en: substitute.outcome_rule.concept_en, substituted_from: component.text }); continue; }
    const exclusion = knowledge.entries.find((entry) => entry.outcome_rule?.action === "exclude_component" && entry.applies_to !== "always" && component.category !== undefined && (entry.applies_to.outcome_categories ?? []).includes(component.category));
    if (exclusion) { assessment.excluded.push({ text: component.text, reason: exclusion.statement }); continue; }
    assessment.kept.push({ text: component.text, concept_en: component.label_en ?? component.text });
  }
  // Two components substituted by the same concept (e.g. two cause-specific deaths) are one outcome.
  assessment.kept = [...new Map(assessment.kept.map((item) => [item.concept_en.toLocaleLowerCase(), item])).values()];
  return assessment;
};
export interface LimitationKnowledgeBase { schema_version: "1.0.0"; knowledge_version: string; data_source: string; provenance: string; entries: LimitationEntry[] }
export interface MatchedLimitation { id: string; statement: LimitationText; proxy?: LimitationText; frame_ids: string[] }

/** Reads the versioned limitations file; the only place this module touches the filesystem. */
export class FileLimitationKnowledgeBaseRepository {
  constructor(private readonly file: URL) {}
  async load(): Promise<LimitationKnowledgeBase> {
    const parsed = JSON.parse(await readFile(this.file, "utf8")) as LimitationKnowledgeBase;
    if (parsed.schema_version !== "1.0.0" || !Array.isArray(parsed.entries)) throw new Error("The MIMIC limitations knowledge base has an unsupported format.");
    return parsed;
  }
}

const frameText = (frame: StudyFrame): string => [frame.sub_question, frame.population, frame.exposure, frame.outcome, ...frame.modifiers, ...frame.mediators, ...frame.predictors, ...(frame.characteristics ?? [])]
  .flatMap((item) => typeof item === "string" ? [item] : item ? [item.text, item.normalized?.label_en ?? "", ...(item.components ?? []), ...(item.categories ?? [])] : [])
  .join(" ").toLocaleLowerCase();
const frameCategories = (frame: StudyFrame): Set<SlotCategory> => new Set([frame.population, frame.exposure, frame.outcome, ...frame.modifiers, ...frame.mediators, ...frame.predictors, ...(frame.characteristics ?? [])]
  .flatMap((slot) => slot?.normalized ? [slot.normalized.category] : []));
const outcomeCategories = (frame: StudyFrame): Set<SlotCategory> => new Set([
  ...(frame.outcome?.normalized ? [frame.outcome.normalized.category] : []),
  ...(frame.outcome?.components_normalized ?? []).map(({ category }) => category),
  ...(frame.characteristics ?? []).flatMap((slot) => slot.normalized ? [slot.normalized.category] : []),
]);

/**
 * Selects the limitations that apply to a question's frames. "always" entries apply once per question; the others
 * apply when a frame has a slot of a listed data category or mentions a listed keyword (English or Chinese).
 */
export const matchLimitations = (knowledge: LimitationKnowledgeBase, frames: StudyFrame[]): MatchedLimitation[] => knowledge.entries.flatMap((entry) => {
  if (entry.applies_to === "always") return [{ id: entry.id, statement: entry.statement, ...(entry.proxy ? { proxy: entry.proxy } : {}), frame_ids: frames.map(({ frame_id }) => frame_id) }];
  const rule = entry.applies_to;
  const matched = frames.filter((frame) => {
    const categories = frameCategories(frame); const text = frameText(frame);
    return (rule.categories ?? []).some((category) => categories.has(category)) || (rule.keywords ?? []).some((keyword) => text.includes(keyword.toLocaleLowerCase()))
      || (rule.outcome_categories ?? []).some((category) => outcomeCategories(frame).has(category));
  });
  return matched.length ? [{ id: entry.id, statement: entry.statement, ...(entry.proxy ? { proxy: entry.proxy } : {}), frame_ids: matched.map(({ frame_id }) => frame_id) }] : [];
});

/** Report-ready sentences in one language, with the frames each applies to and the proxy used. */
export const limitationSentences = (matched: MatchedLimitation[], language: "en" | "zh"): string[] => matched.map(({ statement, proxy, frame_ids }) =>
  `${statement[language]}${proxy ? (language === "zh" ? ` 替代方案：${proxy.zh}` : ` Proxy used: ${proxy.en}`) : ""}${frame_ids.length ? ` [${frame_ids.join(", ")}]` : ""}`);
