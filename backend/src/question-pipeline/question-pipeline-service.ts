import { createHash } from "node:crypto";
import { isVariableDefinition } from "../variable-mapping/index.js";
import { restateAssumptions, StudyFramingError } from "../study-framing/index.js";
import { acceptKey, broaderAssumption, chooseMappingOption, clarificationOffers, decide, defineAssumption, fidelityStops, mappingOptions, readingAssumption, type ClarificationRecord, type ClarifyPolicy, type MappingClarificationRecord, type ReadingCatalog } from "../question-clarification/index.js";
import type { ProposedDefinition } from "../variable-definitions/index.js";
import { modelNotResponding, type StructuredChatAudit } from "../model-output/index.js";
import { compileStudyPlans, parseHorizon, STUDY_SPEC_COMPILER_VERSION, type CompiledStudyPlan, type StudyFrame, type StudyFrameSet, type StudyType } from "../study-framing/index.js";
import { METHOD_REGISTRY_VERSION, methodOptions } from "../study-analysis/index.js";
import { buildStudyProtocol, STUDY_PROTOCOL_VERSION } from "../study-protocol/index.js";
import { offerTimeOptions, retimeWindows } from "./time-options.js";
import { adjustForMultiplicity, type MultiplicityAdjustment } from "./multiplicity.js";
import { applyQuestionScope, inQuestionScope } from "./question-scope.js";
import type { ExecutionManifest } from "../execution-manifest/index.js";
import { manifestNotModelled, outcomeTypeOf, plannedNotModelled, preparePlan, runPreparedPlan, withNotModelled, type PlanExecutionDependencies, type PlanOutcome } from "./plan-execution.js";
import { lockIsIntact, lockQuestionPlan, PlanLockError, resolvedOptions, type DesignOptions, type DraftPlan, type LockedQuestionPlan, type PlanChoices, type QuestionPlanDraft } from "./question-plan.js";

export interface QuestionRunResult {
  schema_version: "1.0.0";
  run_id: string;
  question: string;
  created_at: string;
  versions: { study_spec_compiler: string; method_registry: string; model: string };
  data_source: { id: string; version: string };
  frame_set: StudyFrameSet;
  plans: PlanOutcome[];
  unanswered_frames: Array<{ frame: StudyFrame; reasons: Array<{ en: string; zh: string }> }>;
  summary: { frames: number; plans: number; completed: number; blocked: number; failed: number; needs_clarification: number };
  /** Holm-adjusted headline P values when a question ran several analyses. */
  multiplicity?: MultiplicityAdjustment | undefined;
  model_audit: StructuredChatAudit[];
  /** The confirmed plan this run executed. */
  plan_lock?: { lock_id: string; locked_at: string; confirmed_by: LockedQuestionPlan["confirmed_by"] };
}

/** Decides which composite-outcome components MIMIC can measure (supplied by mimic-limitations at composition). */
export type OutcomeComponentAssessor = (components: Array<{ text: string; label_en?: string; category?: import("../study-framing/index.js").SlotCategory }>) => {
  kept: Array<{ text: string; concept_en: string; substituted_from?: string }>;
  excluded: Array<{ text: string; reason: { en: string; zh: string } }>;
};

/** Decides, per aim, what MIMIC-IV cannot observe (supplied by mimic-limitations at composition). */
export type FrameAssessor = (frame: StudyFrame) => {
  follow_up_cap?: { max_days: number; capped_label: { en: string; zh: string }; reason: { en: string; zh: string } };
  not_answerable?: { slot: "population" | "exposure" | "outcome"; text: string; reason: { en: string; zh: string } };
};

export interface QuestionPipelineDependencies extends PlanExecutionDependencies {
  assess_outcome_components?: OutcomeComponentAssessor;
  assess_frame?: FrameAssessor;
  /** The concepts the frame's sub-question names that no slot of the frame carries, as readable labels (see study-framing/question-coverage.ts). */
  unaccounted_terms?: (frame: StudyFrame) => string[];
  framing: { frame(question: string): Promise<{ frame_set: StudyFrameSet; audits: StructuredChatAudit[] }> };
  /** The study types this release plans (configuration `question_scope`); an aim of another type is reported unanswered with the reason. Undefined allows every type. */
  allowed_study_types?: readonly StudyType[];
  /** Readings offered when an outcome names nothing measurable ("efficacy"); without it such an aim stops for clarification as before. */
  clarification_readings?: ReadingCatalog;
  /** Drafts a definition from the dictionary for a term the mapping only partly covers, and saves a chosen one so the plan can be prepared again. */
  mapping_proposal?: { propose(term: string, role: string): Promise<ProposedDefinition | undefined>; define(proposal: ProposedDefinition): Promise<void> };
  model: string;
  data_source: { id: string; version: string };
  now?: () => Date;
  /** Called after each plan so long runs can report progress. */
  on_plan?: (outcome: PlanOutcome, index: number, total: number) => void;
}

