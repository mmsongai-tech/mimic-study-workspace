import { randomUUID } from "node:crypto";
import type { ResearchDesignClarificationTurn, ResearchDesignModel } from "./research-design-model.js";
import { DesignError } from "./design-error.js";
import { alignUnresolvedIntentWithAssessment, assertIntentCanChange, assertIntentIsConsistent, decideDesignState } from "./design-rules.js";
import type { DesignSession } from "./design-session.js";
import type { ConfirmedStudySpec } from "./design-session.js";
import type { StudySpec } from "./study-spec.js";
import { ResearchDesignModelError } from "./research-design-model.js";
import { assessResearchProtocol } from "./research-protocol-assessment.js";
import { createConfirmedStudySpecIntegrityId } from "./confirmed-study-spec-integrity.js";
import { createDesignRequestFingerprint } from "./design-request-fingerprint.js";
import type { StudySpecPatchEngine } from "./study-spec-patch-engine.js";
import type { DesignSessionRepository } from "./design-session-repository.js";
import type { ProcessedDesignRequest } from "./processed-design-request.js";
import type { ResearchDesignProposal } from "./model-proposal.js";
import type { ConfirmDesignRequest, ContinueDesignRequest, StartDesignRequest } from "./requests.js";
import type { ResearchDesignTemplate, ResearchDesignTemplateContext, ResearchDesignTemplateRegistry } from "./research-design-template.js";
import type { ResearchDesignSessionSnapshot, ResearchDesignView } from "./responses.js";
import { JsonSchemaResearchDesignValidator, type ResearchDesignValidation } from "./schema-validator.js";
import { toResearchDesignView } from "./research-design-view-mapper.js";
import { objectivePreservationIssues, withAnalysisObjectiveSummary } from "./analysis-objectives.js";

const withDerivedAnalysisFamily = (spec: StudySpec): StudySpec => {
  if (spec.analysis_family || spec.intent_family === "undetermined") return spec;
  const timeToEvent = spec.outcome_structure === "time_to_event" || spec.outcome_structure === "competing_risk";
  const analysis_family = spec.intent_family === "association"
    ? (timeToEvent ? "time_to_event_association" : "association")
    : spec.intent_family === "prediction"
      ? (timeToEvent ? "time_to_event_prediction" : "binary_prediction")
      : (timeToEvent ? "time_to_event_treatment_effect" : "propensity_weighted_treatment_effect");
  return { ...spec, analysis_family };
};

const withEffectModifierCovariates = (spec: StudySpec): StudySpec => {
  if (!spec.effect_modifiers?.length) return spec;
  const covariates = [...(spec.covariates ?? [])];
  const names = new Set(covariates.map(({ name }) => name));
  for (const modifier of spec.effect_modifiers) {
    if (names.has(modifier.variable_name)) continue;
    covariates.push({
      name: modifier.variable_name,
      role: "covariate",
      operational_definition: modifier.variable_name,
    });
    names.add(modifier.variable_name);
  }
  return covariates.length === (spec.covariates?.length ?? 0) ? spec : { ...spec, covariates };
};

export interface ResearchDesignPolicy {
  maxRequestChars: number;
  maxAnswers: number;
  maxPatchOperations: number;
  maxRevisions: number;
  supportedStudySpecVersions: string[];
}

export interface ResearchDesignServiceDependencies {
  model: ResearchDesignModel;
  sessions: DesignSessionRepository;
  validation: ResearchDesignValidation;
  patchEngine: StudySpecPatchEngine;
  templates: ResearchDesignTemplateRegistry;
  now: () => Date;
  requestClaimTtlMs: number;
  policy: ResearchDesignPolicy;
  onProposalValidation?: (result: {
    json_parse: "pass" | "fail" | "not_run";
    schema_validation: "pass" | "fail" | "not_run";
    business_validation: "pass" | "fail" | "not_run";
    failure_class?: string;
  }) => void;
}

