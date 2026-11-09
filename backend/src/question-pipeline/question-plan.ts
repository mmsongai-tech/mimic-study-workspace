import { createHash } from "node:crypto";
import type { ExecutionManifest } from "../execution-manifest/index.js";
import { resolveTime, timeChoiceProblem, type ResolvedTime, type TimeChoice, type TimeOptionOffer } from "./time-options.js";
import type { StructuredChatAudit } from "../model-output/index.js";
import type { ClarificationRecord, MappingClarificationRecord } from "../question-clarification/index.js";
import type { AnalysisMethodOption } from "../study-analysis/index.js";
import type { CompiledStudyPlan, StudyFrame, StudyFrameSet } from "../study-framing/index.js";
import type { StudyProtocol } from "../study-protocol/index.js";
import type { MappingSummaryVariable, PlanOutcome } from "./plan-execution.js";

/**
 * A question's analysis plan before any patient data is read: every plan's design (as a target-trial protocol),
 * its mapped variables and frozen execution manifest, and the three methods it can use. A user confirms it once;
 * the locked plan then runs unattended and cannot drift, because the manifests are frozen and the lock is hashed.
 */
export interface DraftPlan {
  plan: CompiledStudyPlan;
  status: "ready" | "blocked";
  mapping?: MappingSummaryVariable[];
  /** Frozen execution manifest; present when ready. */
  manifest?: ExecutionManifest;
  /** Why the plan cannot run; present when blocked. */
  blocked_outcome?: PlanOutcome;
  method_options: AnalysisMethodOption[];
  default_method?: string;
  protocol: StudyProtocol;
  /** Design choices offered for this plan, with their defaults (the safer design). */
  design_options?: DesignOptions;
}

export interface DesignOptions {
  /** Start follow-up after the exposure window (landmark); offered when outcomes would otherwise count from time zero. */
  landmark?: { hours: number; default: boolean };
  /** Illness-severity adjustment variables that can be switched on or off; `default_on` are used unless changed. */
  severity?: { names: string[]; default_on: string[] };
  /** Time windows the researcher can change: exposure window, follow-up end of a change outcome, horizon of an event outcome. */
  time?: TimeOptionOffer;
}
export interface PlanOptionChoice { landmark?: boolean; severity_on?: string[]; time?: TimeChoice }

export interface QuestionPlanDraft {
  schema_version: "1.0.0";
  draft_id: string;
  question: string;
  created_at: string;
  versions: { study_spec_compiler: string; method_registry: string; protocol: string; model: string };
  data_source: { id: string; version: string };
  frame_set: StudyFrameSet;
  plans: DraftPlan[];
  unanswered_frames: Array<{ frame: StudyFrame; reasons: Array<{ en: string; zh: string }> }>;
  model_audit: StructuredChatAudit[];
  /** Readings offered for an outcome that named nothing measurable, and which one was taken (by the researcher or automatically). */
  clarifications?: ClarificationRecord[];
  /** Ways on offered for a variable the mapping only partly covers, and the one taken. */
  mapping_clarifications?: MappingClarificationRecord[];
}

export interface PlanChoices {
  /** Method per plan id; plans without a choice use their default method. */
  methods: Record<string, string>;
  /** Plan ids the user left out. */
  excluded: string[];
  /** Design choices per plan id; plans without an entry use the defaults of their design options. */
  options?: Record<string, PlanOptionChoice>;
}

export interface LockedQuestionPlan {
  schema_version: "1.0.0";
  lock_id: string;
  locked_at: string;
  confirmed_by: "user" | "automatic";
  draft: QuestionPlanDraft;
  choices: PlanChoices;
}

export class PlanLockError extends Error {}

const lockHash = (draft: QuestionPlanDraft, choices: PlanChoices): string =>
  `plan-lock:sha256:${createHash("sha256").update(JSON.stringify({ draft, choices })).digest("hex")}`;