/**
 * The ambiguities an unanswered aim shows the researcher. An aim outside the release's question scope shows only that
 * reason: its other ones (a missing element, a vague outcome) ask for changes that would not make it analysable.
 */
const shownAmbiguities = (frame: StudyFrame): StudyFrame["ambiguities"] => {
  const scope = frame.ambiguities.filter(({ code }) => code === "STUDY_TYPE_NOT_SUPPORTED");
  return scope.length ? scope : frame.ambiguities;
};

const reasonsFor = (frame: StudyFrame): Array<{ en: string; zh: string }> => shownAmbiguities(frame).map(({ code, message, message_zh, slot }) => ({
  en: message,
  zh: message_zh ? message_zh : code === "OUTCOME_NOT_MEASURABLE" ? "复合结局的各组成部分均无法在 MIMIC-IV 中作为结局测量（详见英文说明与局限性）。"
    : code === "SLOT_MISSING" ? `问题中缺少该研究类型所需的“${slot ?? ""}”要素，请补充。`
    : code === "VAGUE_OUTCOME" ? "结局描述过于笼统（如“疗效”），请说明具体用哪个测量值或事件来定义。"
    : code === "QUESTION_NOT_READ" ? "模型没能把这个问题读成可分析的形式，请换一种写法（写明人群、药物或指标、结局）。"
    : code === "STUDY_TYPE_NOT_SUPPORTED" ? "本版本暂不支持此类分析。"
    : code === "ASYMMETRIC_COMPARATOR" ? "对照组否定的是另一种药物而非暴露本身，请确认对照组定义。"
    : "该要素是推断得出、未在原问题中出现，请确认。",
}));

/** The one aim of a question the model could not read; it needs clarification and carries no analysis. */
const unreadableFrame = (question: string, ambiguity: StudyFrame["ambiguities"][number] = { code: "QUESTION_NOT_READ", message: "The question could not be read automatically (the model returned no usable answer). Rephrase it with the population, the drug or measure, and the outcome.", message_zh: "模型没能把这个问题读成可分析的形式，请换一种写法（写明人群、药物或指标、结局）。" }): StudyFrame => ({
  frame_id: "f1", sub_question: question, study_type: "association", facets: { goal: "relate_factor", outcome_kind: "none", dose_question: false, has_modifier: false, has_mediator: false },
  modifiers: [], mediators: [], predictors: [], assumptions: [], status: "needs_clarification",
  ambiguities: [ambiguity],
});

/** The model never answered (not running, timed out, or the model is not installed): the fix is on the computer, not in the question. */
const modelNotRespondingAmbiguity = (model: string): StudyFrame["ambiguities"][number] => ({
  code: "MODEL_NOT_RESPONDING",
  message: `The local model did not respond: make sure Ollama is open and the model ${model} is installed, then submit the question again.`,
  message_zh: `本地模型没有响应：请确认 Ollama 已打开、模型 ${model} 已下载，然后重新提交问题。`,
});

/**
 * Runs a research question end to end: framing, deterministic plan compilation, and independent execution of
 * every plan. A blocked or failed plan never stops the others; every terminal state carries its reason.
 */
export class QuestionPipelineService {
  constructor(private readonly dependencies: QuestionPipelineDependencies) {}