export const normalizeResearchDesignProposal = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const aggregations: Record<string, string> = { max: "maximum", highest: "maximum", min: "minimum", lowest: "minimum", average: "mean", avg: "mean", earliest: "first", latest: "last", presence: "any" };
  const conversions: Record<string, { unit: string; factor: number }> = { year: { unit: "month", factor: 12 }, week: { unit: "day", factor: 7 }, day: { unit: "hour", factor: 24 }, hour: { unit: "minute", factor: 60 } };
  const normalizeSpec = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    const spec = candidate as Record<string, unknown>;
    for (const collection of [spec.exposure_or_predictors, spec.covariates, spec.outcome ? [spec.outcome] : []]) if (Array.isArray(collection)) for (const rawVariable of collection) if (rawVariable && typeof rawVariable === "object" && !Array.isArray(rawVariable)) { const variable=rawVariable as Record<string,unknown>; const normalized=aggregations[String(variable.aggregation).toLocaleLowerCase()]; if(normalized) variable.aggregation=normalized; }
    if (!Array.isArray(spec.time_windows)) return;
    const timeWindows: unknown[] = spec.time_windows;
    spec.time_windows = timeWindows.map((raw) => { if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw; const window = raw as Record<string, unknown>; const start=Number(window.start_offset); const end=Number(window.end_offset); if(Number.isInteger(start)&&Number.isInteger(end))return window; const conversion=conversions[String(window.unit)]; if(!conversion)return window; const convertedStart=start*conversion.factor;const convertedEnd=end*conversion.factor;return Number.isInteger(convertedStart)&&Number.isInteger(convertedEnd)?{...window,start_offset:convertedStart,end_offset:convertedEnd,unit:conversion.unit}:window; });
    const normalizedWindows = spec.time_windows as unknown[];
    if (!normalizedWindows.some((raw) => raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).purpose === "outcome")) {
      spec.time_windows = normalizedWindows.map((raw) => raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).purpose === "follow_up"
        ? { ...(raw as Record<string, unknown>), purpose: "outcome" }
        : raw);
    }
  };
  const normalizeProposalObject = (candidate: Record<string, unknown>): Record<string, unknown> => {
    if (candidate.intent_assessment && typeof candidate.intent_assessment === "object" && !Array.isArray(candidate.intent_assessment)) {
      const assessment = candidate.intent_assessment as Record<string, unknown>;
      if (!("clarifying_question" in assessment) && (typeof assessment.clarification_question === "string" || assessment.clarification_question === null)) {
        assessment.clarifying_question = assessment.clarification_question;
      }
      delete assessment.clarification_question;
      if (assessment.confidence === "moderate") assessment.confidence = "medium";
      if (assessment.clarification_required === false && assessment.recommended_intent !== "undetermined") {
        assessment.confidence = "high";
      } else if (assessment.clarification_required === true && assessment.confidence !== "low" && assessment.confidence !== "medium") {
        assessment.confidence = "medium";
      }
      if (!("clarifying_question" in assessment)) {
        if (assessment.clarification_required === false) {
          assessment.clarifying_question = null;
        } else if (assessment.clarification_required === true && Array.isArray(candidate.clarifying_questions)) {
          const firstQuestion = candidate.clarifying_questions.find((question) =>
            question && typeof question === "object" && !Array.isArray(question) && typeof (question as Record<string, unknown>).prompt === "string"
          ) as Record<string, unknown> | undefined;
          if (firstQuestion) assessment.clarifying_question = firstQuestion.prompt;
        }
      }
    }
    if (Array.isArray(candidate.warnings)) {
      const allowedFieldPath = /^\/(title|research_question|intent_family|population|index_time|exposure_or_predictors|outcome|outcome_structure|time_windows|covariates|effect_modifiers|estimand|analysis_family|assumptions)(\/.*)?$/u;
      for (const warning of candidate.warnings) {
        if (!warning || typeof warning !== "object" || Array.isArray(warning)) continue;
        const record = warning as Record<string, unknown>;
        if (typeof record.field_path === "string" && !allowedFieldPath.test(record.field_path)) delete record.field_path;
      }
    }
    normalizeSpec(candidate.candidate_spec);
    if (Array.isArray(candidate.suggestions)) {
      for (const suggestion of candidate.suggestions) {
        if (suggestion && typeof suggestion === "object" && !Array.isArray(suggestion)) normalizeSpec((suggestion as Record<string, unknown>).candidate_spec);
      }
    }
    return candidate;
  };
  const proposal = structuredClone(value) as Record<string, unknown>;

  // Some OpenAI-compatible routers add a single transport envelope even when
  // the requested JSON object is otherwise correct. Unwrap only the exact
  // known envelope and only when its payload passes the unchanged schema.
  if (Object.keys(proposal).length === 1 && proposal.data && typeof proposal.data === "object" && !Array.isArray(proposal.data)) {
    const payload = normalizeProposalObject(proposal.data as Record<string, unknown>);
    if (new JsonSchemaResearchDesignValidator().checkProposal(payload).length === 0) return payload;
  }
  return normalizeProposalObject(proposal);
};

export class ResearchDesignService {
  constructor(private readonly dependencies: ResearchDesignServiceDependencies) {}