/** Validates the user's choices against the draft and freezes both under one hash. */
/**
 * `allow_unrunnable`: a plan confirmed automatically is locked even when nothing can run, so the run still writes a
 * report saying why each analysis could not run (a user confirming by hand is told instead).
 */
export const lockQuestionPlan = (draft: QuestionPlanDraft, input: Partial<PlanChoices>, confirmedBy: LockedQuestionPlan["confirmed_by"], now: Date = new Date(), lockOptions: { allow_unrunnable?: boolean } = {}): LockedQuestionPlan => {
  const plans = new Map(draft.plans.map((item) => [item.plan.plan_id, item]));
  const methods = Object.fromEntries(Object.entries(input.methods ?? {}).filter(([, method]) => Boolean(method)));
  for (const [planId, method] of Object.entries(methods)) {
    const plan = plans.get(planId);
    if (!plan) throw new PlanLockError(`Unknown plan “${planId}”.`);
    if (!plan.method_options.some(({ method_id }) => method_id === method)) throw new PlanLockError(`“${method}” is not one of the methods offered for plan ${planId}.`);
  }
  const excluded = [...new Set(input.excluded ?? [])];
  for (const planId of excluded) if (!plans.has(planId)) throw new PlanLockError(`Unknown plan “${planId}”.`);
  const options: Record<string, PlanOptionChoice> = {};
  for (const [planId, choice] of Object.entries(input.options ?? {})) {
    const offered = plans.get(planId)?.design_options;
    if (!offered) throw new PlanLockError(`Plan “${planId}” offers no design options.`);
    if (choice.landmark !== undefined && !offered.landmark) throw new PlanLockError(`Plan “${planId}” offers no landmark option.`);
    const unknown = (choice.severity_on ?? []).filter((name) => !offered.severity?.names.includes(name));
    if (unknown.length) throw new PlanLockError(`“${unknown.join(", ")}” is not a severity variable offered for plan ${planId}.`);
    const problem = choice.time ? timeChoiceProblem(offered.time, choice.time) : undefined;
    if (problem) throw new PlanLockError(`Plan “${planId}”: ${problem}.`);
    options[planId] = { ...(choice.landmark !== undefined ? { landmark: choice.landmark } : {}), ...(choice.severity_on ? { severity_on: [...new Set(choice.severity_on)] } : {}), ...(choice.time && Object.values(choice.time).some((value) => value !== undefined) ? { time: choice.time } : {}) };
  }
  if (!lockOptions.allow_unrunnable && !draft.plans.some((item) => item.status === "ready" && !excluded.includes(item.plan.plan_id))) throw new PlanLockError("No runnable plan is left to run.");
  const choices = { methods, excluded, ...(Object.keys(options).length ? { options } : {}) };
  return { schema_version: "1.0.0", lock_id: lockHash(draft, choices), locked_at: now.toISOString(), confirmed_by: confirmedBy, draft, choices };
};

/** The design a plan runs with: the user's choice where given, otherwise the option's default. */
export const resolvedOptions = (plan: DraftPlan, choice: PlanOptionChoice | undefined): { landmark_hours?: number; severity_off: string[]; time: ResolvedTime } => {
  const offered = plan.design_options;
  const time = resolveTime(offered?.time, choice?.time);
  // The landmark follows the exposure window: follow-up starts where the exposure window ends.
  const landmark = offered?.landmark && (choice?.landmark ?? offered.landmark.default) ? (time.exposure_hours ?? offered.landmark.hours) : undefined;
  const on = choice?.severity_on ?? offered?.severity?.default_on ?? [];
  return { ...(landmark ? { landmark_hours: landmark } : {}), severity_off: (offered?.severity?.names ?? []).filter((name) => !on.includes(name)), time };
};

/** True when the locked plan is unchanged since it was confirmed. */
export const lockIsIntact = (locked: LockedQuestionPlan): boolean => locked.schema_version === "1.0.0" && locked.lock_id === lockHash(locked.draft, locked.choices);