  /**
   * Applies answerability rules to a composite outcome before compilation: substitutes and exclusions are written into
   * the frame's assumptions; a composite with no measurable component needs clarification with the reasons.
   */
  private resolveCompositeOutcome(frame: StudyFrame): void {
    const outcome = frame.outcome; const assess = this.dependencies.assess_outcome_components;
    if (!assess || !outcome?.components?.length) return;
    const normalized = new Map((outcome.components_normalized ?? []).map((item) => [item.text, item]));
    const assessment = assess(outcome.components.map((text) => ({ text, ...(normalized.get(text) ? { label_en: normalized.get(text)!.label_en, category: normalized.get(text)!.category } : {}) })));
    for (const item of assessment.kept.filter(({ substituted_from }) => substituted_from)) frame.assumptions.push(`Outcome component “${item.substituted_from}” is analysed as ${item.concept_en}, the closest outcome MIMIC-IV records.`);
    for (const item of assessment.excluded) frame.assumptions.push(`Outcome component “${item.text}” is not combined into the composite: ${item.reason.en} It is analysed on its own as an association with that diagnosis.`);
    if (!assessment.kept.length) {
      frame.status = "needs_clarification";
      frame.ambiguities.push({ code: "OUTCOME_NOT_MEASURABLE", slot: "outcome", message: `None of the components of “${outcome.text}” can be measured as an outcome in MIMIC-IV.` });
      return;
    }
    outcome.components_resolved = assessment.kept;
  }

  /** One aim per component that cannot be combined (known only from undated diagnosis codes), after the composite itself. */
  private splitExcludedComponents(frames: StudyFrame[]): StudyFrame[] {
    const assess = this.dependencies.assess_outcome_components; if (!assess) return frames;
    let next = Math.max(0, ...frames.map(({ frame_id }) => Number(frame_id.replace(/^f/u, "")) || 0)) + 1;
    const result: StudyFrame[] = [];
    for (const frame of frames) {
      const outcome = frame.outcome;
      if (!outcome?.components?.length) { result.push(frame); continue; }
      const normalized = new Map((outcome.components_normalized ?? []).map((item) => [item.text, item]));
      const assessment = assess(outcome.components.map((text) => ({ text, ...(normalized.get(text) ? { label_en: normalized.get(text)!.label_en, category: normalized.get(text)!.category } : {}) })));
      const own = assessment.kept.length > 0;
      if (own) result.push(frame);
      for (const item of assessment.excluded) {
        const part = structuredClone(frame);
        part.frame_id = `f${next++}`;
        part.sub_question = `${frame.sub_question}（${item.text}）`;
        part.status = "ready";
        part.ambiguities = part.ambiguities.filter(({ code }) => code !== "OUTCOME_NOT_MEASURABLE");
        const known = normalized.get(item.text);
        part.outcome = { text: item.text, verbatim: false, ...(known ? { normalized: { label_en: known.label_en, category: known.category } } : {}) };
        part.assumptions = [...part.assumptions.filter((text) => !text.includes("is not combined into the composite")), `“${item.text}” is one part of “${outcome.text}”. It is known only from diagnosis codes of the admission, which carry no date, so it is analysed on its own as an association with that diagnosis, not combined with the other parts.`];
        result.push(part);
      }
      if (!own && !assessment.excluded.length) result.push(frame);
    }
    return result;
  }

  /** Frames the question and prepares every plan (mapping and frozen manifests) without reading patient data. */
  /**
   * Applies what MIMIC-IV cannot observe to one aim: an aim naming absent data needs clarification with the reason;
   * an outcome horizon beyond the observable follow-up is shortened, and the report says so.
   */
  private applyAnswerability(frame: StudyFrame): void {
    const assessment = this.dependencies.assess_frame?.(frame);
    if (!assessment) return;
    if (assessment.not_answerable) {
      const { text, reason, slot } = assessment.not_answerable;
      frame.status = "needs_clarification";
      // The decisive reason comes first.
      frame.ambiguities.unshift({ code: "NOT_IN_MIMIC", slot, message: `“${text}”: ${reason.en}`, message_zh: `“${text}”：${reason.zh}` });
    }
    const cap = assessment.follow_up_cap; const horizon = parseHorizon(frame.time_window);
    const days = horizon && "end_offset" in horizon ? horizon.end_offset * ({ minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30.4375, year: 365.25 } as Record<string, number>)[horizon.unit]! : undefined;
    if (cap && days !== undefined && days > cap.max_days + 1) {
      frame.assumptions.push(`The requested follow-up “${frame.time_window}” is longer than MIMIC-IV observes: ${cap.reason.en} It is analysed as ${cap.capped_label.en}.`);
      frame.time_window = `${cap.max_days}天`;
    }
  }