  async start(request: StartDesignRequest): Promise<ResearchDesignView> {
    this.assertValidRequest(this.dependencies.validation.checkStartRequest(request));
    this.assertRequestWithinPolicy(request);
    const requestFingerprint = createDesignRequestFingerprint("start", request);
    const processed = await this.findProcessedRequest(request.client_request_id);
    if (processed) return this.replayView(processed, "start", requestFingerprint);
    const claimToken = await this.claimModelRequest("start", request.client_request_id, requestFingerprint);
    try {
      // The researcher's exact question is authoritative input, not a model
      // inference. Persist it before the first proposal so every clarification
      // turn retains the original semantics even when a provider emits a
      // partial candidate.
      const selectedTemplate = request.template_id
        ? this.dependencies.templates.get(request.template_id)
        : undefined;
      if (request.template_id && !selectedTemplate) {
        throw new DesignError("DESIGN_INVALID_INPUT", "The requested research design template is not registered.");
      }
      const reusable = await this.dependencies.sessions.findConfirmedByResearchQuestion?.(request.message);
      if (
        reusable?.confirmation && reusable.last_proposal && request.study_spec_contract !== "objectives-v1" &&
        (!selectedTemplate || reusable.spec.intent_family === selectedTemplate.intent_family)
      ) {
        const sessionId = randomUUID();
        const revision = 1;
        const spec = structuredClone(reusable.spec);
        const proposal = { ...structuredClone(reusable.last_proposal), candidate_spec: spec };
        const reusableDecisions = reusable.clarification_review_history?.length
          ? reusable.clarification_review_history
          : (reusable.clarification_history ?? []).flatMap(({ answer_context = [] }) => answer_context);
        const reusedDesignReview = {
          source_integrity_id: reusable.confirmation.result.integrity_id,
          decisions: reusableDecisions.map((answer) => structuredClone(answer)),
        };
        const view: ResearchDesignView = {
          ...toResearchDesignView(sessionId, revision, spec, proposal, "ready_to_confirm", ["confirm", "revise"]),
          reused_design_review: reusedDesignReview,
        };
        const session: DesignSession = {
          id: sessionId,
          revision,
          spec,
          phase: "ready_to_confirm",
          revisions: [{ revision, spec, phase: "ready_to_confirm" }],
          clarification_history: [],
          last_proposal: proposal,
          reused_design_review: reusedDesignReview,
        };
        const record: ProcessedDesignRequest = {
          operation: "start",
          request_id: request.client_request_id,
          request_fingerprint: requestFingerprint,
          result: view,
        };
        const saved = await this.dependencies.sessions.create(session, record, claimToken);
        if (!saved) throw new DesignError("DESIGN_STORAGE_FAILURE", "The reusable design session could not be saved.");
        return view;
      }
      const initialSpec: StudySpec = {
        schema_version: "1.0.0",
        intent_family: selectedTemplate?.intent_family ?? "undetermined",
        research_question: request.message,
        ...(request.study_spec_contract === "objectives-v1" ? { analysis_objectives: { schema_version: "1.0.0" as const, original_question: request.message, requested: [], objectives: [] } } : {}),
      };
      const { proposal, spec } = await this.getValidProposalAndSpec(
        request,
        initialSpec,
        [],
        this.templateContext(selectedTemplate),
      );
      this.assertSelectedTemplateMatches(selectedTemplate, spec);
      const sessionId = randomUUID();
      const view = this.buildView(sessionId, 1, spec, proposal);
      const session: DesignSession = {
        id: sessionId,
        revision: 1,
        spec,
        phase: view.phase,
        revisions: [{ revision: 1, spec, phase: view.phase }],
        clarification_history: [],
        last_proposal: proposal,
      };
      const record: ProcessedDesignRequest = {
        operation: "start",
        request_id: request.client_request_id,
        request_fingerprint: requestFingerprint,
        result: view,
      };
      let saved: boolean;
      try {
        saved = await this.dependencies.sessions.create(session, record, claimToken);
      } catch {
        throw new DesignError("DESIGN_STORAGE_FAILURE", "The design session could not be saved.");
      }
      if (!saved) throw new DesignError("DESIGN_STORAGE_FAILURE", "The design session could not be saved.");
      return view;
    } finally {
      await this.releaseRequest(request.client_request_id, claimToken);
    }
  }

