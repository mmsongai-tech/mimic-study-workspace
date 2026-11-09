import { MINIMUM_FOLLOW_UP_HOURS, type StudySpec } from "../research-design/index.js";

/**
 * Time choices a researcher confirms with the plan. Each window has a default (what the plan was drafted with) and a
 * short list of alternatives; a choice re-times every window of that purpose, including the copies embedded in
 * conditions, so the cohort, the protocol and the report agree.
 */
export interface TimeOptionOffer {
  /** Window in which exposure and baseline factors are read, from time zero (hours). */
  exposure?: { default_hours: number; choices: number[] };
  /** End of the follow-up window of a change outcome, from time zero (hours). */
  follow_up_end?: { default_hours: number; choices: number[] };
  /** Horizon of an event outcome counted from time zero (hours). */
  outcome_horizon?: { default_hours: number; choices: number[] };
}
export interface TimeChoice { exposure_hours?: number; follow_up_end_hours?: number; outcome_horizon_hours?: number }
export interface ResolvedTime { exposure_hours?: number; follow_up_end_hours?: number; outcome_horizon_hours?: number }

type Window = NonNullable<StudySpec["time_windows"]>[number];
const HOURS: Record<string, number> = { minute: 1 / 60, hour: 1, day: 24, week: 168 };
const endHours = (window: Window | undefined): number | undefined => window && "end_offset" in window && typeof window.end_offset === "number" ? window.end_offset * (HOURS[window.unit] ?? NaN) : undefined;
const withDefault = (choices: number[], value: number): number[] => [...new Set([...choices, value])].sort((a, b) => a - b);

const EXPOSURE_CHOICES = [6, 12, 24, 48, 72];
const FOLLOW_UP_END_CHOICES = [48, 72, 96, 168];
const OUTCOME_HORIZON_CHOICES = [24, 48, 72, 168, 720];

/** The time choices a plan offers, from the windows its spec carries. */
export const offerTimeOptions = (spec: StudySpec): TimeOptionOffer | undefined => {
  const windows = spec.time_windows ?? [];
  const find = (purpose: string) => windows.find((window) => window.purpose === purpose);
  const exposure = endHours(find("exposure"));
  const followUp = endHours(find("follow_up"));
  const outcome = find("outcome"); const horizon = outcome && "end_offset" in outcome ? endHours(outcome) : undefined;
  const hasExposure = Boolean(spec.exposure_or_predictors?.length);
  // A prediction whose stated horizon ended inside the predictor window counts it from the prediction time (study-spec
  // compiler): moving the predictor window or the horizon would change what the stated horizon means, so neither is offered.
  const fromPrediction = (spec.assumptions ?? []).some((text) => text.startsWith("The stated horizon of") && text.endsWith("so it is counted from the prediction time."));
  const offer: TimeOptionOffer = {
    ...(hasExposure && !fromPrediction && exposure && Number.isFinite(exposure) ? { exposure: { default_hours: exposure, choices: withDefault(EXPOSURE_CHOICES, exposure) } } : {}),
    ...(followUp && Number.isFinite(followUp) ? { follow_up_end: { default_hours: followUp, choices: withDefault(FOLLOW_UP_END_CHOICES, followUp) } } : {}),
    ...(horizon && !fromPrediction && Number.isFinite(horizon) ? { outcome_horizon: { default_hours: horizon, choices: withDefault(OUTCOME_HORIZON_CHOICES, horizon) } } : {}),
  };
  return Object.keys(offer).length ? offer : undefined;
};