  /** A concept the question names but the plan does not carry is stated in the plan, so the researcher sees what was left out. */
  private noteUnaccounted(frame: StudyFrame): void {
    const missing = this.dependencies.unaccounted_terms?.(frame) ?? [];
    if (missing.length) frame.assumptions.push(`Named in the question but not part of this analysis: ${missing.join(", ")}. Check that this is intended (命名于问题但未进入本分析：${missing.join("、")}，请确认是否有意如此).`);
  }

  /**
   * `clarify`: what to do with an aim whose outcome names nothing measurable. `ask` (the default) stops the aim and lists up to
   * three readings for the researcher; `first` and `random` choose one and frame the question again with it, for batch tests.
   */
  /**
   * Prepares one plan. A variable that only partly matches the question is offered up to three ways on (a narrower definition drafted
   * from the dictionary, the broader concept, stopping); a test run may choose one, and the plan is then prepared again.
   */
  private async prepareWithClarification(plan: CompiledStudyPlan, frame: StudyFrame, asked: string, policy: ClarifyPolicy, accepted: Set<string>, records: MappingClarificationRecord[]): Promise<Awaited<ReturnType<typeof preparePlan>>> {
    let prepared = await preparePlan(plan, this.dependencies, accepted);
    const proposal = this.dependencies.mapping_proposal;
    if (!proposal) return prepared;
    const found: MappingClarificationRecord[] = [];
    for (const stop of fidelityStops(prepared.mapping ?? [], true)) {
      const record: MappingClarificationRecord = { plan_id: plan.plan_id, frame_id: frame.frame_id, role: stop.role, term: stop.term, ...(stop.candidate ? { candidate: stop.candidate } : {}), uncovered: stop.uncovered,
        options: await mappingOptions(stop, (term, role) => proposal.propose(term, role)) };
      if (accepted.has(acceptKey(stop.role, stop.term))) record.chosen = { option_id: "broader", by: "user" };
      // A term nothing matched and no definition could be drafted for has no way on to offer; the blocker already says so.
      if (!stop.candidate && record.options.length === 1) continue;
      found.push(record);
    }
    let changed = false;
    for (const record of found) {
      if (!record.chosen) {
        const choice = chooseMappingOption(policy, asked, record);
        if (choice) {
          record.chosen = { option_id: choice, by: policy === "first" ? "automatic_first" : "automatic_random" };
          const offered = record.options.find(({ option_id }) => option_id === choice);
          if (choice === "define" && offered?.proposal) { await proposal.define(offered.proposal); changed = true; }
          if (choice === "broader") { accepted.add(acceptKey(record.role, record.term)); changed = true; }
        }
      }
      if (record.chosen?.option_id === "broader") frame.assumptions.push(broaderAssumption(record));
      const defined = record.options.find(({ option_id }) => option_id === "define")?.proposal;
      if (record.chosen?.option_id === "define" && defined) frame.assumptions.push(defineAssumption(record, defined));
      if (!records.some((other) => other.frame_id === record.frame_id && other.role === record.role && other.term === record.term)) records.push(record);
    }
    if (changed) prepared = await preparePlan(plan, this.dependencies, accepted);
    return prepared;
  }

