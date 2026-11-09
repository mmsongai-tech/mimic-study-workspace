import { readFileSync } from "node:fs";
import type { StructuredChatAudit, StructuredChatPrompt, StructuredChatRequest } from "../model-output/index.js";
import { aimFromCues, buildFrames, dropDuplicateFrames, mergeHorizonFrames, ratioParts, withOverallDoseResponse } from "./frame-rules.js";
import { populationConjunction } from "./study-spec-compiler.js";
import { deriveStudyType, type FrameExtraction, type FrameSlot, type FramingAim, type SlotCategory, type StudyFrame, type StudyFrameSet } from "./domain/study-frame.js";

const loadSchema = (name: string): object => JSON.parse(readFileSync(new URL(`../../../contracts/study-framing/${name}`, import.meta.url), "utf8")) as object;
const SPLIT_SCHEMA = { id: "question-split", version: "1.0.0", json: loadSchema("question-split.schema.json") };
const EXTRACTION_SCHEMA = { id: "frame-extraction", version: "1.0.0", json: loadSchema("frame-extraction.schema.json") };

/** The only model capability this module needs; OpenAiCompatibleStructuredChatClient satisfies it. */
export interface StructuredModel { call<T>(request: StructuredChatRequest<T>): Promise<{ value: T; audit: StructuredChatAudit }> }

/** Optional English label and data category for a slot phrase; supplied by the mapping side at composition. */
export interface SlotNormalizer { normalize(input: { text: string; role: string }): Promise<{ label_en: string; category: SlotCategory; source?: "catalog" | "model" }> }

export class StudyFramingError extends Error {
  /** `failure_class`: the failing model call's class (MODEL_UNREACHABLE, MODEL_TIMEOUT, PROVIDER_HTTP_404, JSON_PARSE_FAILED, ...), when known. */
  constructor(readonly code: "FRAMING_MODEL_FAILED", message: string, readonly audits: StructuredChatAudit[], readonly failure_class?: string) { super(message); }
}

const trimmed = (value: string): string => value.trim();
const items = (values: string[]): string[] => [...new Set(values.map(trimmed).filter(Boolean))];

/** Removes empty list items and a composite name repeated among its own components; never adds meaning. */
export const sanitizeFrameExtraction = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  for (const key of ["population", "exposure", "comparator", "composite_outcome", "time_window"]) if (typeof record[key] === "string") record[key] = trimmed(record[key] as string);
  for (const key of ["exposure_categories", "outcomes", "modifiers", "mediators", "predictors"]) if (Array.isArray(record[key])) record[key] = items((record[key] as unknown[]).filter((item): item is string => typeof item === "string"));
  if (typeof record.composite_outcome === "string" && Array.isArray(record.outcomes)) record.outcomes = (record.outcomes as string[]).filter((item) => item !== record.composite_outcome);
  // In a group comparison the grouping variable is the exposure; recover it when the model copied an outcome there.
  const modifiers = record.modifiers as string[] | undefined; const outcomes = record.outcomes as string[] | undefined;
  if (record.goal === "compare_groups" && typeof record.exposure === "string" && outcomes?.includes(record.exposure) && modifiers?.length) {
    record.exposure = modifiers[0];
    record.modifiers = modifiers.slice(1);
  }
  return record;
};