/** Why a choice cannot be used, or undefined when it can. */
export const timeChoiceProblem = (offer: TimeOptionOffer | undefined, choice: TimeChoice): string | undefined => {
  if (!offer) return Object.values(choice).some((value) => value !== undefined) ? "offers no time options" : undefined;
  if (choice.exposure_hours !== undefined && !offer.exposure?.choices.includes(choice.exposure_hours)) return `an exposure window of ${choice.exposure_hours} hours is not offered`;
  if (choice.follow_up_end_hours !== undefined && !offer.follow_up_end?.choices.includes(choice.follow_up_end_hours)) return `a follow-up end of ${choice.follow_up_end_hours} hours is not offered`;
  if (choice.outcome_horizon_hours !== undefined && !offer.outcome_horizon?.choices.includes(choice.outcome_horizon_hours)) return `an outcome horizon of ${choice.outcome_horizon_hours} hours is not offered`;
  const resolved = resolveTime(offer, choice);
  // The follow-up must last a day after the exposure window (research-design followUpEnd); a choice that leaves less, also with
  // the default end, is refused rather than extended, so what is confirmed is what runs.
  if (resolved.follow_up_end_hours !== undefined && resolved.exposure_hours !== undefined && resolved.follow_up_end_hours < resolved.exposure_hours + MINIMUM_FOLLOW_UP_HOURS) return `the follow-up must end at least ${MINIMUM_FOLLOW_UP_HOURS} hours after the exposure window; choose a later follow-up end`;
  if (resolved.outcome_horizon_hours !== undefined && resolved.exposure_hours !== undefined && offer.exposure && resolved.outcome_horizon_hours <= resolved.exposure_hours) return "the outcome horizon must be longer than the exposure window";
  return undefined;
};

/** The times a plan runs with: the choice where given, otherwise the default. */
export const resolveTime = (offer: TimeOptionOffer | undefined, choice: TimeChoice | undefined): ResolvedTime => ({
  ...(offer?.exposure ? { exposure_hours: choice?.exposure_hours ?? offer.exposure.default_hours } : {}),
  ...(offer?.follow_up_end ? { follow_up_end_hours: choice?.follow_up_end_hours ?? offer.follow_up_end.default_hours } : {}),
  ...(offer?.outcome_horizon ? { outcome_horizon_hours: choice?.outcome_horizon_hours ?? offer.outcome_horizon.default_hours } : {}),
});

const isWindow = (value: unknown): value is Window => typeof value === "object" && value !== null && "purpose" in value && "unit" in value && typeof (value as { purpose: unknown }).purpose === "string";

/**
 * Re-times every window in a spec or manifest (any depth) from the defaults of an offer to the resolved choice.
 * A window is changed only when it ends where the default ended, so windows of other purposes are left alone.
 */
export const retimeWindows = <T>(value: T, offer: TimeOptionOffer | undefined, resolved: ResolvedTime): T => {
  if (!offer) return value;
  const changed = (offer.exposure && resolved.exposure_hours !== offer.exposure.default_hours) || (offer.follow_up_end && resolved.follow_up_end_hours !== offer.follow_up_end.default_hours) || (offer.outcome_horizon && resolved.outcome_horizon_hours !== offer.outcome_horizon.default_hours);
  if (!changed) return value;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== "object" || node === null) return node;
    const copy: Record<string, unknown> = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    if (!isWindow(node)) return copy;
    const end = endHours(node);
    const start = "start_offset" in node && typeof node.start_offset === "number" ? node.start_offset * (HOURS[node.unit] ?? NaN) : undefined;
    const set = (patch: Record<string, unknown>) => Object.assign(copy, { unit: "hour" }, patch);
    if ((node.purpose === "exposure" || node.purpose === "baseline") && offer.exposure && resolved.exposure_hours !== undefined && end === offer.exposure.default_hours) set({ end_offset: resolved.exposure_hours });
    else if (node.purpose === "follow_up") {
      const patch: Record<string, unknown> = {};
      if (offer.exposure && resolved.exposure_hours !== undefined && start === offer.exposure.default_hours) patch.start_offset = resolved.exposure_hours;
      if (offer.follow_up_end && resolved.follow_up_end_hours !== undefined && end === offer.follow_up_end.default_hours) patch.end_offset = resolved.follow_up_end_hours;
      if (Object.keys(patch).length) set(patch);
    } else if (node.purpose === "outcome") {
      // A prediction's outcome window starts where its predictor window ends (study-spec compiler) and moves with it.
      const patch: Record<string, unknown> = {};
      if (offer.exposure && resolved.exposure_hours !== undefined && start && start === offer.exposure.default_hours) patch.start_offset = resolved.exposure_hours;
      if (offer.outcome_horizon && resolved.outcome_horizon_hours !== undefined && end === offer.outcome_horizon.default_hours) patch.end_offset = resolved.outcome_horizon_hours;
      if (Object.keys(patch).length) set({ ...(start !== undefined ? { start_offset: start } : {}), ...(end !== undefined ? { end_offset: end } : {}), ...patch });
    }
    return copy;
  };
  return walk(value) as T;
};