  async draft(asked: string, request: { clarify?: ClarifyPolicy; accept?: string[] } = {}): Promise<QuestionPlanDraft> {
    const accepted = new Set(request.accept ?? []); const mappingClarifications: MappingClarificationRecord[] = [];
    const first = await this.dependencies.framing.frame(asked).catch((error: unknown) => {
      // The model returned nothing usable: the aim stops with a reason instead of the run failing. A rule reason (such as
      // "a recommendation is out of scope") is added once, by the answerability pass every frame goes through below.
      if (!(error instanceof StudyFramingError)) throw error;
      // A model that never answered says so (its failure class stays in the audit), instead of asking the user to rephrase.
      const frame = modelNotResponding(error.failure_class) ? unreadableFrame(asked, modelNotRespondingAmbiguity(this.dependencies.model)) : unreadableFrame(asked);
      return { frame_set: { schema_version: "1.0.0" as const, original_question: asked, frames: [frame] }, audits: error.audits };
    });
    let { frame_set } = first; const audits = [...first.audits];
    let clarifications: ClarificationRecord[] = [];
    const catalog = this.dependencies.clarification_readings;
    if (catalog) {
      // An aim outside the question scope is not planned, so no reading is offered for it.
      const offers = clarificationOffers(asked, frame_set.frames.filter((frame) => inQuestionScope(frame, this.dependencies.allowed_study_types)), catalog);
      const decided = decide(asked, offers, request.clarify ?? "ask");
      clarifications = decided.records;
      if (decided.question !== asked) {
        const again = await this.dependencies.framing.frame(decided.question);
        frame_set = again.frame_set; audits.push(...again.audits);
        for (const record of clarifications) {
          const note = readingAssumption(record); const chosen = record.options.find(({ option_id }) => option_id === record.chosen?.option_id);
          const frame = chosen && frame_set.frames.find(({ sub_question }) => sub_question.includes(chosen.sub_question) || chosen.sub_question.includes(sub_question));
          if (note && frame) { frame.assumptions.push(note); record.frame_id = frame.frame_id; }
        }
      }
    }
    const question = asked;
    frame_set.frames = this.splitExcludedComponents(frame_set.frames);
    for (const frame of frame_set.frames) { this.resolveCompositeOutcome(frame); this.applyAnswerability(frame); this.noteUnaccounted(frame); }
    // Last, so that the scope reason is the first one an excluded aim shows.
    applyQuestionScope(frame_set.frames, this.dependencies.allowed_study_types);
    const compiled = frame_set.frames.flatMap((frame) => compileStudyPlans(frame, frame_set.original_question).map((plan) => ({ plan, frame })));
    const plans: DraftPlan[] = [];
    for (const { plan, frame } of compiled) {
      const options = methodOptions(frame.study_type, outcomeTypeOf(plan), frame.facets.goal);
      let prepared: Awaited<ReturnType<typeof preparePlan>>;
      try { prepared = await this.prepareWithClarification(plan, frame, asked, request.clarify ?? "ask", accepted, mappingClarifications); }
      catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected failure.";
        prepared = withNotModelled<PlanOutcome>({ plan_id: plan.plan_id, frame_id: plan.frame_id, study_spec: plan.study_spec, status: "failed", stage_reached: "mapping", blockers: [{ stage: "mapping", code: "UNEXPECTED_FAILURE", message: { en: message, zh: `运行出错：${message}` } }] }, plannedNotModelled(plan));
      }
      if (prepared.kind === "prepared") {
        // A dose asked of a drug that only prescription records describe: the records carry no administered amount.
        const summed = (plan.study_spec.exposure_or_predictors ?? []).find(({ role, aggregation }) => role === "exposure" && aggregation === "sum");
        if (summed && prepared.mapping?.some(({ role, selected }) => role === "exposure" && selected?.table.endsWith("prescriptions"))) {
          const note = `Prescription records carry no administered amount, so “${summed.name}” is the number of prescription records in the first 24 hours, not a dose. （处方记录没有实际给药量，这里用前 24 小时的处方条数代替剂量。）`;
          if (!frame.assumptions.includes(note)) frame.assumptions.push(note);
        }
        // A variable a researcher defined is used at once, and the report says it has not been reviewed (docs/decisions/0009).
        for (const variable of prepared.mapping ?? []) {
          const chosen = variable.selected;
          if (!chosen || !isVariableDefinition(chosen) || ["validated", "clinician_confirmed"].includes(chosen.status)) continue;
          const note = `“${chosen.label}” is a variable defined by a researcher or the team and not yet reviewed by a clinician. （“${chosen.label}”是研究者或团队定义的变量，尚未经临床医生审核。）`;
          if (!frame.assumptions.includes(note)) frame.assumptions.push(note);
        }
      }
      const designOptions = designOptionsFor(plan);
      const base = { plan, method_options: options, ...(options[0] ? { default_method: options[0].method_id } : {}), protocol: protocolFor(plan, frame, options[0]?.label, resolvedOptions({ design_options: designOptions } as DraftPlan, undefined), prepared.kind === "prepared" ? prepared.manifest : undefined, options[0]?.method_id), ...(designOptions ? { design_options: designOptions } : {}) };
      const kept = prepared.kind === "prepared" && prepared.dropped?.length ? (designOptions?.severity?.names ?? []).filter((name) => !prepared.dropped!.includes(name)) : undefined;
      plans.push(prepared.kind === "prepared"
        ? { ...base, ...(prepared.study_spec ? { plan: { ...plan, study_spec: prepared.study_spec, roles: { ...plan.roles, ...(kept ? { severity: kept } : {}) } } } : {}),
          ...(kept && designOptions?.severity ? { design_options: { ...designOptions, severity: { names: kept, default_on: designOptions.severity.default_on.filter((name) => kept.includes(name)) } } } : {}),
          status: "ready", mapping: prepared.mapping, manifest: prepared.manifest }
        : { ...base, status: "blocked", ...(prepared.mapping ? { mapping: prepared.mapping } : {}), blocked_outcome: { ...prepared, protocol: base.protocol } });
    }
    const createdAt = (this.dependencies.now?.() ?? new Date()).toISOString();
    const body = { question: frame_set.original_question, frames: frame_set.frames, plans: plans.map(({ plan, manifest }) => ({ plan, manifest: manifest?.manifest_id })) };
    return {
      schema_version: "1.0.0",
      draft_id: `question-plan:${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 20)}`,
      question, created_at: createdAt,
      versions: { study_spec_compiler: STUDY_SPEC_COMPILER_VERSION, method_registry: METHOD_REGISTRY_VERSION, protocol: STUDY_PROTOCOL_VERSION, model: this.dependencies.model },
      data_source: this.dependencies.data_source, frame_set, plans,
      unanswered_frames: frame_set.frames.filter(({ status }) => status !== "ready").map((frame) => ({ frame, reasons: reasonsFor(frame) })),
      model_audit: audits,
      ...(clarifications.length ? { clarifications } : {}),
      ...(mappingClarifications.length ? { mapping_clarifications: mappingClarifications } : {}),
    };
  }

  /** Runs a confirmed plan: data extraction, the confirmed methods, checks. No model call and no re-mapping. */
  async runLocked(locked: LockedQuestionPlan): Promise<QuestionRunResult> {
    if (!lockIsIntact(locked)) throw new PlanLockError("The locked plan was changed after it was confirmed; confirm it again.");
    const { draft, choices } = locked;
    const outcomes: PlanOutcome[] = [];
    // The confirmed design of each plan: landmark on the frozen manifest, switched-off adjustment variables, protocol.
    const applied = new Map(draft.plans.map((item) => {
      const resolved = resolvedOptions(item, choices.options?.[item.plan.plan_id]);
      const frame = draft.frame_set.frames.find(({ frame_id }) => frame_id === item.plan.frame_id)!;
      const offer = item.design_options?.time;
      const retimed = offer && JSON.stringify(resolved.time) !== JSON.stringify(Object.fromEntries(Object.entries({ exposure_hours: offer.exposure?.default_hours, follow_up_end_hours: offer.follow_up_end?.default_hours, outcome_horizon_hours: offer.outcome_horizon?.default_hours }).filter(([, value]) => value !== undefined)));
      // A time choice moves the windows; the sentences that name them are restated to match (also for a draft compiled
      // before the sentences were corrected).
      const plan = { ...item.plan, study_spec: restateAssumptions(retimeWindows(item.plan.study_spec, offer, resolved.time)), roles: { ...item.plan.roles, excluded_covariates: resolved.severity_off } };
      const timed = item.manifest ? retimeWindows(item.manifest, offer, resolved.time) : item.manifest;
      const suffix = `${retimed ? `:time-${Object.values(resolved.time).join("-")}h` : ""}${resolved.landmark_hours ? `:landmark-${resolved.landmark_hours}h` : ""}`;
      const manifest = timed && (resolved.landmark_hours || retimed)
        ? { ...timed, manifest_id: `${item.manifest!.manifest_id}${suffix}`, ...(resolved.landmark_hours ? { extraction: { ...timed.extraction, landmark_hours: resolved.landmark_hours } } : {}) } : timed;
      const chosen = item.method_options.find(({ method_id }) => method_id === (choices.methods[item.plan.plan_id] ?? item.default_method));
      return [item, { plan, manifest, method_id: chosen?.method_id, protocol: protocolFor(plan, frame, chosen?.label, resolved, manifest, chosen?.method_id) }] as const;
    }));
    const reported = draft.plans.filter((item) => !choices.excluded.includes(item.plan.plan_id));
    // Every confirmed plan's cohort is extracted in one pass over the archive when the runner supports it.
    const runnable = reported.filter((item) => item.status === "ready" && item.manifest);
    const cohorts = new Map<string, Promise<import("../clinical-data/index.js").LocalExecutionGraphResult>>();
    if (this.dependencies.runner.runMany && runnable.length > 1) {
      const manifests = [...new Map(runnable.map((item) => applied.get(item)!.manifest!).map((manifest) => [manifest.manifest_id, manifest])).values()];
      this.dependencies.on_stage?.({ plan_id: "all", stage: "cohort", state: "started", detail: `${manifests.length} cohorts in one pass` });
      const results = await this.dependencies.runner.runMany(this.dependencies.archive_path, manifests);
      manifests.forEach((manifest, position) => cohorts.set(manifest.manifest_id, Promise.resolve(results[position]!)));
      this.dependencies.on_stage?.({ plan_id: "all", stage: "cohort", state: "finished", detail: `${manifests.length} cohorts` });
    }
    const runner: PlanExecutionDependencies["runner"] = { run: (archivePath, manifest) => cohorts.get(manifest.manifest_id) ?? this.dependencies.runner.run(archivePath, manifest) };
    for (const item of draft.plans) {
      const { plan, manifest: appliedManifest, method_id: appliedMethod, protocol } = applied.get(item)!;
      const frame = draft.frame_set.frames.find(({ frame_id }) => frame_id === plan.frame_id)!;
      let outcome: PlanOutcome;
      if (choices.excluded.includes(plan.plan_id)) {
        outcome = withNotModelled<PlanOutcome>({ plan_id: plan.plan_id, frame_id: plan.frame_id, ...(plan.exposure_level ? { exposure_level: plan.exposure_level } : {}), study_spec: plan.study_spec, protocol, status: "blocked", stage_reached: "method",
          blockers: [{ stage: "method", code: "EXCLUDED_BY_USER", message: { en: "Left out when the plan was confirmed.", zh: "确认计划时未选择运行。" } }] }, manifestNotModelled(plan, appliedManifest, appliedMethod));
      } else if (item.status !== "ready" || !item.manifest || !item.mapping) {
        outcome = item.blocked_outcome!;
      } else {
        // A confirmed choice wins; otherwise the caller's chooser (command-line flags), then the recommended default.
        const confirmed = choices.methods[plan.plan_id];
        const wanted = confirmed ?? item.default_method;
        let requestedUnavailable = false;
        const dependencies: PlanExecutionDependencies = { ...this.dependencies, runner, choose_method: (compiledPlan, options) => {
          if (confirmed && options.some(({ method_id, readiness }) => method_id === confirmed && readiness.available)) return confirmed;
          if (confirmed) requestedUnavailable = true;
          return this.dependencies.choose_method?.(compiledPlan, options) ?? options.find(({ readiness }) => readiness.available)?.method_id;
        } };
        try {
          outcome = { ...await runPreparedPlan(plan, frame, { kind: "prepared", mapping: item.mapping, manifest: appliedManifest! }, dependencies), protocol };
          if (requestedUnavailable && outcome.chosen_method) {
            const reason = outcome.method_options?.find(({ method_id }) => method_id === wanted)?.readiness.reasons.map(({ en }) => en).join(" ") ?? "";
            const reasonZh = outcome.method_options?.find(({ method_id }) => method_id === wanted)?.readiness.reasons.map(({ zh }) => zh).join("") ?? "";
            outcome.method_note = { en: `The confirmed method ${wanted} could not run on this cohort (${reason}); ${outcome.chosen_method} was used instead.`, zh: `确认的方法 ${wanted} 无法在该队列上运行（${reasonZh}），改用 ${outcome.chosen_method}。` };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unexpected failure.";
          outcome = withNotModelled<PlanOutcome>({ plan_id: plan.plan_id, frame_id: plan.frame_id, study_spec: plan.study_spec, protocol, status: "failed", stage_reached: "cohort", blockers: [{ stage: "cohort", code: "UNEXPECTED_FAILURE", message: { en: message, zh: `运行出错：${message}` } }] } as PlanOutcome, manifestNotModelled(plan, appliedManifest, appliedMethod));
        }
      }
      outcomes.push(outcome);
      if (reported.includes(item)) this.dependencies.on_plan?.(outcome, reported.indexOf(item) + 1, reported.length);
    }
    const createdAt = (this.dependencies.now?.() ?? new Date()).toISOString();
    const body = { question: draft.question, frames: draft.frame_set.frames, lock: locked.lock_id, plans: outcomes.map(({ plan_id, status, result }) => ({ plan_id, status, estimates: result?.estimates })) };
    return {
      schema_version: "1.0.0",
      run_id: `question-run:${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 20)}`,
      question: draft.question, created_at: createdAt,
      versions: { study_spec_compiler: draft.versions.study_spec_compiler, method_registry: draft.versions.method_registry, model: draft.versions.model },
      data_source: draft.data_source, frame_set: draft.frame_set, plans: outcomes, unanswered_frames: draft.unanswered_frames,
      summary: {
        frames: draft.frame_set.frames.length, plans: outcomes.length,
        completed: outcomes.filter(({ status }) => status === "completed").length,
        blocked: outcomes.filter(({ status }) => status === "blocked").length,
        failed: outcomes.filter(({ status }) => status === "failed").length,
        needs_clarification: draft.unanswered_frames.length,
      },
      multiplicity: adjustForMultiplicity(outcomes),
      model_audit: draft.model_audit,
      plan_lock: { lock_id: locked.lock_id, locked_at: locked.locked_at, confirmed_by: locked.confirmed_by },
    };
  }

  /** One-shot run without review: the draft is confirmed automatically with the given (or recommended) choices. */
  async run(question: string, choices: Partial<PlanChoices> = {}, clarify?: ClarifyPolicy): Promise<QuestionRunResult> {
    const draft = await this.draft(question, clarify ? { clarify } : {});
    return this.runLocked(lockQuestionPlan(draft, choices, "automatic", this.dependencies.now?.(), { allow_unrunnable: true }));
  }
}