  async continue(request: ContinueDesignRequest): Promise<ResearchDesignView> {
    this.assertValidRequest(this.dependencies.validation.checkContinueRequest(request));
    this.assertRequestWithinPolicy(request);
    const requestFingerprint = createDesignRequestFingerprint("continue", request);
    const processed = await this.findProcessedRequest(request.client_request_id);
    if (processed) return this.replayView(processed, "continue", requestFingerprint);
    const claimToken = await this.claimModelRequest("continue", request.client_request_id, requestFingerprint);
    try {
      const current = await this.findSession(request.session_id);
      if (current.revision !== request.base_revision) {
        throw new DesignError("DESIGN_REVISION_CONFLICT", "The design has changed. Refresh and try again.");
      }
      if (current.revision >= this.dependencies.policy.maxRevisions) {
        throw new DesignError("DESIGN_LIMIT_EXCEEDED", "The design revision limit has been reached.");
      }

      const clarificationHistory = current.clarification_history ?? [];
      const clarificationTurn = this.toClarificationTurn(request, current.last_proposal);
      const reviewDecisions = this.toReviewableDecisions(request, current.last_proposal);
      const selectedSuggestion = request.suggestion_id
        ? current.last_proposal?.suggestions.find(({ id }) => id === request.suggestion_id)
        : undefined;
      const answerKeys = Object.keys(request.answers ?? {});
      const resolvesEffectModifierMapping = answerKeys.length === 1 &&
        answerKeys[0] === "protocol-effect_modifier_variable_missing" &&
        Boolean(current.last_proposal && current.spec.effect_modifiers?.length);
      let proposal: ResearchDesignProposal;
      let spec: StudySpec;
      if (resolvesEffectModifierMapping) {
        spec = withEffectModifierCovariates(structuredClone(current.spec));
        proposal = {
          ...current.last_proposal!,
          candidate_spec: spec,
          spec_patch: [],
          clarifying_questions: current.last_proposal!.clarifying_questions.filter(({ id }) => id !== "protocol-effect_modifier_variable_missing"),
        };
      } else if (selectedSuggestion?.candidate_spec) {
        const errors = this.dependencies.validation.checkStudySpec(selectedSuggestion.candidate_spec);
        if (errors.length) throw new DesignError("DESIGN_PROPOSAL_INVALID", "The selected design reference is invalid.", errors);
        proposal = {
          ...current.last_proposal!,
          assistant_message: selectedSuggestion.explanation,
          candidate_spec: structuredClone(selectedSuggestion.candidate_spec),
          clarifying_questions: [],
          suggestions: [],
          readiness: "candidate_ready",
          intent_assessment: {
            recommended_intent: selectedSuggestion.candidate_spec.intent_family,
            confidence: "high",
            reason: "The researcher selected this model-proposed design reference.",
            alternative_intents: [],
            clarification_required: false,
            clarifying_question: null,
          },
        };
        spec = structuredClone(selectedSuggestion.candidate_spec);
      } else {
        const selectedTemplate = current.spec.intent_family === "undetermined"
          ? undefined
          : this.dependencies.templates.forIntent(current.spec.intent_family);
        ({ proposal, spec } = await this.getValidProposalAndSpec(
          request,
          current.spec,
          [...clarificationHistory, clarificationTurn],
          this.templateContext(selectedTemplate),
        ));
      }
      const objectiveIssues = objectivePreservationIssues(current.spec, spec);
      if (objectiveIssues.length) throw new DesignError("DESIGN_PROPOSAL_INVALID", "The proposal dropped previously extracted research objectives.", objectiveIssues);
      spec = withAnalysisObjectiveSummary(spec);
      const revision = current.revision + 1;
      const view = this.buildView(current.id, revision, spec, proposal);
      const { confirmation: currentConfirmation, ...unconfirmedCurrent } = current;
      const session: DesignSession = {
        ...(currentConfirmation ? unconfirmedCurrent : current),
        revision,
        spec,
        phase: view.phase,
        revisions: [...current.revisions, { revision, spec, phase: view.phase }],
        clarification_history: [...clarificationHistory, clarificationTurn],
        clarification_review_history: [
          ...(current.clarification_review_history ?? []),
          ...reviewDecisions,
        ],
        last_proposal: proposal,
        ...(currentConfirmation
          ? {
              confirmation_history: [
                ...(current.confirmation_history ?? []),
                currentConfirmation,
              ],
            }
          : {}),
      };
      const record: ProcessedDesignRequest = {
        operation: "continue",
        request_id: request.client_request_id,
        request_fingerprint: requestFingerprint,
        result: view,
      };
      let saved: boolean;
      try {
        saved = await this.dependencies.sessions.saveRevision(
          session,
          current.revision,
          record,
          claimToken,
        );
      } catch {
        throw new DesignError("DESIGN_STORAGE_FAILURE", "The design session could not be saved.");
      }
      if (!saved) throw new DesignError("DESIGN_REVISION_CONFLICT", "The design has changed. Refresh and try again.");
      return view;
    } finally {
      await this.releaseRequest(request.client_request_id, claimToken);
    }
  }