/** Rules a schema cannot express; violations trigger one model repair turn. */
const HAN = /\p{Script=Han}/u;
export const frameExtractionProblems = (extraction: FrameExtraction, aim: FramingAim = "main", subQuestion?: string): string[] => {
  const problems: string[] = [];
  // Phrases are copied, never translated: a question without Chinese cannot yield Chinese phrases (a translated
  // phrase loses words, e.g. "patients admitted with diabetic ketoacidosis" became "患者").
  if (subQuestion && !HAN.test(subQuestion)) {
    const translated = [extraction.population, extraction.exposure, extraction.comparator, extraction.composite_outcome, extraction.time_window, ...extraction.outcomes, ...extraction.exposure_categories, ...extraction.modifiers, ...extraction.mediators, ...extraction.predictors].filter((phrase) => phrase && HAN.test(phrase));
    if (translated.length) problems.push(`copy phrases from the question in English without translating; these are not in the question: ${translated.map((phrase) => `"${phrase}"`).join(", ")}.`);
  }
  if (aim === "effect_modification" && !extraction.modifiers.length && extraction.goal !== "compare_groups") problems.push(`aim effect_modification needs the modifying factor in "modifiers".`);
  if (aim === "mediation" && !extraction.mediators.length) problems.push(`aim mediation needs every mediating variable in "mediators".`);
  const needsExposure = ["compare_groups", "relate_factor", "evaluate_treatment"].includes(extraction.goal);
  if (needsExposure && !extraction.exposure) problems.push(`goal ${extraction.goal} needs the exposure or grouping variable in "exposure".`);
  if ((needsExposure || extraction.goal === "predict") && !extraction.outcomes.length && !extraction.composite_outcome) problems.push(`goal ${extraction.goal} needs at least one item in "outcomes".`);
  if (extraction.goal === "predict" && extraction.outcome_kind === "none") problems.push(`goal predict needs an outcome_kind other than "none".`);
  if (extraction.exposure && extraction.outcomes.includes(extraction.exposure)) problems.push(`"${extraction.exposure}" cannot be both the exposure and an outcome.`);
  if (extraction.modifiers.includes(extraction.exposure) && extraction.exposure) problems.push(`"${extraction.exposure}" cannot be both the exposure and a modifier.`);
  return problems;
};

/**
 * A drug named as the exposure makes a treatment question whatever verb the question uses ("compare", "relate", "differ"):
 * the patients who receive a drug differ from those who do not, so the comparison must be adjusted for illness severity
 * and weighted, which a plain group comparison or interaction model does not do.
 */
export const asTreatmentQuestions = (frames: StudyFrame[]): void => {
  for (const frame of frames) {
    const levels = frame.exposure?.categories_normalized;
    const medication = frame.exposure?.normalized?.category === "medication" || Boolean(levels?.length && levels.every(({ category }) => category === "medication"));
    if (!medication || frame.facets.dose_question || !["compare_groups", "relate_factor"].includes(frame.facets.goal)) continue;
    frame.facets = { ...frame.facets, goal: "evaluate_treatment" };
    frame.study_type = deriveStudyType(frame.facets);
    frame.assumptions = [...frame.assumptions, "A drug named as the exposure is analysed as a treatment comparison, adjusted for illness severity, because the patients who receive a drug differ from those who do not."];
  }
};

export class StudyFramingService {
  constructor(private readonly dependencies: {
    model: StructuredModel;
    /** `extraction_en` is used for sub-questions without Chinese: the Chinese-example prompt makes small models translate. */
    prompts: { split: StructuredChatPrompt; extraction: StructuredChatPrompt; extraction_en?: StructuredChatPrompt };
    normalizer?: SlotNormalizer;
    /** Defined ratio and formula variables: a name in the question finds its expression and parts. */
    /** The conditions or treatments a population phrase names, when it names at least two (see populationConcepts). */
    population_parts?: (text: string) => string[] | undefined;
    /** The drugs (two or more) a sub-question names as written; a comparison of them is read as one exposure with those levels. */
    drug_names?: (text: string) => string[] | undefined;
    formulas?: { find(text: string): { label_en: string; expression: string; parts: Array<{ name: string; label_en: string }>; unit?: string } | undefined };
    max_output_tokens?: number;
  }) {}