/** Design options a plan offers: a 24-hour landmark when event outcomes would count during the exposure window; severity. */
const designOptionsFor = (plan: CompiledStudyPlan): DesignOptions | undefined => {
  const spec = plan.study_spec; const window = (purpose: string) => spec.time_windows?.find((candidate) => candidate.purpose === purpose);
  const exposureWindow = window("exposure"); const outcomeWindow = window("outcome");
  const exposureHours = exposureWindow && "end_offset" in exposureWindow ? exposureWindow.end_offset * (exposureWindow.unit === "day" ? 24 : exposureWindow.unit === "hour" ? 1 : 0) : 0;
  const outcomeFromZero = !outcomeWindow || !("start_offset" in outcomeWindow) || outcomeWindow.start_offset === 0;
  const event = spec.outcome_structure === "binary" || spec.outcome_structure === "time_to_event";
  const landmark = spec.exposure_or_predictors?.some(({ role }) => role === "exposure") && event && exposureHours > 0 && outcomeFromZero && !spec.outcome?.derivation
    ? { hours: exposureHours, default: true } : undefined;
  const severity = plan.roles.severity?.length ? { names: [...plan.roles.severity], default_on: plan.roles.severity.filter((name) => !(plan.roles.severity_off ?? []).includes(name)) } : undefined;
  const time = offerTimeOptions(spec);
  return landmark || severity || time ? { ...(landmark ? { landmark } : {}), ...(severity ? { severity } : {}), ...(time ? { time } : {}) } : undefined;
};

