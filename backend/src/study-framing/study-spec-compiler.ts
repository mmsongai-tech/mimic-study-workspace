import { followUpEnd, type StudyCondition, type StudySpec, type StudyVariable, type TimeWindow } from "../research-design/index.js";
import type { FrameSlot, StudyFrame } from "./domain/study-frame.js";
import { loweringEffect, populationCore, populationSex } from "./frame-rules.js";

/**
 * Deterministic StudySpec compilation from a study frame. No model call: every operational choice is a
 * versioned default that is written into `assumptions` so the report can show it and the user can change it.
 */
export const STUDY_SPEC_COMPILER_VERSION = "1.6.3";

export interface CompiledStudyPlan {
  plan_id: string;
  frame_id: string;
  /** Exposure level this plan contrasts when the frame lists several (for example one drug class). */
  exposure_level?: string;
  study_spec: StudySpec;
  /**
   * `ratio`: the exposure is computed per patient as the numerator variable divided by the denominator covariate.
   * `severity`: illness-severity adjustment variables offered as a choice (optional: an unmapped one is dropped, not
   * blocking); `severity_off`: those offered but not used unless the user switches them on.
   * `excluded_covariates`: adjustment variables the user switched off when confirming the plan.
   */
  roles: { mediators: string[]; modifiers: string[]; default_covariates: string[]; ratio?: { numerator: string; denominator: string; label: string }; formula?: { label: string; expression: string; variables: Array<{ name: string; label: string }> };
    severity?: string[]; severity_off?: string[]; excluded_covariates?: string[] };
}

const DEFAULT_COVARIATES = ["Age", "Sex", "Charlson comorbidity index"] as const;
/**
 * Acute illness severity for treatment comparisons, measured in the first 24 hours: variables recorded for nearly every
 * admission are used by default; lactate (measured only when clinicians suspect hypoperfusion) is offered but off.
 */
