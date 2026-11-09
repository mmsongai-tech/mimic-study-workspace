export { applyGrouping, applyRatioExposure, executePlan, manifestNotModelled, methodConfigFor, plannedNotModelled, preparePlan, profileDataset, runPreparedPlan, withNotModelled } from "./plan-execution.js";
export { lockIsIntact, lockQuestionPlan, PlanLockError, resolvedOptions } from "./question-plan.js";
export type { DesignOptions, DraftPlan, LockedQuestionPlan, PlanChoices, PlanOptionChoice, QuestionPlanDraft } from "./question-plan.js";
export type { CovariateNotModelled, MappingSummaryVariable, PipelineBlocker, PipelineStage, PlanExecutionDependencies, PlanOutcome, PreparedPlan } from "./plan-execution.js";
export { familyPValue, notReliablyEstimable, planHeadline } from "./headline.js";
export type { PlanHeadline } from "./headline.js";
export { QuestionPipelineService } from "./question-pipeline-service.js";
export type { FrameAssessor, OutcomeComponentAssessor, QuestionPipelineDependencies, QuestionRunResult } from "./question-pipeline-service.js";
export { restateDraft, restateRun } from "./restated-sentences.js";
