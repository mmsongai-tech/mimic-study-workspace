import type { ResearchDesignModel } from "./research-design-model.js";
import { ValidatedStudySpecPatchEngine } from "./study-spec-patch-engine.js";
import type { DesignSessionRepository } from "./design-session-repository.js";
import { InMemoryDesignSessionRepository } from "./in-memory-design-session-repository.js";
import { SqliteDesignSessionRepository } from "./sqlite-design-session-repository.js";
import { JsonSchemaResearchDesignValidator } from "./schema-validator.js";
import { ResearchDesignService } from "./research-design-service.js";
import type { ResearchDesignPolicy, ResearchDesignServiceDependencies } from "./research-design-service.js";
import { createResearchDesignTemplateRegistry } from "./research-design-template.js";

export const createResearchDesignService = (
  model: ResearchDesignModel,
  sessions: DesignSessionRepository,
  options: {
    now?: () => Date;
    requestClaimTtlMs?: number;
    policy?: Partial<ResearchDesignPolicy>;
    onProposalValidation?: ResearchDesignServiceDependencies["onProposalValidation"];
  } = {},
): ResearchDesignService => {
  const validation = new JsonSchemaResearchDesignValidator();
  return new ResearchDesignService({
    model,
    sessions,
    validation,
    patchEngine: new ValidatedStudySpecPatchEngine(validation),
    templates: createResearchDesignTemplateRegistry(),
    now: options.now ?? (() => new Date()),
    requestClaimTtlMs: options.requestClaimTtlMs ?? 30_000,
    policy: {
      maxRequestChars: options.policy?.maxRequestChars ?? 12_000,
      maxAnswers: options.policy?.maxAnswers ?? 50,
      maxPatchOperations: options.policy?.maxPatchOperations ?? 100,
      maxRevisions: options.policy?.maxRevisions ?? 100,
      supportedStudySpecVersions: options.policy?.supportedStudySpecVersions ?? ["1.0.0"],
    },
    ...(options.onProposalValidation ? { onProposalValidation: options.onProposalValidation } : {}),
  });
};

export const createInMemoryDesignSessionRepository = (): DesignSessionRepository =>
  new InMemoryDesignSessionRepository();

export const createSqliteDesignSessionRepository = (
  filename: string,
): SqliteDesignSessionRepository => new SqliteDesignSessionRepository(filename);

export const validateResearchDesignProposal = (value: unknown): string[] =>
  new JsonSchemaResearchDesignValidator().checkProposal(value);

export { normalizeResearchDesignProposal } from "./research-design-service.js";

export { DesignError } from "./design-error.js";
export { assessResearchProtocol } from "./research-protocol-assessment.js";
export { JsonSchemaResearchDesignValidator } from "./schema-validator.js";
export { createManifestDraft, decomposeStudy, freezeConfirmedManifest } from "./research-definition.js";
export type { ProblemDecomposition, ConfirmedManifest, FrozenManifestField, ManifestCandidate, ManifestDraft, ManifestDraftField } from "./research-definition.js";
export { createConfirmedStudySpecIntegrityId } from "./confirmed-study-spec-integrity.js";
export { ResearchDesignModelError } from "./research-design-model.js";
export { createResearchDesignTemplateRegistry, RegisteredResearchDesignTemplateRegistry } from "./research-design-template.js";
export type { ResearchDesignTemplate, ResearchDesignTemplateContext, ResearchDesignTemplateRegistry } from "./research-design-template.js";
export type { ResearchDesignModel, ResearchDesignModelFailureCode } from "./research-design-model.js";
export type { AnalysisObjectiveDefinition, AnalysisObjectiveSet, EffectModifierDefinition, MeasurementDifferenceDefinition, OutcomeStructure, RequestedAnalysisObjective, ResearchIntent, StudyCondition, StudySpec, StudyVariable, TimeWindow } from "./study-spec.js";
export { listStudyConditions, validateStudyCondition } from "./study-condition.js";
export { followUpEnd, MINIMUM_FOLLOW_UP_HOURS, restateWindows } from "./study-spec.js";
export type { StudyConditionIssue } from "./study-condition.js";
export type { ProtocolRequirement, ResearchProtocolAssessment } from "./research-protocol-assessment.js";
export type { ConfirmDesignRequest, ContinueDesignRequest, StartDesignRequest } from "./requests.js";
export type {
  ConfirmedStudySpec,
  ResearchDesignSessionSnapshot,
  ResearchDesignView,
} from "./responses.js";
export * from "./analysis-objectives.js";