const SEVERITY_COVARIATES = ["Emergency admission", "Vasopressors", "Invasive mechanical ventilation", "Creatinine", "Lactate"] as const;
const SEVERITY_OFF = ["Lactate"];
const EXPOSURE_WINDOW: TimeWindow = { purpose: "exposure", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" };
const BASELINE_WINDOW: TimeWindow = { purpose: "baseline", anchor: "index_time", start_offset: 0, end_offset: 24, unit: "hour" };
const PRESENCE_CATEGORIES = new Set(["medication", "intervention", "diagnosis"]);

const UNIT_PATTERNS: Array<[RegExp, TimeWindow extends infer W ? W extends { unit: infer U } ? U : never : never]> = [
  [/(小时|h(?:ours?)?\b|hrs?\b)/iu, "hour"], [/(天|日|days?\b|d\b)/iu, "day"], [/(周|weeks?\b)/iu, "week"], [/(个?月|months?\b)/iu, "month"], [/(年|years?\b)/iu, "year"],
];
const HOURS_PER_UNIT: Record<string, number> = { minute: 1 / 60, hour: 1, day: 24, week: 168, month: 730.5, year: 8766 };
const CHINESE_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** Reads "28天", "90-day", "一年", "24 hours" into an outcome window; undefined when no horizon is stated. */
export const parseHorizon = (text: string | undefined): Extract<TimeWindow, { end_offset: number }> | undefined => {
  if (!text) return undefined;
  const numeric = text.match(/(\d+(?:\.\d+)?)/u)?.[1];
  const chinese = text.match(/([一二两三四五六七八九十])\s*(?:个)?(?:小时|天|日|周|月|年)/u)?.[1];
  const amount = numeric ? Number(numeric) : chinese ? CHINESE_DIGITS[chinese] : undefined;
  const unit = UNIT_PATTERNS.find(([pattern]) => pattern.test(text))?.[1];
  return amount && unit ? { purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: amount, unit } : undefined;
};

const conceptOf = (slot: FrameSlot): string => slot.normalized?.label_en ?? slot.text;
const usesIcu = (frame: StudyFrame): boolean => /icu|重症|监护/iu.test(`${frame.population?.text ?? ""} ${frame.sub_question}`);

/**
 * "不伴前列腺增生的高血压" / "hypertension without prostatic hyperplasia": the population is the condition and not the excluded
 * one. Mapping the whole phrase as one concept silently drops the exclusion (it resolves to plain hypertension).
 */
export const populationExclusion = (text: string): { core: string; excluded: string[] } | undefined => {
  const chinese = text.match(/^(?:不伴(?:有)?|不合并|无|没有|排除|不含|不包括|除外)(.{2,20}?)的(.{2,30})$/u);
  if (chinese) return { core: chinese[2]!.replace(/(?:患者|人群)$/u, ""), excluded: [chinese[1]!] };
  const english = text.match(/^(.{3,60}?)\s+(?:without|excluding|not having|free of)\s+(.{3,60})$/iu);
  if (english) return { core: english[1]!, excluded: [english[2]!] };
  return undefined;
};

/**
 * "糖尿病合并高血压" / "heart failure complicated by atrial fibrillation": the population has both conditions. Mapping the
 * whole phrase as one concept silently keeps only one of them (it resolves to plain hypertension).
 */
export const populationConjunction = (text: string): string[] | undefined => {
  const chinese = text.match(/^(.{2,20}?)(?:合并|伴有|伴发|并发|同时患有|同时有)(.{2,20}?)(?:的)?(?:患者|人群)?$/u);
  if (chinese && !/^(?:不|未|无)/u.test(chinese[1]!)) return [chinese[1]!, chinese[2]!];
  const english = text.match(/^(.{3,60}?)\s+(?:with comorbid|complicated by|and comorbid|with concomitant|plus)\s+(.{3,60})$/iu);
  return english ? [english[1]!, english[2]!] : undefined;
};

/**
 * "aged 65 and older", "age ≥ 65", "年龄≥65岁", "65岁及以上脓毒症患者": an age restriction is a numeric condition on age, not a
 * diagnosis to be looked up. Returns the restriction and what is left of the phrase; undefined when no age is stated.
 */
export const populationAge = (text: string): { rest: string; operator: "gt" | "gte" | "lt" | "lte"; value: number } | undefined => {
  const symbol: Record<string, "gt" | "gte" | "lt" | "lte"> = { "≥": "gte", ">=": "gte", "≤": "lte", "<=": "lte", ">": "gt", "<": "lt" };
  const forms: Array<[RegExp, (match: RegExpMatchArray) => { operator: "gt" | "gte" | "lt" | "lte"; value: number }]> = [
    [/(?:aged?|age)\s*(?:of\s*)?(≥|>=|≤|<=|>|<)\s*(\d{1,3})(?:\s*years?(?:\s*old)?)?/iu, (m) => ({ operator: symbol[m[1]!]!, value: Number(m[2]) })],
    [/(?:aged?\s+)?(\d{1,3})\s*(?:years?(?:\s*old)?)?\s*(?:and|or)\s*(?:older|above|over|up)/iu, (m) => ({ operator: "gte", value: Number(m[1]) })],
    [/(?:aged?\s+)?(?:over|older than|above|greater than)\s*(\d{1,3})(?:\s*years?)?/iu, (m) => ({ operator: "gt", value: Number(m[1]) })],
    [/(?:aged?\s+)?(?:under|younger than|below|less than)\s*(\d{1,3})(?:\s*years?)?/iu, (m) => ({ operator: "lt", value: Number(m[1]) })],
    [/(?:年龄)?\s*(≥|>=|≤|<=|>|<)\s*(\d{1,3})\s*岁?/u, (m) => ({ operator: symbol[m[1]!]!, value: Number(m[2]) })],
    [/(\d{1,3})\s*岁\s*(?:及|或)?\s*以上/u, (m) => ({ operator: "gte", value: Number(m[1]) })],
    [/(\d{1,3})\s*岁\s*(?:及|或)?\s*以下/u, (m) => ({ operator: "lte", value: Number(m[1]) })],
  ];
  for (const [pattern, read] of forms) {
    const match = text.match(pattern); if (!match) continue;
    const { operator, value } = read(match);
    if (!(value >= 1 && value <= 120)) continue;
    const rest = text.replace(match[0], " ").replace(/\b(?:aged?|patients?|adults?|persons?|people|who|are|were|is|with|and|or|the|elderly|older|years?|old)\b/giu, " ").replace(/[年龄的患者人群，,、]/gu, (char) => (char === "，" || char === "," || char === "、" ? " " : "")).replace(/\s+/gu, " ").trim();
    // What is left may be only a care setting ("ICU"), which is not a condition.
    const core = populationCore(rest);
    return { rest: core.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 ? core : "", operator, value };
  }
  return undefined;
};

const concept = (conditionId: string, slot: FrameSlot): StudyCondition => {
  const text = slot.qualified_text ?? slot.text;
  const age = conditionId === "population.target" ? populationAge(text) : undefined;
  if (age) {
    const restriction: StudyCondition = { condition_id: `${conditionId}.age`, source_text: text, kind: "numeric_comparison", concept: "Age", operator: age.operator, value: age.value, unit: "year" };
    if (!age.rest) return restriction;
    return { condition_id: conditionId, source_text: slot.text, kind: "all", operands: [concept(`${conditionId}.core`, (({ parts: _parts, ...others }) => ({ ...others, text: age.rest, qualified_text: age.rest }))(slot)), restriction] };
  }
  const both = conditionId === "population.target" && !populationExclusion(text) ? populationConjunction(text) ?? populationConjunction(slot.text) ?? slot.parts : undefined;
  if (both) {
    return { condition_id: conditionId, source_text: slot.text, kind: "all", operands: both.map((item, position) => ({ condition_id: `${conditionId}.part${position + 1}`, source_text: item, kind: "concept" as const, concept: item, assertion: "present" as const })) };
  }
  const split = conditionId === "population.target" ? populationExclusion(slot.qualified_text ?? slot.text) ?? populationExclusion(slot.text) : undefined;
  if (split) {
    const core: StudyCondition = { condition_id: `${conditionId}.core`, source_text: split.core, kind: "concept", concept: split.core, assertion: "present" };
    const excluded: StudyCondition[] = split.excluded.map((item, position) => ({ condition_id: `${conditionId}.excluded${position + 1}`, source_text: item, kind: "concept" as const, concept: item, assertion: "absent" as const }));
    return { condition_id: conditionId, source_text: slot.text, kind: "all", operands: [core, ...excluded] };
  }
  return { condition_id: conditionId, source_text: slot.text, kind: "concept", concept: conceptOf(slot), assertion: "present" };
};

/** Age, sex and other demographic attributes are recorded once for the patient or the admission, not read in a time window. */
const demographicDefinition = (name: string): string => `${name} as recorded for the patient (a demographic attribute, not read in a time window).`;
const AGGREGATION_TEXT: Record<string, string> = { maximum: "Highest", minimum: "Lowest", mean: "Mean", first: "First", last: "Last", sum: "Cumulative" };
/** An exposure asked as a dose ("剂量", "dose") is an amount to be summed over the window, not the presence of the drug. */
const DOSE_WORDING = /剂量|用量|dosage|\bdose\b/iu;
const exposureVariable = (slot: FrameSlot, role: "exposure" | "predictor", conditionId: string, dose = false): StudyVariable => {
  if (dose && !slot.aggregation) {
    return { name: conceptOf(slot), role, operational_definition: `Total ${conceptOf(slot)} given within the first 24 hours after the index time.`, definition: concept(conditionId, slot), contrast: { kind: "as_recorded" as const }, aggregation: "sum" as const };
  }
  // A measured value asked with an aggregation ("最高乳酸", "average rate") is summarised that way; a drug or continuous
  // intervention asked with one (a rate, a dose) is a measurement too, not a presence.
  const presence = !slot.aggregation && (!slot.normalized || PRESENCE_CATEGORIES.has(slot.normalized.category));
  // Without a requested summary the variable definition's own summary applies (e.g. highest lactate, mean heart rate).
  return {
    name: conceptOf(slot), role,
    operational_definition: presence ? `Any recorded ${conceptOf(slot)} within the first 24 hours after the index time.`
      : slot.aggregation ? `${AGGREGATION_TEXT[slot.aggregation]} recorded ${conceptOf(slot)} within the first 24 hours after the index time.`
      : slot.normalized?.category === "demographic" ? demographicDefinition(conceptOf(slot))
      : `${conceptOf(slot)} within the first 24 hours after the index time, summarised as its variable definition specifies.`,
    definition: concept(conditionId, slot),
    ...(presence ? { contrast: { kind: "binary_presence" as const }, aggregation: "any" as const } : { contrast: { kind: "as_recorded" as const }, ...(slot.aggregation ? { aggregation: slot.aggregation } : {}) }),
  };
};

const FOLLOW_UP_WINDOW: TimeWindow = { purpose: "follow_up", anchor: "index_time", start_offset: 24, end_offset: 72, unit: "hour" };
/** A lowering-effect mediator ("降压作用") is the change in the measured quantity over the stated windows. */
const changeMediator = (slot: FrameSlot): StudyVariable | undefined => {
  const effect = loweringEffect(slot.text);
  if (!effect) return undefined;
  const name = `${effect.en} change`;
  return {
    name, role: "covariate", operational_definition: `Mean ${effect.en.toLowerCase()} from 24 to 72 hours minus mean in the first 24 hours after time zero.`,
    definition: { condition_id: `covariate.${name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_")}`, source_text: slot.text, kind: "concept", concept: effect.en, assertion: "present" },
    derivation: { schema_version: "1.0.0", operator: "difference", source_concept: effect.en, aggregation: "mean", baseline: BASELINE_WINDOW, follow_up: FOLLOW_UP_WINDOW, direction: "follow_up_minus_baseline" },
  };
};

const covariate = (name: string, sourceText = name): StudyVariable => ({ name, role: "covariate", operational_definition: `${name} at the index time.`, definition: { condition_id: `covariate.${name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_")}`, source_text: sourceText, kind: "concept", concept: name, assertion: "present" } });

/** A change-from-baseline outcome depends on where it started, so its baseline value (mean of the first 24 hours) is a covariate. */
const baselineOfOutcome = (outcome: StudyVariable | undefined): StudyVariable | undefined => {
  const concept = outcome?.derivation?.operator === "difference" ? outcome.derivation.source_concept : undefined;
  if (!concept) return undefined;
  return {
    name: `Baseline ${concept}`, role: "covariate", operational_definition: `Mean ${concept} in the first 24 hours after the index time (the baseline of the outcome measure).`,
    definition: { condition_id: `covariate.baseline_${concept.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_")}`, source_text: concept, kind: "concept", concept, assertion: "present" }, aggregation: "mean",
  };
};


const READMISSION = /readmi|re-?hospitali[sz]|re-?admi|再入院|再次住院|再住院|重复入院|(?:hospitali[sz]ation|admission)s?\s+(?:due to|for|because of|with)|因[^，。；,;]{1,16}(?:入院|住院)/iu;
const READMISSION_HORIZONS = [30, 90, 365] as const;
/**
 * "Hospitalisation for heart failure" or "30天再入院" is an admission after the index discharge, which the derived-variable layer
 * records (readmission, any cause or with a diagnosis, within 30, 90 or 365 days). Returns the concept name that layer's
 * mapping answers to, or undefined for an outcome that is not a readmission.
 */
export const readmissionOutcome = (slot: FrameSlot, horizon: TimeWindow | undefined): { name: string; days: number } | undefined => {
  const text = `${slot.text} ${slot.normalized?.label_en ?? ""}`;
  if (!READMISSION.test(text)) return undefined;
  const hours = horizon && "end_offset" in horizon ? horizon.end_offset * ({ minute: 1 / 60, hour: 1, day: 24, week: 168, month: 730, year: 8766 }[horizon.unit] ?? 24) : undefined;
  const requested = hours === undefined ? 365 : hours / 24;
  const days = READMISSION_HORIZONS.find((limit) => requested <= limit) ?? 365;
  const english = (slot.normalized?.label_en ?? "").match(/(?:due to|for|because of|with)\s+(.+?)(?:\s+(?:within|in|after)\b.*)?$/iu)?.[1]?.trim();
  const chinese = slot.text.match(/因(.{1,16}?)(?:再)?(?:入院|住院)/u)?.[1] ?? slot.text.match(/^(.{1,16}?)(?:再入院|再住院|再次住院)/u)?.[1];
  const diagnosis = english && !/^(?:any|all)\b/iu.test(english) ? english : chinese?.replace(/^\d+\s*(?:天|日)内?/u, "");
  return { name: diagnosis ? `Readmission for ${diagnosis} within ${days} days` : `Readmission within ${days} days`, days };
};

/** A cut-off written in a phrase as a yes/no contrast; durations are stored in days (e.g. icustays.los), so time cut-offs are converted to days. */
const thresholdContrast = (threshold: NonNullable<FrameSlot["threshold"]>): { contrast: Extract<NonNullable<StudyVariable["contrast"]>, { kind: "threshold" }>; text: string } => {
  const toDays: Record<string, number> = { hour: 1 / 24, day: 1, week: 7 };
  const days = threshold.unit ? toDays[threshold.unit] : undefined;
  const value = days ? Number((threshold.value * days).toFixed(4)) : threshold.value;
  const unit = days ? "day" : threshold.unit;
  const symbol = { gt: ">", gte: "≥", lt: "<", lte: "≤" }[threshold.operator];
  return { contrast: { kind: "threshold", operator: threshold.operator, value, ...(unit ? { unit } : {}) }, text: `${symbol} ${value}${unit ? ` ${unit}(s)` : ""}${days && threshold.unit !== "day" ? ` (${threshold.value} ${threshold.unit}s as written)` : ""}` };
};

/**
 * One characteristic of a description. A concept of the outcome category (death, length of stay, readmission) is read like an
 * outcome, over the outcome window; anything else like a baseline variable, in the first 24 hours. Its yes/no or numeric form comes
 * from the variable definition it maps to (execution-manifest); a written cut-off or summary word is kept. Its condition id
 * (`characteristic.N`) marks it as described, never modelled, at every later stage.
 */
const characteristicVariable = (slot: FrameSlot, position: number, horizon: TimeWindow | undefined): StudyVariable => {
  const name = conceptOf(slot);
  const overStay = slot.normalized?.category === "outcome";
  const demographic = slot.normalized?.category === "demographic";
  const when = demographic ? "as recorded for the patient" : !overStay ? "within the first 24 hours after the index time" : horizon && "end_offset" in horizon ? `within ${horizon.end_offset} ${horizon.unit}(s) after the index time` : "from the index time to the end of the index encounter";
  const threshold = slot.threshold ? thresholdContrast(slot.threshold) : undefined;
  return {
    name, role: overStay ? "outcome" : "covariate",
    operational_definition: demographic && !threshold ? demographicDefinition(name)
      : threshold ? `Whether ${name} ${when} is ${threshold.text}.`
      : slot.aggregation ? `${AGGREGATION_TEXT[slot.aggregation]} recorded ${name} ${when}.`
      : `${name} as its variable definition specifies, read ${when}; a yes/no characteristic is any record in that window.`,
    definition: { condition_id: `characteristic.${position + 1}`, source_text: slot.qualified_text ?? slot.text, kind: "concept", concept: name, assertion: "present" },
    ...(threshold ? { contrast: threshold.contrast } : {}), ...(slot.aggregation ? { aggregation: slot.aggregation } : {}),
  };
};

const outcomeFor = (frame: StudyFrame, slot: FrameSlot, horizon: TimeWindow | undefined, question = ""): { outcome: StudyVariable; structure: NonNullable<StudySpec["outcome_structure"]>; windows: TimeWindow[] } => {
  const components = slot.components_resolved ?? [];
  if (components.length >= 2 && (frame.facets.outcome_kind === "event" || frame.facets.outcome_kind === "time_to_event")) {
    // A composite event: any of its measurable components, each mapped on its own.
    const outcomeWindow: TimeWindow = horizon ?? { purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" };
    const definition: StudyCondition = { condition_id: "outcome.target", source_text: slot.text, kind: "any", operands: components.map((component, index) => ({ condition_id: `outcome.c${index + 1}`, source_text: component.text, kind: "event_exists", concept: component.concept_en, occurrence: "present" })) };
    const name = `${slot.normalized?.label_en ?? slot.text} (${components.map(({ concept_en }) => concept_en).join(" or ")})`;
    const timeToEvent = frame.facets.outcome_kind === "time_to_event";
    return { outcome: { name, role: "outcome", operational_definition: `First of: ${components.map(({ concept_en }) => concept_en).join(", ")}.`, definition, contrast: { kind: "binary_presence" }, ...(timeToEvent ? { aggregation: "first" as const } : {}) }, structure: timeToEvent ? "time_to_event" : "binary", windows: [outcomeWindow] };
  }
  const readmission = readmissionOutcome(slot, horizon);
  const single = readmission ? { ...slot, normalized: { label_en: readmission.name, category: "outcome" as const } } : components.length === 1 ? { ...slot, normalized: { label_en: components[0]!.concept_en, category: "outcome" as const } } : slot;
  const name = conceptOf(single);
  // A readmission is recorded at the index discharge with its horizon in the concept, so the outcome window is the encounter.
  const outcomeWindow: TimeWindow = (readmission ? undefined : horizon) ?? { purpose: "outcome", anchor: "index_time", end_event: "end_of_encounter" };
  if (slot.threshold) {
    const { contrast, text } = thresholdContrast(slot.threshold);
    return { outcome: { name, role: "outcome", operational_definition: `Whether ${name} is ${text}.`,
      definition: { condition_id: "outcome.target", source_text: slot.text, kind: "concept", concept: name, assertion: "present" }, contrast }, structure: "binary", windows: [outcomeWindow] };
  }
  // The efficacy of a drug on a measurement (blood pressure, a lab value) is its change from baseline: the level after the drug
  // mostly shows which patients were given it.
  const efficacyOnMeasurement = frame.facets.outcome_kind === "value" && frame.facets.goal === "evaluate_treatment" && frame.exposure?.normalized?.category === "medication"
    && /疗效|效果|效应|获益|efficacy|effect|benefit/iu.test(`${frame.sub_question} ${question}`);
  switch (efficacyOnMeasurement ? "change_over_time" : frame.facets.outcome_kind) {
    case "time_to_event":
      return { outcome: { name, role: "outcome", operational_definition: `Time from the index time to ${name}, censored at the end of follow-up.`, definition: { condition_id: "outcome.target", source_text: single.text, kind: "event_exists", concept: name, occurrence: "present" }, contrast: { kind: "binary_presence" }, aggregation: "first" }, structure: "time_to_event", windows: [outcomeWindow] };
    case "change_over_time": {
      // Non-overlapping windows: baseline is the first 24 hours; follow-up runs from 24 hours to the stated horizon
      // (72 hours by default). Both use the mean so a single reading does not drive the change.
      const horizonHours = horizon && "end_offset" in horizon ? horizon.end_offset * (HOURS_PER_UNIT[horizon.unit] ?? 24) : 72;
      const followUp: TimeWindow = { purpose: "follow_up", anchor: "index_time", start_offset: 24, end_offset: Math.max(48, horizonHours), unit: "hour" };
      return {
        outcome: {
          name: `${name} change`, role: "outcome", operational_definition: `Mean ${name} from 24 to ${Math.max(48, horizonHours)} hours minus mean ${name} in the first 24 hours after time zero.`,
          definition: { condition_id: "outcome.target", source_text: slot.text, kind: "concept", concept: name, assertion: "present" },
          derivation: { schema_version: "1.0.0", operator: "difference", source_concept: name, aggregation: "mean", baseline: BASELINE_WINDOW, follow_up: followUp, direction: "follow_up_minus_baseline" },
        },
        structure: "continuous", windows: [BASELINE_WINDOW, followUp],
      };
    }
    case "value":
      return { outcome: { name, role: "outcome", operational_definition: `${name} during follow-up (mean of recorded values).`, definition: { condition_id: "outcome.target", source_text: slot.text, kind: "concept", concept: name, assertion: "present" }, aggregation: "mean" }, structure: "continuous", windows: [outcomeWindow] };
    case "count":
      return { outcome: { name, role: "outcome", operational_definition: `Number of ${name} records during follow-up.`, definition: { condition_id: "outcome.target", source_text: slot.text, kind: "concept", concept: name, assertion: "present" }, aggregation: "count" }, structure: "count", windows: [outcomeWindow] };
    default:
      // Presence contrast: no qualifying record in the window means the event did not occur.
      return { outcome: { name, role: "outcome", operational_definition: `Any ${name} during follow-up.`, definition: { condition_id: "outcome.target", source_text: slot.text, kind: "event_exists", concept: name, occurrence: "present" }, contrast: { kind: "binary_presence" } }, structure: "binary", windows: [outcomeWindow] };
  }
};

const analysisFamily = (frame: StudyFrame, structure: NonNullable<StudySpec["outcome_structure"]>): NonNullable<StudySpec["analysis_family"]> => {
  if (frame.facets.goal === "predict") return structure === "time_to_event" ? "time_to_event_prediction" : "binary_prediction";
  if (frame.facets.goal === "evaluate_treatment") return structure === "time_to_event" ? "time_to_event_treatment_effect" : "propensity_weighted_treatment_effect";
  return structure === "time_to_event" ? "time_to_event_association" : "association";
};

/** Compiles one ready frame into one plan per exposure level (a frame naming several classes fans out). */

const shiftExposure = (node: unknown, hours: number): unknown => {
  if (Array.isArray(node)) return node.map((child) => shiftExposure(child, hours));
  if (typeof node !== "object" || node === null) return node;
  const copy: Record<string, unknown> = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, shiftExposure(child, hours)]));
  const window = node as { purpose?: unknown; unit?: unknown; start_offset?: unknown; end_offset?: unknown };
  if (typeof window.purpose === "string" && window.unit === "hour") {
    if ((window.purpose === "exposure" || window.purpose === "baseline") && window.end_offset === 24) copy.end_offset = hours;
    if (window.purpose === "follow_up" && window.start_offset === 24) { copy.start_offset = hours; copy.end_offset = followUpEnd(hours, Number(window.end_offset)); }
  }
  return copy;
};
/** A question that states where predictors or exposures are read ("first 6 hours") moves every exposure and baseline window there; the follow-up of a change starts where it ends. */
const withExposureWindow = (plan: CompiledStudyPlan, hours: number): CompiledStudyPlan => ({
  ...plan,
  study_spec: restateAssumptions(shiftExposure(plan.study_spec, hours) as StudySpec),
});