  async confirm(request: ConfirmDesignRequest): Promise<ConfirmedStudySpec> {
    this.assertValidRequest(this.dependencies.validation.checkConfirmRequest(request));
    const requestFingerprint = createDesignRequestFingerprint("confirm", request);
    const processed = await this.findProcessedRequest(request.client_request_id);
    if (processed) return this.replayConfirmation(processed, requestFingerprint);

    const current = await this.findSession(request.session_id);

    if (current.confirmation) {
      throw new DesignError("DESIGN_REVISION_CONFLICT", "The design revision is already confirmed.");
    }
    if (current.revision !== request.base_revision) {
      throw new DesignError("DESIGN_REVISION_CONFLICT", "The design has changed. Refresh and try again.");
    }
    if (current.phase !== "ready_to_confirm" || !this.dependencies.validation.isConfirmedExecutableStudy(current.spec)) {
      throw new DesignError("DESIGN_NOT_READY", "The design is not ready to confirm.");
    }
    const protocol = assessResearchProtocol(current.spec);
    if (protocol.status !== "complete") {
      throw new DesignError(
        "DESIGN_NOT_READY",
        "The research protocol still has required definitions.",
        protocol.requirements.filter(({ severity }) => severity === "required").map(({ code, field_path }) => `${code}: ${field_path}`),
      );
    }

    const result: ConfirmedStudySpec = {
      schema_version: "1.0.0",
      session_id: current.id,
      revision: current.revision,
      confirmed_at: this.dependencies.now().toISOString(),
      spec: current.spec,
      integrity_id: createConfirmedStudySpecIntegrityId(current.id, current.revision, current.spec),
    };
    const resultErrors = this.dependencies.validation.checkConfirmedStudySpec(result);
    if (resultErrors.length) {
      throw new DesignError("DESIGN_NOT_READY", "The design is not ready to confirm.", resultErrors);
    }

    let saved: boolean;
    try {
      saved = await this.dependencies.sessions.confirm(
        current.id,
        current.revision,
        { result },
        {
          operation: "confirm",
          request_id: request.client_request_id,
          request_fingerprint: requestFingerprint,
          result,
        },
      );
    } catch {
      throw new DesignError("DESIGN_STORAGE_FAILURE", "The design confirmation could not be saved.");
    }
    if (saved) return result;

    const concurrent = await this.findProcessedRequest(request.client_request_id);
    if (concurrent) return this.replayConfirmation(concurrent, requestFingerprint);
    throw new DesignError("DESIGN_REVISION_CONFLICT", "The design has changed. Refresh and try again.");
  }

  async getSession(sessionId: string): Promise<ResearchDesignSessionSnapshot> {
    if (!sessionId || sessionId.length > 128) {
      throw new DesignError("DESIGN_INVALID_INPUT", "The design session identifier is invalid.");
    }
    const session = await this.findSession(sessionId);
    const view = this.buildView(session.id, session.revision, session.spec, session.last_proposal!);
    return {
      ...view,
      ...(session.confirmation ? { confirmed: session.confirmation.result } : {}),
      ...(session.reused_design_review ? { reused_design_review: session.reused_design_review } : {}),
    };
  }

  private assertValidRequest(errors: string[]): void {
    if (errors.length) {
      throw new DesignError("DESIGN_INVALID_INPUT", "The design request is invalid.", errors);
    }
  }

  private async getProposal(
    request: StartDesignRequest | ContinueDesignRequest,
    currentSpec: StudySpec,
    clarificationHistory: ResearchDesignClarificationTurn[] = [],
    templateContext: ResearchDesignTemplateContext = this.templateContext(),
  ): Promise<ResearchDesignProposal> {
    let validationErrors: string[] = [];
    // The structured provider already performs one bounded schema repair. Do not
    // grant a second complete model-pool budget at the service boundary.
    for (let attempt = 1; attempt <= 1; attempt += 1) {
      let rawProposal: unknown;
      try {
        rawProposal = normalizeResearchDesignProposal(await this.dependencies.model.propose({
          request,
          current_spec: currentSpec,
          template_context: templateContext,
          ...(clarificationHistory.length ? { clarification_history: clarificationHistory } : {}),
        }));
      } catch (error) {
        const failureClass = error instanceof ResearchDesignModelError ? error.code : "MODEL_UNAVAILABLE";
        this.notifyProposalValidation({
          json_parse: "not_run",
          schema_validation: "not_run",
          business_validation: "not_run",
          failure_class: failureClass,
        });
        if (error instanceof ResearchDesignModelError) {
          if (error.code === "MODEL_OPENAI_AUTHENTICATION_FAILED") {
            throw new DesignError("DESIGN_MODEL_OPENAI_AUTHENTICATION_FAILED", "The OpenAI fallback model did not authenticate.", [
              `failure_class=${error.code}`,
              ...(error.fallback_model ? [`fallback_model=${error.fallback_model}`] : []),
              ...error.attempts.map((attempt) => `attempt=${attempt.order};provider=${attempt.provider};model=${attempt.model};latency_ms=${attempt.latency_ms};outcome=${attempt.outcome}${attempt.failure_class ? `;failure_class=${attempt.failure_class}` : ""}`),
            ]);
          }
          const code =
            error.code === "MODEL_TIMEOUT"
              ? "DESIGN_MODEL_TIMEOUT"
              : error.code === "MODEL_AUTHENTICATION_FAILED"
                ? "DESIGN_MODEL_AUTHENTICATION_FAILED"
                : error.code === "MODEL_RESPONSE_INVALID"
                  ? "DESIGN_MODEL_RESPONSE_INVALID"
                  : error.code === "MODEL_RATE_LIMITED"
                    ? "DESIGN_MODEL_RATE_LIMITED"
                    : error.code === "MODEL_FALLBACK_AUTHORIZATION_REQUIRED"
                      ? "DESIGN_MODEL_FALLBACK_AUTHORIZATION_REQUIRED"
                      : "DESIGN_MODEL_UNAVAILABLE";
          throw new DesignError(code, "The research design model did not produce a usable response.", [
            `failure_class=${error.code}`,
            ...(error.fallback_model ? [`fallback_model=${error.fallback_model}`] : []),
            ...error.attempts.map((attempt) => `attempt=${attempt.order};provider=${attempt.provider};model=${attempt.model};latency_ms=${attempt.latency_ms};outcome=${attempt.outcome}${attempt.failure_class ? `;failure_class=${attempt.failure_class}` : ""}`),
          ]);
        }
        throw new DesignError("DESIGN_MODEL_UNAVAILABLE", "The research design model is unavailable.", ["failure_class=MODEL_UNAVAILABLE"]);
      }

      validationErrors = this.dependencies.validation.checkProposal(rawProposal);
      if (validationErrors.length === 0) {
        const proposal = rawProposal as ResearchDesignProposal;
        if (!proposal.candidate_spec && proposal.spec_patch.length > this.dependencies.policy.maxPatchOperations) {
          throw new DesignError("DESIGN_LIMIT_EXCEEDED", "The model proposal contains too many changes.");
        }
        return proposal;
      }
    }
    this.notifyProposalValidation({
      json_parse: "pass",
      schema_validation: "fail",
      business_validation: "not_run",
      failure_class: "MODEL_RESPONSE_INVALID",
    });
    throw new DesignError("DESIGN_PROPOSAL_INVALID", "The model proposal is invalid.", validationErrors);
  }

