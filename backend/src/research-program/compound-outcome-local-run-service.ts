import type { AnalysisPlan } from "../analysis-planning/index.js";
import type { DynamicLocalRunBundle } from "../clinical-data/index.js";
import type { MultiObjectiveReportBundle, SqliteMultiObjectiveReportRepository } from "../multi-objective-report/index.js";
import type { ConfirmedStudySpec } from "../research-design/index.js";
import type { StudyVariableMappingService } from "../variable-mapping/index.js";
import { FrozenStudyOutcomeObjectiveRunner, hasCompoundOutcomeObjectives, projectConfirmedAnalysisObjective } from "./frozen-study-outcome-objective-runner.js";

export type BrowserLocalRunBundle = DynamicLocalRunBundle | MultiObjectiveReportBundle;

/** Adds objective-level execution for compound confirmed outcomes without changing single-outcome execution. */
export class CompoundOutcomeLocalRunService {
  private readonly runner: FrozenStudyOutcomeObjectiveRunner;

  constructor(private readonly dependencies: {
    local_runs: {
      createAnalysisPlan(study: ConfirmedStudySpec): Promise<AnalysisPlan>;
      execute(study: ConfirmedStudySpec): Promise<DynamicLocalRunBundle>;
      getRun(runId: string): Promise<DynamicLocalRunBundle | undefined>;
    };
    mappings: Pick<StudyVariableMappingService, "assess">;
    reports: Pick<SqliteMultiObjectiveReportRepository, "save" | "findByReportId">;
    now: () => Date;
  }) {
    this.runner = new FrozenStudyOutcomeObjectiveRunner({
      mappings: dependencies.mappings,
      local_runs: dependencies.local_runs,
      now: dependencies.now,
    });
  }

  async createAnalysisPlan(study: ConfirmedStudySpec): Promise<AnalysisPlan> {
    if (!study.spec.analysis_objectives) return this.dependencies.local_runs.createAnalysisPlan(study);
    const objectives = study.spec.analysis_objectives.objectives;
    const plans: Array<{ objective_id: string; plan: AnalysisPlan }> = [];
    for (const objective of objectives) {
      if (objective.status === "blocked") continue;
      plans.push({ objective_id: objective.objective_id, plan: await this.dependencies.local_runs.createAnalysisPlan(projectConfirmedAnalysisObjective(study, objective.objective_id)) });
    }
    const selected = plans.find(({ plan }) => plan.status === "ready_for_confirmation") ?? plans[0];
    const base = selected?.plan ?? await this.dependencies.local_runs.createAnalysisPlan(study);
    return { ...base, study_spec: study.spec,
      ...(!selected ? { status: "blocked" as const, execution_mode: "none" as const, blocking_requirements: ["Every independent objective is currently blocked."] } : {}),
      warnings: [...base.warnings, "Each explicit objective has its own eligibility and execution status; a blocked objective does not remove the others."],
      objective_plans: objectives.map((objective) => {
        const plan = plans.find(({ objective_id }) => objective_id === objective.objective_id)?.plan;
        return { objective_id: objective.objective_id, outcome: objective.outcome.name, status: plan?.status ?? "blocked",
          ...(plan ? { method: plan.method } : {}), blocking_requirements: plan?.blocking_requirements ?? [objective.blocking_reason ?? "Objective is blocked."] };
      }),
    };
  }

  async execute(study: ConfirmedStudySpec): Promise<BrowserLocalRunBundle> {
    if (!hasCompoundOutcomeObjectives(study.spec)) return this.dependencies.local_runs.execute(study);
    const bundle = (await this.runner.run(study)).report;
    if (!await this.dependencies.reports.save(bundle)) {
      const existing = await this.dependencies.reports.findByReportId(bundle.artifact.report_id);
      if (existing?.artifact.reproducibility_id === bundle.artifact.reproducibility_id) return existing;
      throw new Error("The multi-objective report artifact could not be saved.");
    }
    return bundle;
  }

  async getRun(id: string): Promise<BrowserLocalRunBundle | undefined> {
    return await this.dependencies.reports.findByReportId(id) ?? await this.dependencies.local_runs.getRun(id);
  }
}