// The first eligible unit, not the first one: a stay that ended (or had the outcome) before a later follow-up start is not
// eligible, so the patient enters at the next eligible one; only a missing exposure or outcome never moves a patient.
const analysisUnitSentence = (icu: boolean): string => icu
  ? "The analysis unit is each patient's first eligible ICU stay: one that meets the population definition and, when follow-up starts after time zero (a landmark or a prediction time), is still in the ICU and without the outcome then; if it lacks the exposure or the outcome, the patient is excluded rather than analysed at a later ICU stay; time zero is ICU admission."
  : "The analysis unit is each patient's first eligible hospital admission: one that meets the population definition and, when follow-up starts after time zero (a landmark or a prediction time), is still in hospital and without the outcome then; if it lacks the exposure or the outcome, the patient is excluded rather than analysed at a later admission; time zero is hospital admission.";

// What a prediction excludes at its prediction time; an ICU stay also ends with a transfer to the ward, and the extractor
// excludes it then too.
const predictionExclusions = (spec: StudySpec): string =>
  `${/icu/iu.test(spec.index_time?.event ?? "") ? "units whose ICU stay ended (transfer out of the ICU, discharge or death)" : "units discharged or dead"} before then, or with the outcome already recorded then (after time zero, or earlier in the same admission), are excluded`;

