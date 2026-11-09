/**
 * Presentation logic shared by the review/running/results views — ported 1:1 from the previous vanilla
 * implementation (frontend/question-workspace/{views,results}.js). Kept as plain functions (not hooks) so both
 * components and other plain functions can call them; language-dependent behaviour takes `dict`/`lang` explicitly
 * instead of reading a hook, since this module has no React dependency.
 */
import type { Dict, Lang } from "./i18n";
import { MEASURE, RATIO_MEASURES, STUDY_TYPE } from "./i18n";
import type {
  DraftPlan,
  FrameSlot,
  PlanOutcome,
  QuestionRunRecord,
  StudyFrame,
  StudyMethodEstimate,
  StudyMethodResult,
} from "./api-types";

export const pickPair = (lang: Lang, pair: [string, string] | undefined): string => (pair ? pair[lang === "zh" ? 0 : 1] : "");

/** The local model never answered: the fix is on the host computer (open Ollama), not in the question. */
export const modelDidNotRespond = (unanswered: ReadonlyArray<{ frame: Pick<StudyFrame, "ambiguities"> }> | undefined): boolean =>
  (unanswered ?? []).some(({ frame }) => frame.ambiguities.some(({ code }) => code === "MODEL_NOT_RESPONDING"));

// ---- Step rail --------------------------------------------------------------------------------------------------

/** True once a "completed" run's own result confirms every plan was blocked — the run finished, but produced
 * nothing usable, which the badge should say plainly rather than call it "completed". */
export function ranWithNoResult(record: Pick<QuestionRunRecord, "status" | "result_summary">): boolean {
  return record.status === "completed" && !!record.result_summary && record.result_summary.completed === 0 && record.result_summary.plans > 0;
}

/** The server's stall threshold (STALLED_AFTER_MS in backend/src/question-workspace/run-progress-file.ts). */
export const STALLED_AFTER_MS = 90_000;

/**
 * Whether an active run should show as stalled. The server says so when the run's heartbeat is old, but once the server
 * itself is gone (terminal window closed, computer asleep) every poll fails and the page would keep the last "running"
 * record with no warning. So while the latest poll has failed, the page counts how long the server has not answered.
 * Both times are the page's own clock (the query's dataUpdatedAt and errorUpdatedAt), so the server's clock never matters,
 * and a run that has just gone from its plan to running is not flagged by the plan step's old heartbeat.
 */
export function isStalled(
  record: Pick<QuestionRunRecord, "status" | "live">,
  poll: { now: number; answeredAt: number; failedAt: number },
): boolean {
  if (record.live?.stalled) return true;
  const active = record.status === "running" || record.status === "drafting";
  return active && poll.failedAt > poll.answeredAt && poll.now - poll.answeredAt > STALLED_AFTER_MS;
}

/** How long ago `iso` was, said as "ago" so it is not read as a duration ("12 秒前" / "12 s ago"). */
export function formatSince(iso: string, lang: Lang, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const [value, unit] = seconds < 90 ? [seconds, 0] : seconds < 5400 ? [Math.round(seconds / 60), 1] : [Math.round(seconds / 3600), 2];
  return lang === "zh" ? `${value} ${["秒前", "分钟前", "小时前"][unit]}` : `${value} ${["s ago", "min ago", "h ago"][unit]}`;
}

export function stepIndex(record: Pick<QuestionRunRecord, "status" | "lock_id" | "reanalysis_of">): number {
  if (record.status === "completed") return 3;
  if (record.status === "running" || (record.status === "queued" && record.lock_id) || record.reanalysis_of) return 2;
  return 1;
}

// ---- Plain-language description of one plan ---------------------------------------------------------------------

export function levelLabel(lang: Lang, frame: StudyFrame | undefined, level: string): string {
  if (lang === "zh") return level;
  return frame?.exposure?.categories_normalized?.find((c) => c.text === level)?.label_en || level;
}

export function slotText(lang: Lang, slot: FrameSlot | undefined): string {
  if (!slot) return "";
  return lang === "zh" ? slot.text : slot.normalized?.label_en || slot.text;
}

interface PlanLike {
  frame_id: string;
  exposure_level?: string;
  study_spec: { exposure_or_predictors?: Array<{ name: string }>; outcome?: { name: string } };
}