  private async getValidProposalAndSpec(
    request: StartDesignRequest | ContinueDesignRequest,
    currentSpec: StudySpec,
    clarificationHistory: ResearchDesignClarificationTurn[] = [],
    templateContext: ResearchDesignTemplateContext = this.templateContext(),
  ): Promise<{ proposal: ResearchDesignProposal; spec: StudySpec }> {
    const proposal = await this.getProposal(request, currentSpec, clarificationHistory, templateContext);
    try {
      const spec = this.applyProposal(currentSpec, proposal);
      this.notifyProposalValidation({
        json_parse: "pass",
        schema_validation: "pass",
        business_validation: "pass",
      });
      return { proposal, spec };
    } catch (firstError) {
      // Schema-invalid/provider failures are already bounded by getProposal; only
      // retry a structurally valid proposal that cannot be applied to the spec.
      if (firstError instanceof DesignError && firstError.code !== "DESIGN_PROPOSAL_INVALID") throw firstError;
      const feedback = firstError instanceof Error ? firstError.message : "The patch could not be applied.";
      const retryRequest: StartDesignRequest | ContinueDesignRequest = "message" in request
        ? { ...request, message: `${request.message ?? ""}\nBackend validation feedback: ${feedback}. Return a complete, applicable patch using only allowed paths.` }
        : request;
      const retryProposal = await this.getProposal(retryRequest, currentSpec, clarificationHistory, templateContext);
      try {
        const spec = this.applyProposal(currentSpec, retryProposal);
        this.notifyProposalValidation({
          json_parse: "pass",
          schema_validation: "pass",
          business_validation: "pass",
        });
        return { proposal: retryProposal, spec };
      } catch (secondError) {
        this.notifyProposalValidation({
          json_parse: "pass",
          schema_validation: "pass",
          business_validation: "fail",
          failure_class: "MODEL_RESPONSE_INVALID",
        });
        const details = [
          ...(firstError instanceof DesignError ? firstError.details : []),
          ...(secondError instanceof DesignError ? secondError.details : []),
        ];
        throw new DesignError("DESIGN_PROPOSAL_INVALID", "The model proposal could not be applied to the study specification.", details);
      }
    }
  }

  private notifyProposalValidation(
    result: {
      json_parse: "pass" | "fail" | "not_run";
      schema_validation: "pass" | "fail" | "not_run";
      business_validation: "pass" | "fail" | "not_run";
      failure_class?: string;
    },
  ): void {
    this.dependencies.onProposalValidation?.(result);
  }

  private templateContext(selected?: ResearchDesignTemplate): ResearchDesignTemplateContext {
    return {
      ...(selected ? { selected_template_id: selected.template_id } : {}),
      templates: selected ? [selected] : this.dependencies.templates.list(),
    };
  }

  private assertSelectedTemplateMatches(selected: ResearchDesignTemplate | undefined, spec: StudySpec): void {
    if (selected && spec.intent_family !== selected.intent_family) {
      throw new DesignError(
        "DESIGN_PROPOSAL_INVALID",
        "The model proposal does not match the selected research design template.",
      );
    }
  }