/**
 * The compiler's sentences that name a window, restated from the study spec's current windows: a question's "first 6 hours"
 * (withExposureWindow) or a time choice made when the plan is confirmed (question-pipeline retimeWindows) moves the windows
 * after the sentences were written. Each sentence keeps its wording, so its Chinese template still applies; a horizon is
 * rewritten only when the window no longer ends where the sentence says.
 */
export const restateAssumptions = (spec: StudySpec): StudySpec => {
  const windowOf = (purpose: TimeWindow["purpose"]) => spec.time_windows?.find((window) => window.purpose === purpose);
  const hoursOf = (amount: number, unit: string): number => amount * (HOURS_PER_UNIT[unit] ?? Number.NaN);
  const span = (window: TimeWindow | undefined): [number, number] | undefined => window && "end_offset" in window ? [hoursOf(window.start_offset, window.unit), hoursOf(window.end_offset, window.unit)] : undefined;
  const read = span(spec.intent_family === "prediction" ? windowOf("baseline") : windowOf("exposure") ?? windowOf("baseline"))?.[1];
  const baseline = span(windowOf("baseline")) ?? span(windowOf("exposure"));
  const followUp = span(windowOf("follow_up"));
  // The window the outcome is followed over: its own, or a change outcome's follow-up.
  const horizon = windowOf("outcome") ?? windowOf("follow_up");
  const horizonEnd = horizon && "end_offset" in horizon ? horizon : undefined;
  const known = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);
  const restate = (text: string): string => {
    let restated = text;
    if (known(read)) {
      restated = restated.replace(/^(Exposures and baseline factors are taken from the first )\d+(?:\.\d+)?( hours after time zero)/u, `$1${read}$2`)
        .replace(/( is analysed as the change in .+ from the first )\d+(?:\.\d+)?( hours to the end of follow-up\.)$/u, `$1${read}$2`)
        .replace(/(, each (?:part )?taken from the first )\d+(?:\.\d+)?( hours after time zero\.)$/u, `$1${read}$2`)
        .replace(/^(Active comparator: the population is patients who received any of .+ in the first )\d+(?:\.\d+)?( hours; )/u, `$1${read}$2`)
        .replace(/^(Predictions are made at )\d+( hours after time zero, when the predictor window ends .+ and the outcome is counted from )\d+( hours )/u, `$1${read}$2${read}$3`);
    }
    if (baseline && known(baseline[1])) restated = restated.replace(/(, mean of the first )\d+(?:\.\d+)?( hours\) is adjusted for\.)$/u, `$1${baseline[1]}$2`);
    // The measured window of a change outcome is a fact restated from the window; the question's horizon stays as stated.
    if (followUp && known(followUp[1])) restated = restated.replace(/^(The change is measured from )\d+(?:\.\d+)? to \d+(?:\.\d+)?( hours after time zero; the question states .+\.)$/u, `$1${followUp[0]} to ${followUp[1]}$2`);
    if (baseline && followUp && known(baseline[1]) && known(followUp[1])) restated = restated.replace(/\(mean \d+(?:\.\d+)?–\d+(?:\.\d+)? h minus mean 0–\d+(?:\.\d+)? h\)/u, `(mean ${followUp[0]}–${followUp[1]} h minus mean 0–${baseline[1]} h)`);
    // Plans compiled before 1.6.1 name the first unit, and a prediction's exclusions, without the follow-up start the
    // extractor applies (a unit ended or with the outcome already recorded then, also earlier in the same admission).
    restated = restated.replace(/^The analysis unit is each patient's first (hospital admission|ICU stay) that meets the population definition; if it lacks the exposure or the outcome, the patient is excluded rather than analysed at a later (?:admission|ICU stay); time zero is (?:hospital|ICU) admission\.$/u, (_, unit: string) => analysisUnitSentence(unit === "ICU stay"))
      .replace(/^(Predictions are made at \d+ hours after time zero, when the predictor window ends \(a landmark\): )units discharged or dead before then, or with the outcome recorded between time zero and then, are excluded(, and the outcome is counted from .+)$/u, (_, head: string, tail: string) => `${head}${predictionExclusions(spec)}${tail}`);
    // A change outcome is followed to the end of its follow-up window, never to the end of the encounter (plans compiled before 1.6.2).
    if (!windowOf("outcome") && followUp && known(followUp[1])) restated = restated.replace(/^Outcomes are followed until the end of the index encounter because no horizon was stated\.$/u, `Outcomes are followed for ${followUp[1]} hour(s) after time zero.`);
    if (horizonEnd) {
      const ends = hoursOf(horizonEnd.end_offset, horizonEnd.unit);
      const stated = (amount: string, unit: string): number => hoursOf(Number(amount), unit);
      restated = restated.replace(/^(Predictions are made at .+ and the outcome is counted from \d+ hours to )(\d+(?:\.\d+)?) (\w+)(\(s\) after time zero\.)$/u, (whole, head, amount, unit, tail) => stated(amount, unit) === ends ? whole : `${head}${horizonEnd.end_offset} ${horizonEnd.unit}${tail}`)
        .replace(/^(Outcomes are followed for )(\d+(?:\.\d+)?) (\w+)(\(s\) after time zero\.)$/u, (whole, head, amount, unit, tail) => stated(amount, unit) === ends ? whole : `${head}${horizonEnd.end_offset} ${horizonEnd.unit}${tail}`)
        .replace(/^(“.+” ask about the same event at several horizons, so it is analysed as time to event with follow-up to )(.+)(; the other horizons are reported as survival at those times\.)$/u, (whole, head, longest, tail) => {
          const parsed = parseHorizon(longest);
          return parsed && hoursOf(parsed.end_offset, parsed.unit) === ends ? whole : `${head}${horizonEnd.end_offset} ${horizonEnd.unit}(s)${tail}`;
        });
    }
    return restated;
  };
  return spec.assumptions?.length ? { ...spec, assumptions: spec.assumptions.map(restate) } : spec;
};