export function planSentence(dict: Dict, lang: Lang, plan: PlanLike, frame: StudyFrame | undefined): string {
  const spec = plan.study_spec || ({} as PlanLike["study_spec"]);
  const S = dict.sentence;
  const levels = frame?.exposure?.categories || [];
  const treatment = frame?.facets?.goal === "evaluate_treatment";
  const active = treatment && plan.exposure_level && !frame?.comparator?.text && frame?.comparator?.kind !== "absence";
  const population = slotText(lang, frame?.population) || (active ? dict.listedAny : dict.allAdults);
  const exposure = plan.exposure_level
    ? levelLabel(lang, frame, plan.exposure_level)
    : slotText(lang, frame?.exposure) || spec.exposure_or_predictors?.[0]?.name || "";
  const comparator = frame?.comparator?.text
    ? lang === "zh" ? frame.comparator.text : dict.without(exposure)
    : active
      ? dict.others(exposure, levels.filter((l) => l !== plan.exposure_level).map((l) => levelLabel(lang, frame, l)).join(lang === "zh" ? "、" : ", "))
      : dict.without(exposure);
  let outcome = slotText(lang, frame?.outcome) || spec.outcome?.name || "";
  if (frame?.facets?.outcome_kind === "change_over_time") outcome = dict.changeOf(outcome);
  const list = (slots: FrameSlot[]) => slots.map((s) => slotText(lang, s)).join(lang === "zh" ? "、" : ", ");
  const listed = treatment && !plan.exposure_level && levels.length >= 2 && !frame?.comparator?.text && frame?.comparator?.kind !== "absence";
  const levelList = levels.map((l) => levelLabel(lang, frame, l)).join(lang === "zh" ? "、" : ", ");
  // Patients receiving any listed drug, within the stated population when there is one.
  const listedPopulation = slotText(lang, frame?.population) ? dict.listedAnyIn(slotText(lang, frame?.population)) : dict.listedAny;
  // Several exposures in one effect-modification or mediation aim still name the modifier or mediator.
  const allLevels = !plan.exposure_level && levels.length >= 2;
  if (frame?.study_type === "effect_modification" && (allLevels || !treatment)) return S.modifyRelate(listed ? listedPopulation : population, allLevels ? levelList : exposure, outcome, list(frame.modifiers));
  if (frame?.study_type === "mediation" && allLevels) return S.mediate(listed ? listedPopulation : population, levelList, outcome, list(frame.mediators));
  if (!treatment && allLevels && frame?.study_type !== "prediction") return S.relate(population, levelList, outcome);
  if (listed) return S.compareLevels(listedPopulation, levelList, outcome);
  switch (frame?.study_type) {
    case "effect_modification": return S.modify(population, exposure, comparator, outcome, list(frame.modifiers));
    case "mediation": return S.mediate(population, exposure, outcome, list(frame.mediators));
    case "descriptive": {
      // A description lists what it describes and, when asked, the grouping (sex, a drug received or not, age bands).
      const described = list(frame.characteristics ?? []) || dict.counts;
      const grouping = slotText(lang, frame.exposure);
      return grouping ? S.describeBy(population, grouping, described) : S.describe(population, described);
    }
    case "prediction": return S.predict(population, list(frame.predictors), outcome);
    case "dose_response": return S.dose(population, exposure, outcome);
    case "association": return S.relate(population, exposure, outcome);
    case "group_comparison": return S.groups(population, exposure, outcome);
    default: return treatment ? S.compare(population, exposure, comparator, outcome) : S.relate(population, exposure, outcome);
  }
}

export function studyTypeLabel(lang: Lang, studyType: string | undefined): string {
  return pickPair(lang, STUDY_TYPE[studyType ?? ""]);
}

// ---- Grouping plans by aim (frame_id) ---------------------------------------------------------------------------

export interface Aim<T> {
  frame_id: string;
  frame: StudyFrame | undefined;
  items: T[];
}

export function aimsOf<T>(items: T[], frames: StudyFrame[], planOf: (item: T) => { frame_id: string }): Aim<T>[] {
  const aims: Aim<T>[] = [];
  for (const item of items) {
    const plan = planOf(item);
    const frame = frames.find((f) => f.frame_id === plan.frame_id);
    let aim = aims.find((a) => a.frame_id === plan.frame_id);
    if (!aim) { aim = { frame_id: plan.frame_id, frame, items: [] }; aims.push(aim); }
    aim.items.push(item);
  }
  return aims;
}

export function warningsOf(protocol: DraftPlan["protocol"] | undefined) {
  return (protocol?.design_checks || []).filter((c) => c.status === "warn");
}

// ---- Results: estimate selection, direction, formatting ---------------------------------------------------------

