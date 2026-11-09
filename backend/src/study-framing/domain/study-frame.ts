export type StudyGoal = "describe" | "compare_groups" | "relate_factor" | "evaluate_treatment" | "predict";
export type OutcomeKind = "event" | "time_to_event" | "value" | "change_over_time" | "count" | "none";
/** Every study type the framing can derive; configuration names a subset of these as the release's question scope. */
export const STUDY_TYPES = [
  "descriptive", "group_comparison", "association", "treatment_effect", "time_to_event",
  "longitudinal_change", "dose_response", "effect_modification", "mediation", "prediction",
] as const;
export type StudyType = typeof STUDY_TYPES[number];
export type FramingAim = "main" | "effect_modification" | "mediation";
export type SlotCategory = "demographic" | "encounter" | "vital_sign" | "laboratory" | "medication" | "intervention" | "diagnosis" | "score" | "outcome" | "unknown";

/** Model output for one sub-question (contracts/study-framing/frame-extraction.schema.json). */
export interface FrameExtraction {
  goal: StudyGoal;
  outcome_kind: OutcomeKind;
  dose_question: boolean;
  population: string;
  exposure: string;
  exposure_categories: string[];
  comparator: string;
  outcomes: string[];
  composite_outcome: string;
  modifiers: string[];
  mediators: string[];
  predictors: string[];
  time_window: string;
}

export type SlotAggregation = "maximum" | "minimum" | "mean" | "first" | "last" | "sum";
export interface FrameSlot {
  /** The concept; aggregation and time words of the phrase are split off into `aggregation` and `qualified_text`. */
  text: string;
  verbatim: boolean;
  qualified_text?: string;
  aggregation?: SlotAggregation;
  /** A cut-off written in the phrase ("≥75小时"); the outcome is whether it is met. */
  threshold?: { operator: "gt" | "gte" | "lt" | "lte"; value: number; unit?: string };
  /** `source`: "catalog" when a rule or lookup decided the label, "model" when the small model translated it. */
  normalized?: { label_en: string; category: SlotCategory; source?: "catalog" | "model" };
  categories?: string[];
  /** English label and data category for each level in `categories`, in the same order. */
  /** A population phrase that names several conditions or treatments: the concepts it is the conjunction of. */
  parts?: string[];
  categories_normalized?: Array<{ text: string; label_en: string; category: SlotCategory; source?: "catalog" | "model"; ratio?: { numerator_en: string; denominator_en: string }; formula?: FrameFormula }>;
  components?: string[];
  components_normalized?: Array<{ text: string; label_en: string; category: SlotCategory }>;
  /** Components after answerability rules: the measurable concept each is analysed as. */
  components_resolved?: Array<{ text: string; concept_en: string; substituted_from?: string }>;
}

export type FrameAmbiguityCode = "SLOT_MISSING" | "ASYMMETRIC_COMPARATOR" | "SLOT_NOT_IN_QUESTION" | "VAGUE_OUTCOME" | "OUTCOME_NOT_MEASURABLE" | "NOT_IN_MIMIC" | "QUESTION_NOT_READ" | "MODEL_NOT_RESPONDING" | "STUDY_TYPE_NOT_SUPPORTED";
/** `message_zh` carries a Chinese message when the reason comes from a bilingual source (the limitations knowledge base). */
export interface FrameAmbiguity { code: FrameAmbiguityCode; slot?: string; message: string; message_zh?: string }

export interface StudyFrame {
  frame_id: string;
  sub_question: string;
  study_type: StudyType;
  facets: { goal: StudyGoal; outcome_kind: OutcomeKind; dose_question: boolean; has_modifier: boolean; has_mediator: boolean };
  population?: FrameSlot;
  exposure?: FrameSlot;
  /** `levels`: the drugs of an active comparator ("A vs B"), one item or a listed group; `levels_normalized`: their English labels. */
  comparator?: { kind: "absence" | "active" | "unspecified"; text?: string; levels?: string[]; levels_normalized?: Array<{ text: string; label_en: string; category: SlotCategory; source?: "catalog" | "model" }> };
  outcome?: FrameSlot;
  modifiers: FrameSlot[];
  mediators: FrameSlot[];
  predictors: FrameSlot[];
  /**
   * A description (study type "descriptive") has no outcome to relate to an exposure: what it reports are these
   * characteristics, each as a proportion or mean of the cohort (and of each group when `exposure` names a grouping).
   * A yes/no characteristic such as in-hospital death is a described rate here, not an outcome to model.
   */
  characteristics?: FrameSlot[];
  time_window?: string;
  /** The window after time zero in which predictors or exposures are read, when the question states it ("first 6 hours of vital signs"); 24 hours otherwise. */
  exposure_window_hours?: number;
  assumptions: string[];
  ambiguities: FrameAmbiguity[];
  status: "ready" | "needs_clarification";
}

/** A defined formula variable: arithmetic over named parts, the first of which is read as the exposure and the others as helper variables. */
export interface FrameFormula { expression: string; parts: Array<{ name: string; label_en: string }>; unit?: string }

export interface StudyFrameSet { schema_version: "1.0.0"; original_question: string; frames: StudyFrame[] }

/**
 * The most specific design label implied by the facets. Relations layered on a base comparison
 * (mediation, modification, dose) take precedence because they need their own analysis method;
 * the facets keep the base design for method selection.
 */
export const deriveStudyType = (facets: StudyFrame["facets"]): StudyType => {
  if (facets.has_mediator) return "mediation";
  if (facets.has_modifier) return "effect_modification";
  if (facets.goal === "predict") return "prediction";
  // A descriptive aim stays descriptive even when it reports doses or trends over time.
  if (facets.goal === "describe") return "descriptive";
  if (facets.dose_question) return "dose_response";
  if (facets.outcome_kind === "time_to_event") return "time_to_event";
  if (facets.outcome_kind === "change_over_time") return "longitudinal_change";
  if (facets.goal === "compare_groups") return "group_comparison";
  if (facets.goal === "evaluate_treatment") return "treatment_effect";
  return "association";
};

type SlotName = "population" | "exposure" | "outcome" | "modifiers" | "mediators" | "predictors";

/** Slots a study type cannot be analysed without. A missing required slot needs clarification. */
export const requiredSlots = (type: StudyType): SlotName[] => {
  switch (type) {
    case "descriptive": return ["population"];
    case "prediction": return ["population", "outcome"];
    case "effect_modification": return ["population", "exposure", "outcome", "modifiers"];
    case "mediation": return ["population", "exposure", "outcome", "mediators"];
    default: return ["population", "exposure", "outcome"];
  }
};