/**
 * A change outcome is followed over its follow-up window, not to the end of the encounter: its sentence names where that
 * window ends, and states the measured window beside the question's horizon when one was stated (a follow-up starts where
 * the baseline ends and lasts at least a day, research-design followUpEnd).
 */
const withChangeFollowUp = (plan: CompiledStudyPlan, horizon: TimeWindow | undefined): CompiledStudyPlan => {
  const spec = plan.study_spec;
  const followUp = spec.outcome?.derivation ? spec.time_windows?.find(({ purpose }) => purpose === "follow_up") : undefined;
  if (!followUp || !("end_offset" in followUp) || followUp.unit !== "hour") return plan;
  const sentences = spec.assumptions ?? [];
  const at = sentences.findIndex((text) => FOLLOWED_FROM_TIME_ZERO.test(text));
  // A stated horizon is kept beside the measured window even when they agree, so a later move of the window still shows it.
  const stated = horizon && "end_offset" in horizon ? horizon : undefined;
  const replaced = [`Outcomes are followed for ${followUp.end_offset} hour(s) after time zero.`,
    ...(stated ? [`The change is measured from ${followUp.start_offset} to ${followUp.end_offset} hours after time zero; the question states ${stated.end_offset} ${stated.unit}(s).`] : [])];
  return { ...plan, study_spec: { ...spec, assumptions: at < 0 ? [...sentences, ...replaced] : [...sentences.slice(0, at), ...replaced, ...sentences.slice(at + 1)] } };
};

const FOLLOWED_FROM_TIME_ZERO = /^Outcomes are followed (?:for .+ after time zero|until the end of the index encounter because no horizon was stated)\.$/u;
/**
 * A prediction is made when its predictor window ends (a landmark): an outcome recorded inside that window would be
 * "predicted" from measurements taken while it was happening. A timed event outcome is therefore counted from the
 * prediction time, and the extractor (local-execution-graph-runner) excludes units discharged or dead before it, or
 * with the outcome already recorded then (after time zero, or earlier in the same admission). The stated horizon still ends where it was stated from time zero,
 * unless it ends inside the predictor window; then it is read from the prediction time. The window is kept in hours so
 * that a later change of the predictor window can move its start (time-options).
 */
