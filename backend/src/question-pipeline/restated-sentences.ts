import { restateAssumptions } from "../study-framing/index.js";
import type { QuestionPlanDraft } from "./question-plan.js";
import type { QuestionRunResult } from "./question-pipeline-service.js";

/**
 * A saved draft or run as it is shown: every plan's sentences state the windows the plan runs with, also for one written by
 * an earlier compiler (study-framing restateAssumptions), so the page says what the report says.
 */
export const restateDraft = (draft: QuestionPlanDraft): QuestionPlanDraft => ({ ...draft, plans: draft.plans.map((item) => ({ ...item, plan: { ...item.plan, study_spec: restateAssumptions(item.plan.study_spec) } })) });
export const restateRun = (result: QuestionRunResult): QuestionRunResult => ({ ...result, plans: result.plans.map((plan) => plan.study_spec ? { ...plan, study_spec: restateAssumptions(plan.study_spec) } : plan) });