/** The target-trial protocol of a plan with its design choices applied. */
const protocolFor = (plan: CompiledStudyPlan, frame: StudyFrame, analysisLabel: { en: string; zh: string } | undefined, resolved: { landmark_hours?: number; severity_off: string[] }, manifest?: ExecutionManifest, methodId?: string) => {
  const levels = frame.exposure?.categories ?? [];
  return buildStudyProtocol({
    study_spec: plan.study_spec, ...(frame.comparator ? { comparator: frame.comparator } : {}),
    ...(plan.exposure_level && frame.facets.goal === "evaluate_treatment" && !frame.comparator?.text && frame.comparator?.kind !== "absence" ? { active_comparator_levels: levels.filter((level) => level !== plan.exposure_level), exposure_level: plan.exposure_level } : {}),
    ...(analysisLabel ? { analysis_label: analysisLabel.en, analysis_label_zh: analysisLabel.zh } : {}),
    ...(resolved.landmark_hours ? { landmark_hours: resolved.landmark_hours } : {}),
    // The same list as the report: switched off, the exposure itself, a part of it, the analysed mediator.
    excluded_covariates: [...new Set([...resolved.severity_off, ...manifestNotModelled(plan, manifest, methodId).map(({ name }) => name)])],
    ...(frame.study_type === "descriptive" ? { description: true } : {}),
  });
};