  private toClarificationTurn(request: ContinueDesignRequest, previous?: ResearchDesignProposal): ResearchDesignClarificationTurn {
    const answerContext = request.answers
      ? Object.entries(request.answers).map(([questionId, selectedValue]) => {
          const question = previous?.clarifying_questions.find(({ id }) => id === questionId);
          const values = Array.isArray(selectedValue) ? selectedValue : [selectedValue];
          const labels = values.map((value) => question?.options.find((option) => option.value === String(value))?.label ?? String(value));
          return {
            question_id: questionId,
            question: question?.prompt ?? questionId,
            selected_value: selectedValue,
            selected_label: labels.join(", "),
          };
        })
      : [];
    return {
      ...(request.message ? { message: request.message } : {}),
      ...(request.answers ? { answers: structuredClone(request.answers) } : {}),
      ...(request.suggestion_id ? { suggestion_id: request.suggestion_id } : {}),
      ...(answerContext.length ? { answer_context: answerContext } : {}),
    };
  }

  private toReviewableDecisions(request: ContinueDesignRequest, previous?: ResearchDesignProposal): NonNullable<DesignSession["clarification_review_history"]> {
    if (!request.answers) return [];
    return Object.entries(request.answers).map(([questionId, selectedValue]) => {
      const question = previous?.clarifying_questions.find(({ id }) => id === questionId);
      const values = Array.isArray(selectedValue) ? selectedValue : [selectedValue];
      const labels = values.map((value) => question?.options.find((option) => option.value === String(value))?.label ?? String(value));
      return {
        question_id: questionId,
        question: question?.prompt ?? questionId,
        selected_value: selectedValue,
        selected_label: labels.join(", "),
        ...(question ? {
          response_kind: question.response_kind,
          options: question.options.map((option) => structuredClone(option)),
        } : {}),
      };
    });
  }

  private applyProposal(current: StudySpec, proposal: ResearchDesignProposal): StudySpec {
    if (proposal.candidate_spec) {
      const errors = this.dependencies.validation.checkStudySpec(proposal.candidate_spec);
      if (errors.length) throw new DesignError("DESIGN_PROPOSAL_INVALID", "The proposed complete study design is invalid.", errors);
      const protectedFields: Array<keyof StudySpec> = ["research_question","population","index_time","exposure_or_predictors","outcome","outcome_structure","time_windows","effect_modifiers","estimand","analysis_family"];
      const summaryFields = new Set<keyof StudySpec>(["outcome", "outcome_structure", "estimand", "analysis_family"]);
      const lost = protectedFields.filter((field) => !(proposal.candidate_spec!.analysis_objectives && summaryFields.has(field)) && current[field] !== undefined && proposal.candidate_spec![field] === undefined);
      if (lost.length) throw new DesignError("DESIGN_PROPOSAL_INVALID", "The complete candidate dropped previously resolved study fields.", lost.map((field) => `/${field} must be preserved`));
      assertIntentCanChange(
        proposal.intent_assessment.clarification_required,
        current.intent_family === proposal.candidate_spec.intent_family ? [] : ["/intent_family"],
      );
      assertIntentIsConsistent(
        proposal.candidate_spec,
        proposal.intent_assessment.recommended_intent,
        proposal.intent_assessment.clarification_required,
      );
      const objectiveIssues = objectivePreservationIssues(current, proposal.candidate_spec);
      if (objectiveIssues.length) throw new DesignError("DESIGN_PROPOSAL_INVALID", "The proposal dropped the versioned objective contract.", objectiveIssues);
      return withEffectModifierCovariates(withDerivedAnalysisFamily(withAnalysisObjectiveSummary(structuredClone(proposal.candidate_spec))));
    }
    assertIntentCanChange(
      proposal.intent_assessment.clarification_required,
      proposal.spec_patch.map(({ path }) => path),
    );
    const patchedSpec = this.dependencies.patchEngine.apply(current, proposal.spec_patch);
    const spec = alignUnresolvedIntentWithAssessment(
      patchedSpec,
      proposal.intent_assessment.recommended_intent,
      proposal.intent_assessment.clarification_required,
    );
    assertIntentIsConsistent(
      spec,
      proposal.intent_assessment.recommended_intent,
      proposal.intent_assessment.clarification_required,
    );
    const objectiveIssues = objectivePreservationIssues(current, spec);
    if (objectiveIssues.length) throw new DesignError("DESIGN_PROPOSAL_INVALID", "The patch dropped requested research objectives.", objectiveIssues);
    return withEffectModifierCovariates(withDerivedAnalysisFamily(withAnalysisObjectiveSummary(spec)));
  }