  async frame(question: string): Promise<{ frame_set: StudyFrameSet; audits: StructuredChatAudit[] }> {
    const original = question.trim();
    const audits: StructuredChatAudit[] = [];
    const call = async <T>(request: StructuredChatRequest<T>): Promise<T> => {
      try {
        const { value, audit } = await this.dependencies.model.call(request);
        audits.push(audit);
        return value;
      } catch (error) {
        const audit = (error as { audit?: StructuredChatAudit }).audit;
        if (audit) audits.push(audit);
        throw new StudyFramingError("FRAMING_MODEL_FAILED", `Study framing failed at ${request.stage}.`, audits, audit?.failure_class);
      }
    };
    const maxTokens = this.dependencies.max_output_tokens ?? 600;
    const split = await call<{ sub_questions: Array<{ text: string; aim: FramingAim }> }>({
      stage: "study_question_split", prompt: this.dependencies.prompts.split, schema: SPLIT_SCHEMA,
      input: { question: original }, max_output_tokens: maxTokens,
    });
    // A question without Chinese is framed from its own words: a small model that translates it into Chinese in the split
    // step makes every later phrase unverifiable against the question (the population then looks "inferred" and is dropped).
    const translatedSplit = !HAN.test(original) && split.sub_questions.some(({ text }) => HAN.test(text));
    const proposed = translatedSplit ? [{ text: original, aim: split.sub_questions[0]?.aim ?? "main" as FramingAim }] : split.sub_questions;
    const subQuestions = [...new Map(proposed.map((item) => [item.text.trim(), { text: item.text.trim(), aim: aimFromCues(item.text, item.aim) }] as const)).values()].filter(({ text }) => text);
    const frames: StudyFrame[] = [];
    for (const { text: subQuestion, aim } of subQuestions) {
      const extraction = await call<FrameExtraction>({
        stage: "study_frame_extraction", prompt: !HAN.test(subQuestion) && this.dependencies.prompts.extraction_en ? this.dependencies.prompts.extraction_en : this.dependencies.prompts.extraction, schema: EXTRACTION_SCHEMA,
        input: { original_question: original, sub_question: subQuestion, aim }, max_output_tokens: maxTokens,
        sanitize: sanitizeFrameExtraction, validate_business: (value: FrameExtraction) => frameExtractionProblems(value, aim, subQuestion),
      });
      frames.push(...buildFrames({ question: original, sub_question: subQuestion, extraction, first_id: frames.length + 1, aim }));
    }
    const finalFrames = dropDuplicateFrames(withOverallDoseResponse(mergeHorizonFrames(frames)));
    if (this.dependencies.normalizer) { await this.normalize(finalFrames); asTreatmentQuestions(finalFrames); }
    return { frame_set: { schema_version: "1.0.0", original_question: original, frames: finalFrames }, audits };
  }