/** A result that failed a check on the estimate itself (degenerate model, too few in a group, too few events) is never shown as a number. */
export function notReliablyEstimable(plan: { quality?: { checks: Array<{ check_id: string; status: string }> } | undefined }): boolean {
  return Boolean(plan.quality?.checks.some((check) => ["effect_size_plausible", "group_sizes", "outcome_events"].includes(check.check_id) && check.status === "fail"));
}

/** Notes that describe the data rather than a problem with the result; they are listed in the checks but do not turn the badge to a warning. */
export const INFORMATIONAL_CHECKS = ["extreme_values", "outcome_timing"];

/** The sample sizes behind a result that cannot be estimated, taken from its own checks (counts only). */
export function rawCounts(plan: { quality?: { checks: Array<{ check_id: string; observed: string }> } | undefined }): string[] {
  return (plan.quality?.checks ?? []).filter((check) => ["group_sizes", "outcome_events"].includes(check.check_id)).map((check) => check.observed);
}

/** The penalised-likelihood estimate added when a group has few events; the one number still shown for a result that cannot be estimated the usual way. */
export function sparseEstimate(run: StudyMethodResult | undefined): StudyMethodEstimate | undefined {
  return run?.estimates.find((row) => row.term === "exposure_firth");
}

/** Measures that describe a group or test a difference without sizing it; an effect measure is preferred as the headline. */
const NOT_PRIMARY = ["proportion", "mean", "test_statistic", "logrank_chisq"];

export function mainEstimate(run: StudyMethodResult): StudyMethodEstimate | undefined {
  return run.estimates.find((row) => !NOT_PRIMARY.includes(row.measure)) || run.estimates[0];
}

type HeadedPlan = Pick<PlanOutcome, "chosen_method" | "result">;
export type PlanHeadline =
  | { kind: "prediction"; auc?: StudyMethodEstimate; baseline?: StudyMethodEstimate }
  | { kind: "modification"; p_interaction: number; estimate?: StudyMethodEstimate }
  | { kind: "description"; estimates: StudyMethodEstimate[] }
  | { kind: "estimate"; estimate?: StudyMethodEstimate };

/**
 * What a completed analysis answers with; mirrors backend question-pipeline/headline.ts so the page, the report and the
 * Holm adjustment describe the same thing: a prediction model its test-set AUC, an effect-modification analysis its
 * interaction test (the estimate is one subgroup's), a description its whole-cohort proportions and means, anything else its first effect measure.
 */
export function planHeadline(plan: HeadedPlan): PlanHeadline {
  const estimates = plan.result?.estimates ?? [];
  if (plan.chosen_method?.startsWith("prediction.")) return { kind: "prediction", auc: estimates.find(({ term }) => term === "auc"), baseline: estimates.find(({ term }) => term === "auc_baseline") };
  // A description sizes no effect: each group's share, then each characteristic in the whole cohort, or in every group when only
  // groups were described (descriptive.rates). Between-group tests are never the answer.
  if (plan.chosen_method?.startsWith("descriptive.")) {
    const described = estimates.filter(({ measure }) => measure !== "test_statistic");
    const shares = described.filter(({ term }) => term.startsWith("group:"));
    const characteristics = described.filter(({ term }) => !term.startsWith("group:"));
    const overall = characteristics.filter(({ label }) => / \(overall\)$/u.test(label));
    return { kind: "description", estimates: [...shares, ...(overall.length ? overall : characteristics)] };
  }
  const estimate = plan.result ? mainEstimate(plan.result) : undefined;
  const interaction = plan.result?.diagnostics?.p_interaction;
  if (typeof interaction === "number" && Number.isFinite(interaction)) return { kind: "modification", p_interaction: interaction, estimate };
  return { kind: "estimate", estimate };
}

/** Digits enough to tell an estimate from its limits (a hazard ratio of 1.003 is not "1.00 (1.00–1.00)"). */
const distinguishable = (num: (v: number | null | undefined) => string, row: StudyMethodEstimate): ((v: number | null | undefined) => string) => {
  const values = [row.estimate, row.ci_low, row.ci_high].filter((v): v is number => v !== null && Number.isFinite(v));
  if (new Set(values.map((v) => num(v))).size === values.length) return num;
  for (const digits of [4, 5]) {
    const precise = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? num(v) : Math.abs(v) >= 1000 ? v.toFixed(0) : Number(v.toPrecision(digits)).toString());
    if (new Set(values.map((v) => precise(v))).size === values.length) return precise;
  }
  return num;
};