const withPredictionTime = (plan: CompiledStudyPlan): CompiledStudyPlan => {
  const spec = plan.study_spec;
  if (spec.intent_family !== "prediction" || spec.outcome?.contrast?.kind !== "binary_presence" || spec.outcome.derivation) return plan;
  const predictorWindow = spec.time_windows?.find(({ purpose }) => purpose === "baseline");
  const hours = predictorWindow && "end_offset" in predictorWindow ? predictorWindow.end_offset * (HOURS_PER_UNIT[predictorWindow.unit] ?? Number.NaN) : undefined;
  if (!hours || !Number.isInteger(hours)) return plan;
  const outcomeWindow = spec.time_windows?.find(({ purpose }) => purpose === "outcome");
  const endHours = outcomeWindow && "end_offset" in outcomeWindow ? outcomeWindow.end_offset * (HOURS_PER_UNIT[outcomeWindow.unit] ?? Number.NaN) : undefined;
  const fromPrediction = endHours !== undefined && endHours <= hours;
  // A horizon that is not a whole number of hours (months, years) keeps its window; the extractor still counts after the prediction time.
  const counted: TimeWindow | undefined = outcomeWindow && endHours !== undefined && Number.isInteger(endHours)
    ? { purpose: "outcome", anchor: "index_time", start_offset: hours, end_offset: fromPrediction ? hours + endHours : endHours, unit: "hour" } : outcomeWindow;
  const until = counted && "end_offset" in counted ? `to ${counted.end_offset} ${counted.unit}(s) after time zero` : "after time zero to the end of the index encounter";
  const assumptions = [
    `Predictions are made at ${hours} hours after time zero, when the predictor window ends (a landmark): ${predictionExclusions(spec)}, and the outcome is counted from ${hours} hours ${until}.`,
    ...(fromPrediction ? [`The stated horizon of ${endHours} hour(s) ends inside the predictor window, so it is counted from the prediction time.`] : []),
  ];
  const sentences = spec.assumptions ?? [];
  const at = sentences.findIndex((text) => FOLLOWED_FROM_TIME_ZERO.test(text));
  return {
    ...plan,
    study_spec: {
      ...spec,
      time_windows: (spec.time_windows ?? []).map((window) => window === outcomeWindow && counted ? counted : window),
      assumptions: at < 0 ? [...sentences, ...assumptions] : [...sentences.slice(0, at), ...assumptions, ...sentences.slice(at + 1)],
    },
  };
};