  /** Annotates each distinct slot phrase once; a failed normalization leaves the slot un-normalized. */
  private async normalize(frames: StudyFrame[]): Promise<void> {
    const cache = new Map<string, Promise<FrameSlot["normalized"] | undefined>>();
    const annotate = async (slot: FrameSlot | undefined, role: string): Promise<void> => {
      if (!slot) return;
      const key = `${role}:${slot.text}`;
      if (!cache.has(key)) cache.set(key, this.dependencies.normalizer!.normalize({ text: slot.text, role }).catch(() => undefined));
      const normalized = await cache.get(key);
      if (normalized) slot.normalized = normalized;
    };
    for (const frame of frames) {
      await annotate(frame.population, "population");
      if (frame.population && !populationConjunction(frame.population.qualified_text ?? frame.population.text)) { const parts = this.dependencies.population_parts?.(frame.population.qualified_text ?? frame.population.text); if (parts) frame.population.parts = parts; }
      // "How do senna, docusate and lactulose compare": the named drugs are the levels of the comparison, whatever class word the model put in the exposure.
      if (frame.exposure && !frame.exposure.categories?.length && !frame.comparator?.levels?.length && /\b(?:compare|compared|comparison|versus|vs\.?|differ|different|between)\b|比较|对比|相比|差异/iu.test(frame.sub_question)) {
        const names = this.dependencies.drug_names?.(frame.sub_question);
        if (names && !names.some((name) => name.toLowerCase() === frame.exposure!.text.trim().toLowerCase())) {
          frame.exposure.categories = names;
          frame.assumptions.push(`The question names ${names.join(", ")}; they are the drugs compared, in place of “${frame.exposure.text}”. （问题点名了${names.join("、")}，按这几种药比较，而不是“${frame.exposure.text}”。）`);
        }
      }
      await annotate(frame.exposure, "exposure");
      if (frame.comparator?.levels?.length) {
        const compared: NonNullable<NonNullable<StudyFrame["comparator"]>["levels_normalized"]> = [];
        for (const text of frame.comparator.levels) {
          const level: FrameSlot = { text, verbatim: true };
          await annotate(level, "exposure");
          if (level.normalized) compared.push({ text, ...level.normalized });
        }
        if (compared.length) frame.comparator.levels_normalized = compared;
      }
      // A single exposure that names a defined formula is analysed as a one-level formula, like a ratio written in the question.
      if (frame.exposure && !frame.exposure.categories?.length && this.dependencies.formulas?.find(frame.exposure.text)) frame.exposure.categories = [frame.exposure.text];
      if (frame.exposure?.categories?.length) {
        const levels: NonNullable<FrameSlot["categories_normalized"]> = [];
        for (const text of frame.exposure.categories) {
          const formula = this.dependencies.formulas?.find(text);
          if (formula) { levels.push({ text, label_en: formula.label_en, category: "laboratory", formula: { expression: formula.expression, parts: formula.parts, ...(formula.unit ? { unit: formula.unit } : {}) } }); continue; }
          // A ratio level is two measurements: each part is normalized on its own so each maps to its MIMIC variable.
          const parts = ratioParts(text);
          if (parts) {
            const numerator: FrameSlot = { text: parts.numerator, verbatim: frame.exposure.verbatim }; const denominator: FrameSlot = { text: parts.denominator, verbatim: frame.exposure.verbatim };
            await annotate(numerator, "exposure"); await annotate(denominator, "covariate");
            if (numerator.normalized && denominator.normalized) levels.push({ text, label_en: `${numerator.normalized.label_en}/${denominator.normalized.label_en} ratio`, category: numerator.normalized.category, ratio: { numerator_en: numerator.normalized.label_en, denominator_en: denominator.normalized.label_en } });
            continue;
          }
          const level: FrameSlot = { text, verbatim: frame.exposure.verbatim };
          await annotate(level, "exposure");
          if (level.normalized) levels.push({ text, ...level.normalized });
        }
        if (levels.length) frame.exposure.categories_normalized = levels;
      }
      await annotate(frame.outcome, "outcome");
      if (frame.outcome?.components?.length) {
        const parts: NonNullable<FrameSlot["components_normalized"]> = [];
        for (const text of frame.outcome.components) {
          const part: FrameSlot = { text, verbatim: frame.outcome.verbatim };
          await annotate(part, "outcome");
          if (part.normalized) parts.push({ text, ...part.normalized });
        }
        if (parts.length) frame.outcome.components_normalized = parts;
      }
      for (const modifier of frame.modifiers) await annotate(modifier, "covariate");
      for (const mediator of frame.mediators) await annotate(mediator, "covariate");
      for (const predictor of frame.predictors) await annotate(predictor, "predictor");
      // A described characteristic is read like a baseline variable (drug classes by rule); a default one already carries its concept.
      for (const characteristic of frame.characteristics ?? []) if (!characteristic.normalized) await annotate(characteristic, "covariate");
      flagModelTranslatedDrugs(frame);
    }
  }
}

/**
 * A drug the catalog does not know is translated by the small model, which has turned drug names into unrelated drugs
 * (olmesartan into omeprazole). The translation is therefore shown as an assumption the user confirms on the plan.
 */
export const flagModelTranslatedDrugs = (frame: StudyFrame): void => {
  const named: Array<{ text: string; normalized?: { label_en: string; category: string; source?: string } | undefined }> = [
    ...(frame.exposure ? [{ text: frame.exposure.text, normalized: frame.exposure.normalized }] : []),
    ...(frame.exposure?.categories_normalized ?? []).map(({ text, ...rest }) => ({ text, normalized: rest })),
    ...(frame.comparator?.levels_normalized ?? []).map(({ text, ...rest }) => ({ text, normalized: rest })),
    ...frame.predictors.map((slot) => ({ text: slot.text, normalized: slot.normalized })),
    ...(frame.characteristics ?? []).map((slot) => ({ text: slot.text, normalized: slot.normalized })),
  ];
  const seen = new Set<string>();
  for (const { text, normalized } of named) {
    if (normalized?.category !== "medication" || normalized.source !== "model" || seen.has(text)) continue;
    seen.add(text);
    frame.assumptions.push(`“${text}” is not in the drug catalog; the model translated it as “${normalized.label_en}”. Check that this is the drug you mean before confirming.`);
  }
};
