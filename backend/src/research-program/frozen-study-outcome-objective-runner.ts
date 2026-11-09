import type { DynamicLocalRunBundle } from "../clinical-data/index.js";
import { MultiObjectiveReportService, type MultiObjectiveReportBundle, type ObjectivePreExecutionBlock, type ObjectiveTerminalInput } from "../multi-objective-report/index.js";
import { assessAnalysisObjectiveContract, createConfirmedStudySpecIntegrityId, projectAnalysisObjective, type ConfirmedStudySpec, type StudySpec } from "../research-design/index.js";
import type { ObjectiveCoverageReview, ResearchObjectiveList } from "../research-objectives/index.js";
import type { StudyVariableMappingReview } from "../variable-mapping/index.js";

export interface FrozenStudyOutcomeObjectiveResult {
  objective_list: ResearchObjectiveList;
  coverage_review: ObjectiveCoverageReview;
  terminal_results: ObjectiveTerminalInput[];
  report: MultiObjectiveReportBundle;
}

/** Kept as an API alias; only an explicit versioned objective list selects this runner. */
export const hasCompoundOutcomeObjectives = (spec: StudySpec): boolean => Boolean(spec.analysis_objectives);

export const projectConfirmedAnalysisObjective = (confirmed: ConfirmedStudySpec, objectiveId: string): ConfirmedStudySpec => {
  const objective = confirmed.spec.analysis_objectives?.objectives.find(({ objective_id }) => objective_id === objectiveId);
  if (!objective) throw new Error("An explicit analysis objective is required.");
  const spec = projectAnalysisObjective(confirmed.spec, objective);
  const sessionId = `${confirmed.session_id}:${objectiveId}`;
  return { schema_version: "1.0.0", session_id: sessionId, revision: confirmed.revision, confirmed_at: confirmed.confirmed_at,
    integrity_id: createConfirmedStudySpecIntegrityId(sessionId, confirmed.revision, spec), spec };
};

/** Fixed independent target execution; all/any remains one composite event within a target. */
export class FrozenStudyOutcomeObjectiveRunner {
  constructor(private readonly dependencies: {
    mappings: { assess(spec: StudySpec, allowLiveSearch?: boolean): Promise<StudyVariableMappingReview> };
    local_runs: { execute(study: ConfirmedStudySpec): Promise<DynamicLocalRunBundle> };
    reports?: MultiObjectiveReportService;
    now: () => Date;
  }) {}

  async run(confirmed: ConfirmedStudySpec): Promise<FrozenStudyOutcomeObjectiveResult> {
    const program = confirmed.spec.analysis_objectives;
    if (!program || assessAnalysisObjectiveContract(confirmed.spec).length) throw new Error("A complete explicit objective contract is required; Boolean condition leaves cannot stand in for independent objectives.");
    const intent = confirmed.spec.intent_family;
    if (intent === "undetermined") throw new Error("Research purpose must be confirmed before objective execution.");
    const objectiveList: ResearchObjectiveList = { schema_version: "1.0.0", original_question: program.original_question, ambiguities: [],
      objectives: program.objectives.map((objective) => ({
        objective_id: objective.objective_id, purpose: intent, relationship: "primary",
        question: program.requested.find(({ objective_id }) => objective_id === objective.objective_id)!.source_text,
        population: confirmed.spec.population?.description ?? "Confirmed population",
        exposure_or_predictors: (confirmed.spec.exposure_or_predictors ?? []).map(({ name }) => name),
        comparator: objective.estimand.exposure_contrast, outcome: objective.outcome.name,
        effect_modifiers: (confirmed.spec.effect_modifiers ?? []).map(({ variable_name }) => variable_name),
        source_claims: [program.requested.find(({ objective_id }) => objective_id === objective.objective_id)!.source_text],
      })) };
    const coverage: ObjectiveCoverageReview = { schema_version: "1.0.0", decision: "pass", covered_claims: program.requested.map(({ source_text }) => source_text),
      missing_claims: [], altered_claims: [], unsupported_additions: [],
      explanation: "Structural coverage of the frozen model-extracted objective inventory only; this is not an independent semantic or clinical review of the original question." };
    const terminalResults: ObjectiveTerminalInput[] = [];
    for (const objective of program.objectives) {
      if (objective.status === "blocked") {
        terminalResults.push({ objective_id: objective.objective_id, result: { status: "blocked", stage: "data", code: "OBJECTIVE_DECLARED_UNSUPPORTED", message: objective.blocking_reason! } });
        continue;
      }
      try {
        terminalResults.push({ objective_id: objective.objective_id, result: await this.dependencies.local_runs.execute(projectConfirmedAnalysisObjective(confirmed, objective.objective_id)) });
      } catch {
        const blocker: ObjectivePreExecutionBlock = { status: "blocked", stage: "data", code: "OBJECTIVE_EXECUTION_FAILED", message: "The objective did not reach a terminal local-data artifact. Other objectives continue independently." };
        terminalResults.push({ objective_id: objective.objective_id, result: blocker });
      }
    }
    const report = (this.dependencies.reports ?? new MultiObjectiveReportService(this.dependencies.now)).create({ objective_list: objectiveList, coverage_review: coverage, terminal_results: terminalResults });
    return { objective_list: objectiveList, coverage_review: coverage, terminal_results: terminalResults, report };
  }
}