  private buildView(
    sessionId: string,
    revision: number,
    spec: StudySpec,
    proposal: ResearchDesignProposal,
  ): ResearchDesignView {
    const protocol = assessResearchProtocol(spec);
    const requiredProtocolItems = proposal.readiness === "candidate_ready"
      ? [
          ...protocol.requirements.filter(({ severity }) => severity === "required"),
          ...(!spec.title?.trim()
            ? [{
                code: "TITLE_REQUIRED",
                field_path: "/title",
                severity: "required" as const,
                question: "What short title should identify this study?",
                reason: "A confirmed and publishable study needs a stable title.",
              }]
            : []),
        ]
      : [];
    const effectiveProposal: ResearchDesignProposal = {
      ...proposal,
      clarifying_questions: [
        ...proposal.clarifying_questions,
        ...requiredProtocolItems
          .filter(({ code }) => !proposal.clarifying_questions.some(({ id }) => id === `protocol-${code.toLowerCase()}`))
          .map((requirement) => ({
            id: `protocol-${requirement.code.toLowerCase()}`,
            prompt: requirement.question,
            reason: requirement.reason,
            required: true as const,
            response_kind: "text" as const,
            options: [],
          })),
      ],
      warnings: [
        ...proposal.warnings,
        ...protocol.requirements
          .filter(({ severity }) => severity === "recommended")
          .filter(({ code }) => !proposal.warnings.some((warning) => warning.code === code))
          .map((requirement) => ({ code: requirement.code, message: requirement.reason, field_path: requirement.field_path })),
      ],
    };
    const state = decideDesignState(
      proposal.intent_assessment.clarification_required || requiredProtocolItems.length > 0,
      proposal.readiness === "candidate_ready",
      this.dependencies.validation.isConfirmedExecutableStudy(spec),
    );
    return toResearchDesignView(
      sessionId,
      revision,
      spec,
      effectiveProposal,
      state.phase,
      state.allowedActions,
    );
  }

  private async findSession(id: string): Promise<DesignSession> {
    let session: DesignSession | undefined;
    try {
      session = await this.dependencies.sessions.findById(id);
    } catch {
      throw new DesignError("DESIGN_STORAGE_FAILURE", "The design session could not be loaded.");
    }
    if (!session) throw new DesignError("DESIGN_SESSION_NOT_FOUND", "The design session was not found.");
    return session;
  }

  private async findProcessedRequest(requestId: string): Promise<ProcessedDesignRequest | undefined> {
    try {
      return await this.dependencies.sessions.findProcessedRequest(requestId);
    } catch {
      throw new DesignError("DESIGN_STORAGE_FAILURE", "The processed design request could not be loaded.");
    }
  }

  private async claimModelRequest(
    operation: "start" | "continue",
    requestId: string,
    requestFingerprint: string,
  ): Promise<string> {
    const claimToken = randomUUID();
    let status: "acquired" | "pending" | "conflict";
    try {
      status = await this.dependencies.sessions.claimRequest({
        request_id: requestId,
        operation,
        request_fingerprint: requestFingerprint,
        claim_token: claimToken,
        expires_at: new Date(Date.now() + this.dependencies.requestClaimTtlMs).toISOString(),
      });
    } catch {
      throw new DesignError("DESIGN_STORAGE_FAILURE", "The design request could not be claimed.");
    }
    if (status === "conflict") {
      throw new DesignError(
        "DESIGN_IDEMPOTENCY_CONFLICT",
        "The request identifier is already in use for another design operation.",
      );
    }
    if (status === "pending") {
      throw new DesignError("DESIGN_REQUEST_IN_PROGRESS", "The design request is already in progress.");
    }
    return claimToken;
  }

  private async releaseRequest(requestId: string, claimToken: string): Promise<void> {
    try {
      await this.dependencies.sessions.releaseRequest(requestId, claimToken);
    } catch {
      // The claim expires and can be recovered even if best-effort release fails.
    }
  }

  private assertRequestWithinPolicy(request: StartDesignRequest | ContinueDesignRequest): void {
    const textLength = "session_id" in request
      ? (request.message?.length ?? 0)
      : request.message.length + (request.context?.length ?? 0);
    if (textLength > this.dependencies.policy.maxRequestChars) {
      throw new DesignError("DESIGN_LIMIT_EXCEEDED", "The design request is too large.");
    }
    if ("answers" in request && Object.keys(request.answers ?? {}).length > this.dependencies.policy.maxAnswers) {
      throw new DesignError("DESIGN_LIMIT_EXCEEDED", "The design request contains too many answers.");
    }
    if (!this.dependencies.policy.supportedStudySpecVersions.includes("1.0.0")) {
      throw new DesignError("DESIGN_INVALID_INPUT", "The StudySpec schema version is not supported.");
    }
  }

  private replayView(
    request: ProcessedDesignRequest,
    operation: "start" | "continue",
    requestFingerprint: string,
  ): ResearchDesignView {
    if (request.operation !== operation || request.request_fingerprint !== requestFingerprint) {
      throw new DesignError(
        "DESIGN_IDEMPOTENCY_CONFLICT",
        "The request identifier was already used for a different design operation.",
      );
    }
    return request.result;
  }

  private replayConfirmation(
    request: ProcessedDesignRequest,
    requestFingerprint: string,
  ): ConfirmedStudySpec {
    if (request.operation !== "confirm" || request.request_fingerprint !== requestFingerprint) {
      throw new DesignError(
        "DESIGN_IDEMPOTENCY_CONFLICT",
        "The request identifier was already used for a different design operation.",
      );
    }
    return request.result;
  }
}