export function estimateText(lang: Lang, num: (v: number | null | undefined) => string, row: StudyMethodEstimate | undefined): string {
  if (!row) return "–";
  const label = pickPair(lang, MEASURE[row.measure]) || row.measure;
  const n = distinguishable(num, row);
  // "−2.39 to −1.71" reads better than "−2.39–−1.71".
  const separator = (row.ci_low ?? 0) < 0 || (row.ci_high ?? 0) < 0 ? (lang === "zh" ? " 至 " : " to ") : "–";
  return `${label} ${n(row.estimate)}${row.ci_low !== null && row.ci_high !== null ? ` (${n(row.ci_low)}${separator}${n(row.ci_high)})` : ""}`;
}

// Measures that compare the exposure with its comparator; "lower" or "higher" means nothing for an AUC, a proportion or a mean.
const COMPARATIVE_MEASURES = new Set([...RATIO_MEASURES, "risk_difference", "mean_difference", "indirect_effect", "direct_effect", "total_effect", "indirect_effect_product", "indirect_effect_difference", "location_shift"]);

export function direction(dict: Dict, row: StudyMethodEstimate | undefined): string {
  if (!row || row.ci_low === null || row.ci_high === null || !COMPARATIVE_MEASURES.has(row.measure)) return "";
  const zero = RATIO_MEASURES.has(row.measure) ? 1 : 0;
  return row.ci_low > zero ? dict.higher : row.ci_high < zero ? dict.lower : dict.noDiff;
}

/**
 * Lower / higher for one analysis, or nothing when the words would mislead: a result that is not reliably estimable, a
 * prediction or effect-modification analysis (answered by an AUC or an interaction test), or an unadjusted test whose
 * contrast is not named. For a change outcome it says the change was smaller or larger, not the value.
 */
export function planDirection(dict: Dict, plan: HeadedPlan & Pick<PlanOutcome, "quality">, frame: StudyFrame | undefined): string {
  if (notReliablyEstimable(plan)) return "";
  const headline = planHeadline(plan);
  if (headline.kind !== "estimate" || !headline.estimate) return "";
  if (plan.chosen_method === "tests.unadjusted" && ["mean_difference", "location_shift"].includes(headline.estimate.measure)) return "";
  const word = direction(dict, headline.estimate);
  if (frame?.facets?.outcome_kind !== "change_over_time") return word;
  return word === dict.lower ? dict.changeLower : word === dict.higher ? dict.changeHigher : word;
}

/** The proportion mediated with its interval, only when it can be read: a total effect whose interval excludes 0 and direct and indirect effects of the same sign. */
export function mediationText(dict: Dict, num: (v: number | null | undefined) => string, run: StudyMethodResult | undefined): string | undefined {
  const row = (term: string) => run?.estimates.find((estimate) => estimate.term === term);
  const proportion = run?.estimates.find(({ measure }) => measure === "proportion_mediated");
  if (!proportion) return undefined;
  const total = row("total"); const indirect = row("acme"); const direct = row("ade");
  const totalClear = total && total.ci_low !== null && total.ci_high !== null && (total.ci_low > 0 || total.ci_high < 0);
  const sameSign = indirect?.estimate !== null && direct?.estimate !== null && indirect && direct && Math.sign(indirect.estimate!) === Math.sign(direct.estimate!);
  if (!totalClear || !sameSign) return dict.mediatedNotInterpretable;
  const percent = (v: number | null) => (v === null ? "–" : `${num(v * 100)}%`);
  return `${dict.mediated} ${percent(proportion.estimate)}${proportion.ci_low !== null && proportion.ci_high !== null ? ` (${percent(proportion.ci_low)}–${percent(proportion.ci_high)})` : ""}`;
}

export function stageName(dict: Dict, stage: string): string {
  return dict.stageNames[stage] || stage;
}

/**
 * The raw question is never translated by the backend, but each aim's sentence already is — it's rebuilt from
 * the frame's structured, English-labeled slots rather than from the free text. Joining those sentences gives a
 * heading in the current UI language, so an English-authored question still reads in Chinese under 中文 and vice
 * versa. Returns undefined before framing has produced a frame_set (queued/drafting/early-failed runs).
 */
export function composeHeading(dict: Dict, lang: Lang, frameSet: { frames: StudyFrame[] } | undefined): string | undefined {
  if (!frameSet?.frames.length) return undefined;
  const sentences = frameSet.frames.map((frame) => planSentence(dict, lang, { frame_id: frame.frame_id, study_spec: {} }, frame));
  return sentences.join(lang === "zh" ? "；" : " ");
}

export type { PlanOutcome };