export const compileStudyPlans = (frame: StudyFrame, question: string): CompiledStudyPlan[] => {
  if (frame.status !== "ready") return [];
  const horizon = parseHorizon(frame.time_window);
  const icu = usesIcu(frame);
  // A description relates nothing: it reports the cohort, its groups and each characteristic; no unit is dropped for a missing value.
  const describing = frame.study_type === "descriptive";
  const characteristics = describing ? (frame.characteristics ?? []).map((slot, position) => characteristicVariable(slot, position, horizon)) : [];
  const followedOverStay = characteristics.some(({ role }) => role === "outcome");
  const assumptions = describing ? [
    ...frame.assumptions,
    icu ? "The analysis unit is each patient's first ICU stay that meets the population definition; time zero is ICU admission." : "The analysis unit is each patient's first hospital admission that meets the population definition; time zero is hospital admission.",
    "Exposures and baseline factors are taken from the first 24 hours after time zero, so later treatment cannot be counted as exposure.",
    ...(followedOverStay ? [horizon ? `Outcomes are followed for ${horizon.end_offset} ${horizon.unit}(s) after time zero.` : "Outcomes are followed until the end of the index encounter because no horizon was stated."] : []),
    `A description reports the number of patients, Table 1 and each characteristic's proportion or mean with its 95% confidence interval, in the whole cohort and in each group; nothing is adjusted, so a difference between groups is not an effect. Each characteristic is described among the patients in whom it is recorded (compiler ${STUDY_SPEC_COMPILER_VERSION}).`,
  ] : [
    ...frame.assumptions,
    analysisUnitSentence(icu),
    "Exposures and baseline factors are taken from the first 24 hours after time zero, so later treatment cannot be counted as exposure.",
    horizon ? `Outcomes are followed for ${horizon.end_offset} ${horizon.unit}(s) after time zero.` : "Outcomes are followed until the end of the index encounter because no horizon was stated.",
    `Age, sex and the Charlson comorbidity index (Quan 2005 ICD coding) are the default adjustment variables (compiler ${STUDY_SPEC_COMPILER_VERSION}).`,
  ];
  // "A vs B": the treatment (or listed group) against a named active comparator (or listed group) is one comparison,
  // among patients who received either side, excluding those who received both.
  const comparatorLevels = frame.comparator?.kind === "active" ? frame.comparator.levels ?? [] : [];
  const versus = frame.facets.goal === "evaluate_treatment" && comparatorLevels.length > 0 && Boolean(frame.exposure);
  const exposedLevels = versus ? (frame.exposure!.categories?.length ? frame.exposure!.categories : [frame.exposure!.text]) : [];
  // A description's grouping is one variable, never a fan-out into one plan per level.
  const levels = versus || describing ? [undefined] : frame.exposure?.categories?.length ? frame.exposure.categories : [undefined];
  // Listed exposure levels without a stated comparator are compared with each other (active comparator): the
  // population is patients who received any listed level, so every plan contrasts one level with the others.
  // Only treatments are compared with each other; listed measurements (RDW and its ratios) are separate analyses.
  const activeComparator = !versus && levels.length >= 2 && frame.facets.goal === "evaluate_treatment" && frame.comparator?.kind !== "absence" && frame.comparator?.kind !== "active";
  const levelConcept = (level: string): string => frame.exposure?.categories_normalized?.find(({ text }) => text === level)?.label_en ?? level;
  const anyLevel: StudyCondition | undefined = activeComparator ? {
    condition_id: "population.any_level", source_text: frame.exposure!.text, kind: "any",
    operands: (levels as string[]).map((level, position) => ({ condition_id: `population.level${position + 1}`, source_text: level, kind: "event_exists" as const, concept: levelConcept(level), occurrence: "present" as const, window: EXPOSURE_WINDOW })),
  } : undefined;
  const exposedLabel = (text: string): string => frame.exposure?.categories_normalized?.find((item) => item.text === text)?.label_en ?? (exposedLevels.length === 1 ? frame.exposure?.normalized?.label_en : undefined) ?? text;
  const comparatorLabel = (text: string): string => frame.comparator?.levels_normalized?.find((item) => item.text === text)?.label_en ?? text;
  const sideLeaves = (prefix: string, texts: string[], label: (text: string) => string): StudyCondition[] => texts.map((text, position) => ({ condition_id: `${prefix}${position + 1}`, source_text: text, kind: "event_exists" as const, concept: label(text), occurrence: "present" as const, window: EXPOSURE_WINDOW }));
  const sideCondition = (id: string, source: string, leaves: StudyCondition[]): StudyCondition => leaves.length === 1 ? leaves[0]! : { condition_id: id, source_text: source, kind: "any", operands: leaves };
  const versusPopulation: StudyCondition | undefined = versus ? (() => {
    const exposedSide = sideCondition("population.exposed", frame.exposure!.text, sideLeaves("population.exposed", exposedLevels, exposedLabel));
    const comparatorSide = sideCondition("population.comparator", frame.comparator!.text ?? "", sideLeaves("population.comparator", comparatorLevels, comparatorLabel));
    const eitherSide: StudyCondition = { condition_id: "population.either_side", source_text: `${frame.exposure!.text}; ${frame.comparator!.text ?? ""}`, kind: "any", operands: [exposedSide, comparatorSide] };
    const bothSides: StudyCondition = { condition_id: "population.both_sides", source_text: "both sides", kind: "all", operands: [sideCondition("population.exposed_again", frame.exposure!.text, sideLeaves("population.exposed_b", exposedLevels, exposedLabel)), sideCondition("population.comparator_again", frame.comparator!.text ?? "", sideLeaves("population.comparator_b", comparatorLevels, comparatorLabel))] };
    const notBoth: StudyCondition = { condition_id: "population.not_both_sides", source_text: "not both sides", kind: "not", operand: bothSides };
    return { condition_id: "population.versus", source_text: question, kind: "all", operands: [...(frame.population ? [concept("population.target", frame.population)] : []), eitherSide, notBoth] };
  })() : undefined;
  const populationCriteria: StudyCondition | undefined = versusPopulation ?? (anyLevel && frame.population
    ? { condition_id: "population.all", source_text: `${frame.population.text}; ${frame.exposure!.text}`, kind: "all", operands: [concept("population.target", frame.population), anyLevel] }
    : anyLevel ?? (frame.population ? concept("population.target", frame.population) : undefined));
  const sexRestriction = frame.population ? populationSex(frame.population.qualified_text ?? frame.population.text) : undefined;
  const sexCondition: StudyCondition | undefined = sexRestriction ? { condition_id: "population.sex", source_text: frame.population!.qualified_text ?? frame.population!.text, kind: "category_comparison", concept: "Sex", operator: "in", values: [sexRestriction] } : undefined;
  const readmissionAnalysis = Boolean(frame.outcome && readmissionOutcome(frame.outcome, horizon));
  const aliveLeaf: StudyCondition | undefined = readmissionAnalysis ? { condition_id: "population.discharged_alive", source_text: "discharged alive", kind: "concept", concept: "Discharged alive", assertion: "present" } : undefined;
  const sexAndPopulation: StudyCondition | undefined = sexCondition ? (populationCriteria ? { condition_id: "population.with_sex", source_text: populationCriteria.source_text, kind: "all", operands: [populationCriteria, sexCondition] } : sexCondition) : populationCriteria;
  const restrictedCriteria: StudyCondition | undefined = aliveLeaf ? (sexAndPopulation ? { condition_id: "population.with_discharge", source_text: sexAndPopulation.source_text, kind: "all", operands: [sexAndPopulation, aliveLeaf] } : aliveLeaf) : sexAndPopulation;
  const populationDescription = versus ? `${frame.population ? `${frame.population.text}, ` : ""}${frame.exposure!.text} or ${frame.comparator!.text ?? "the comparator"} (not both)` : anyLevel ? `${frame.population ? `${frame.population.text}, ` : ""}${frame.exposure!.text}` : frame.population?.text;
  const compiled = levels.map((level, index) => {
    const others = level ? (levels as string[]).filter((other) => other !== level) : [];
    const comparatorText = activeComparator && level ? others.join("、") : frame.comparator?.text;
    const exposedName = exposedLevels.map(exposedLabel).join(" / ");
    const levelNormalized = level ? frame.exposure?.categories_normalized?.find(({ text }) => text === level) : undefined;
    const ratio = levelNormalized?.ratio;
    const formula = levelNormalized?.formula;
    const exposureSlot: FrameSlot | undefined = frame.exposure && level
      ? { text: level, verbatim: frame.exposure.verbatim, ...(levelNormalized ? { normalized: { label_en: ratio ? ratio.numerator_en : formula ? formula.parts[0]!.label_en : levelNormalized.label_en, category: levelNormalized.category } } : {}), ...(frame.exposure.aggregation ? { aggregation: frame.exposure.aggregation } : {}) }
      : frame.exposure;
    // A ratio level reads its numerator as the exposure and its denominator as a helper variable.
    const ratioDenominator = ratio ? { ...covariate(ratio.denominator_en), operational_definition: `${ratio.denominator_en} in the first 24 hours after the index time (denominator of ${levelNormalized!.label_en}).` } : undefined;
    // A formula level reads its first part as the exposure and the other parts as helper variables.
    const formulaParts = formula ? formula.parts.slice(1).map((part) => ({ ...covariate(part.label_en), operational_definition: `${part.label_en} in the first 24 hours after the index time (a part of ${levelNormalized!.label_en}).` })) : [];
    const outcome = frame.outcome ? outcomeFor(frame, frame.outcome, horizon, question) : undefined;
    const intent: StudySpec["intent_family"] = frame.facets.goal === "evaluate_treatment" ? "treatment_effect" : frame.facets.goal === "predict" ? "prediction" : "association";
    // A prediction question whose predictor the extraction put in the exposure slot still predicts from that variable.
    const predictorSlots = frame.facets.goal === "predict" ? (frame.predictors.length ? frame.predictors : exposureSlot ? [exposureSlot] : []) : [];
    const predictors = predictorSlots.map((slot, position) => exposureVariable(slot, "predictor", `input.${position + 1}`));
    const versusExposure: StudyVariable | undefined = versus ? {
      name: exposedName, role: "exposure",
      operational_definition: `Any recorded ${exposedLevels.map(exposedLabel).join(" or ")} within the first 24 hours after the index time (the comparison group received ${comparatorLevels.map(comparatorLabel).join(" or ")}).`,
      definition: sideCondition("exposure.exposed", frame.exposure!.text, sideLeaves("exposure.exposed", exposedLevels, exposedLabel)),
      contrast: { kind: "binary_presence" as const }, aggregation: "any" as const,
    } : undefined;
    const exposures = versusExposure ? [versusExposure] : frame.facets.goal !== "predict" && exposureSlot ? [exposureVariable(exposureSlot, "exposure", "input.1", frame.facets.dose_question || DOSE_WORDING.test(exposureSlot.text))] : [];
    const modifierNames = frame.modifiers.map(conceptOf);
    const mediatorVariables = frame.mediators.map((slot) => changeMediator(slot) ?? covariate(conceptOf(slot), slot.text));
    const mediatorNames = mediatorVariables.map(({ name }) => name);
    const mediatorWindows = mediatorVariables.some(({ derivation }) => derivation) ? [BASELINE_WINDOW, FOLLOW_UP_WINDOW] : [];
    const mediatorAssumptions = frame.mediators.filter((slot) => changeMediator(slot) && /[（(、，,]|速度|稳定/u.test(slot.text)).map((slot) => `Mediator “${slot.text}” is analysed as the magnitude of change (mean 24–72 h minus mean 0–24 h); speed and stability of the change are not derived.`);
    // Sex and gender are one variable in the data, so a gender modifier replaces the default sex covariate.
    const sameVariable = (other: string, name: string): boolean => { const key = (value: string): string => value.toLowerCase().replace(/gender/g, "sex"); return key(other).includes(key(name)); };
    // Age, sex and the Charlson index are in every Table 1; a description lists one only once (as a named characteristic or the grouping).
    const describedNames = describing ? [...characteristics.map(({ name }) => name), ...(exposureSlot ? [conceptOf(exposureSlot)] : [])] : [];
    const sameWord = (other: string, name: string): boolean => { const key = (value: string): string => value.toLowerCase().replace(/gender/g, "sex"); return new RegExp(`\\b${key(name)}\\b`, "u").test(key(other)); };
    const defaults = DEFAULT_COVARIATES.filter((name) => ![...modifierNames, ...mediatorNames].some((other) => sameVariable(other, name)) && !describedNames.some((other) => sameWord(other, name)) && !(sexRestriction && name === "Sex"));
    const exposureConcept = exposureSlot ? conceptOf(exposureSlot).toLowerCase() : "";
    const dosed = exposures.some(({ contrast, aggregation }) => contrast?.kind === "as_recorded" && aggregation === "sum");
    // A dose is given more to sicker patients, so illness severity is offered for dose questions as it is for treatments.
    const severity = (intent === "treatment_effect" || dosed) && exposureSlot
      ? SEVERITY_COVARIATES.filter((name) => !exposureConcept.includes(name.toLowerCase()) && ![...modifierNames, ...mediatorNames].some((other) => other.toLowerCase().includes(name.toLowerCase())))
      : [];
    // Treatment comparisons keep their established adjustment set, including the effect-modification and mediation analyses
    // that accompany them (a drug used or not); dose and other association questions also adjust for the outcome's baseline.
    const drugPresence = exposures.some(({ contrast }) => contrast?.kind === "binary_presence");
    // A dose is an amount among patients who received the drug: receiving it in the exposure window is eligibility, as it is
    // for drug-versus-drug plans, so a patient is enrolled at the first admission with the drug and not giving it is never
    // counted as a missing exposure.
    const received: StudyCondition | undefined = dosed && exposureSlot ? { condition_id: "population.received", source_text: exposureSlot.text, kind: "event_exists", concept: conceptOf(exposureSlot), occurrence: "present", window: EXPOSURE_WINDOW } : undefined;
    const criteria: StudyCondition | undefined = received ? restrictedCriteria ? { condition_id: "population.with_treatment", source_text: `${restrictedCriteria.source_text}; ${exposureSlot!.text}`, kind: "all", operands: [restrictedCriteria, received] } : received : restrictedCriteria;
    const description = received ? `${populationDescription ?? "Patients"} who received ${conceptOf(exposureSlot!)} in the first 24 hours` : populationDescription;
    const baselineAdjustment = intent === "treatment_effect" || drugPresence ? undefined : baselineOfOutcome(outcome?.outcome);
    const spec: StudySpec = {
      schema_version: "1.0.0",
      intent_family: intent,
      research_question: frame.sub_question,
      title: question,
      ...(criteria && (description || aliveLeaf) ? { population: { description: `${sexRestriction ? `${description ?? "Patients"} (${sexRestriction === "F" ? "women" : "men"} only)` : description ?? "Patients"}${aliveLeaf ? ", discharged alive" : ""}`, criteria } } : {}),
      index_time: icu ? { event: "ICU admission", selection_rule: "first ICU stay per patient" } : { event: "hospital admission", selection_rule: "first hospital admission per patient" },
      exposure_or_predictors: [...exposures, ...predictors],
      ...(outcome ? { outcome: outcome.outcome, outcome_structure: outcome.structure } : {}),
      ...(characteristics.length ? { characteristics } : {}),
      time_windows: [EXPOSURE_WINDOW, BASELINE_WINDOW, ...(outcome?.windows ?? []), ...(followedOverStay ? [horizon ?? { purpose: "outcome" as const, anchor: "index_time" as const, end_event: "end_of_encounter" as const }] : []), ...mediatorWindows].filter((window, position, all) => all.findIndex((other) => other.purpose === window.purpose) === position),
      covariates: [
        ...defaults.map((name) => covariate(name)),
        ...severity.map((name) => ({ ...covariate(name), operational_definition: `${name} in the first 24 hours after the index time (illness severity).` })),
        ...frame.modifiers.map((slot) => covariate(conceptOf(slot), slot.text)),
        ...mediatorVariables,
        ...(ratioDenominator ? [ratioDenominator] : []),
        ...formulaParts,
        ...(baselineAdjustment ? [baselineAdjustment] : []),
      ],
      ...(modifierNames.length ? { effect_modifiers: modifierNames.map((variable_name) => ({ variable_name, analysis: "interaction_and_stratified" as const })) } : {}),
      ...(outcome ? {
        estimand: {
          target_population: populationDescription ?? "eligible patients",
          exposure_contrast: versus ? `${frame.exposure!.text} vs ${comparatorLevels.join(" / ")}` : exposureSlot ? `${exposureSlot.text} vs ${comparatorText ?? `no ${exposureSlot.text}`}` : "not applicable",
          outcome_measure: frame.outcome!.text,
          summary_measure: outcome.structure === "binary" ? "risk difference and odds ratio" : outcome.structure === "time_to_event" ? "hazard ratio" : "mean difference",
        },
        analysis_family: analysisFamily(frame, outcome.structure),
      } : {}),
      assumptions: [...(versus ? [`The comparison is between patients who received ${exposedLevels.join(" or ")} and patients who received ${comparatorLevels.join(" or ")}; patients who received drugs of both sides, and patients who received neither, are not analysed.`] : []), ...(formula ? [`“${level}” is computed per patient as ${formula.expression.replace(/\b[a-z_][a-z0-9_]*\b/giu, (name) => formula.parts.find((part) => part.name === name)?.label_en ?? name)}, each part taken from the first 24 hours after time zero.`] : []), ...(ratio ? [`“${level}” is computed per patient as ${ratio.numerator_en} ÷ ${ratio.denominator_en}, each taken from the first 24 hours after time zero.`] : []), ...assumptions.filter((text) => !(anyLevel && text.startsWith("No population was stated"))), ...mediatorAssumptions, ...(baselineAdjustment ? [`The outcome is a change from baseline, so the baseline value (${baselineAdjustment.name.replace(/^Baseline /u, "")}, mean of the first 24 hours) is adjusted for.`] : []), ...(activeComparator && level ? [`Active comparator: the population is patients who received any of ${(levels as string[]).join("、")} in the first 24 hours; “${level}” is compared with patients who received ${others.join("、")} but not “${level}”. Patients receiving several listed classes count as exposed to each of them.`] : [])],
    };
    return { plan_id: `${frame.frame_id}${levels.length > 1 ? `.${index + 1}` : ""}`, frame_id: frame.frame_id, ...(level ? { exposure_level: level } : {}), study_spec: spec, roles: { mediators: mediatorNames, modifiers: modifierNames, default_covariates: [...defaults], ...(severity.length ? { severity: [...severity], severity_off: severity.filter((name) => SEVERITY_OFF.includes(name)) } : {}), ...(ratio ? { ratio: { numerator: ratio.numerator_en, denominator: ratio.denominator_en, label: levelNormalized!.label_en } } : {}), ...(formula ? { formula: { label: levelNormalized!.label_en, expression: formula.expression, variables: formula.parts.map((part) => ({ name: part.name, label: part.label_en })) } } : {}) } };
  });
  const shifted = frame.exposure_window_hours ? compiled.map((plan) => withExposureWindow(plan, frame.exposure_window_hours!)) : compiled;
  // Every sentence states the windows the plan runs with (restateAssumptions is a no-op for sentences already true).
  return shifted.map((plan) => withChangeFollowUp(plan, horizon)).map(withPredictionTime).map((plan) => ({ ...plan, study_spec: restateAssumptions(plan.study_spec) }));
};
