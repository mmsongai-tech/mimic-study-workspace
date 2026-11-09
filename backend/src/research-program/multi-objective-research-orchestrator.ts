import { createHash } from "node:crypto";
import { createConfirmedStudySpecIntegrityId, type ConfirmedStudySpec, type StudySpec } from "../research-design/index.js";
import type { DynamicLocalRunBundle } from "../clinical-data/index.js";
import { MultiObjectiveReportService, type MultiObjectiveReportBundle, type ObjectivePreExecutionBlock, type ObjectiveTerminalInput } from "../multi-objective-report/index.js";
import { objectiveListCanProceed, type ModelAuditRecord, type ObjectiveCoverageReview, type ObjectiveStudySpecAuditRecord, type ResearchObjective, type ResearchObjectiveList } from "../research-objectives/index.js";

export interface ObjectiveInterpretationResult {
  objective_list: ResearchObjectiveList;
  coverage: ObjectiveCoverageReview;
  audit: ModelAuditRecord[];
}

export interface ObjectiveCompilationResult {
  objective_id: string;
  study_spec: StudySpec;
  audit: ObjectiveStudySpecAuditRecord[];
}

export interface ObjectiveProgramTrace {
  objective_id: string;
  // The objective's own question text, verbatim from whatever the model extracted for THIS run —
  // never a fixed label. Lets a reviewer read a blocked objective without re-fetching the list.
  question: string;
  status: "completed" | "blocked";
  compilation_audit: ObjectiveStudySpecAuditRecord[];
  // Present whenever compilation succeeded, even if execution later blocked (e.g. at
  // mapping review) — a reviewer needs the compiled spec to act on that block.
  study_spec?: StudySpec;
  study_spec_integrity_id?: string;
  manifest_integrity_id?: string;
  method_integrity_id?: string;
  run_id?: string;
  blocker?: ObjectivePreExecutionBlock;
}

/** Coarse run-level progress for a persisted job's status display; never a per-objective breakdown. */
export type MultiObjectiveRunPhase = "objective_extraction" | "compiling_and_executing_objectives" | "finalizing";

export interface MultiObjectiveResearchProgramResult {
  objective_list: ResearchObjectiveList;
  coverage_review: ObjectiveCoverageReview;
  interpretation_audit: ModelAuditRecord[];
  objective_traces: ObjectiveProgramTrace[];
  report: MultiObjectiveReportBundle;
}

/** Coordinates independently terminal objective paths; it owns no model, mapping, or statistical rules. */
export class MultiObjectiveResearchOrchestrator {
  constructor(private readonly dependencies: {
    objectives: { analyze(originalQuestion: string): Promise<ObjectiveInterpretationResult> };
    compiler: { compile(input: { objective: ResearchObjective; shared_context?: Record<string, unknown> }): Promise<ObjectiveCompilationResult> };
    local_runs: { execute(study: ConfirmedStudySpec): Promise<DynamicLocalRunBundle> };
    shared_context?: Record<string, unknown>;
    reports?: MultiObjectiveReportService;
    now: () => Date;
    onPhase?: (phase: MultiObjectiveRunPhase) => void;
  }) {}

  async run(originalQuestion: string): Promise<MultiObjectiveResearchProgramResult> {
    this.dependencies.onPhase?.("objective_extraction");
    const interpretation = await this.dependencies.objectives.analyze(originalQuestion);
    this.dependencies.onPhase?.("compiling_and_executing_objectives");
    const terminalResults: ObjectiveTerminalInput[] = [];
    const objectiveTraces: ObjectiveProgramTrace[] = [];
    if (!objectiveListCanProceed(interpretation.objective_list, interpretation.coverage)) {
      for (const objective of interpretation.objective_list.objectives) {
        const blocker: ObjectivePreExecutionBlock = { status: "blocked", stage: "objective_interpretation", code: "OBJECTIVE_COVERAGE_REVIEW_REQUIRED", message: "The independently reviewed objective list is not approved for execution." };
        terminalResults.push({ objective_id: objective.objective_id, result: blocker });
        objectiveTraces.push({ objective_id: objective.objective_id, question: objective.question, status: "blocked", compilation_audit: [], blocker });
      }
    } else {
      const pending = new Map(interpretation.objective_list.objectives.map((objective) => [objective.objective_id, objective]));
      while (pending.size) {
        const terminalIds = new Set(terminalResults.map(({ objective_id }) => objective_id));
        const wave = [...pending.values()].filter((objective) => (objective.depends_on_objective_ids ?? []).every((id) => terminalIds.has(id)));
        if (!wave.length) throw new Error("Objective dependency graph did not produce an executable wave.");
        await Promise.all(wave.map(async (objective) => {
          const blockedDependency = (objective.depends_on_objective_ids ?? []).find((dependencyId) => objectiveTraces.find(({ objective_id }) => objective_id === dependencyId)?.status === "blocked");
          if (blockedDependency) {
            const blocker: ObjectivePreExecutionBlock = { status: "blocked", stage: "objective_interpretation", code: "OBJECTIVE_DEPENDENCY_BLOCKED", message: `Required objective ${blockedDependency} did not complete.` };
            terminalResults.push({ objective_id: objective.objective_id, result: blocker });
            objectiveTraces.push({ objective_id: objective.objective_id, question: objective.question, status: "blocked", compilation_audit: [], blocker });
          } else await this.runObjective(objective, terminalResults, objectiveTraces);
          pending.delete(objective.objective_id);
        }));
      }
    }
    objectiveTraces.sort((left, right) => interpretation.objective_list.objectives.findIndex(({ objective_id }) => objective_id === left.objective_id) - interpretation.objective_list.objectives.findIndex(({ objective_id }) => objective_id === right.objective_id));
    this.dependencies.onPhase?.("finalizing");
    const report = (this.dependencies.reports ?? new MultiObjectiveReportService(this.dependencies.now)).create({ objective_list: interpretation.objective_list, coverage_review: interpretation.coverage, terminal_results: terminalResults });
    return { objective_list: interpretation.objective_list, coverage_review: interpretation.coverage, interpretation_audit: interpretation.audit, objective_traces: objectiveTraces, report };
  }

  private async runObjective(objective: ResearchObjective, terminalResults: ObjectiveTerminalInput[], traces: ObjectiveProgramTrace[]): Promise<void> {
    let audit: ObjectiveStudySpecAuditRecord[] = [];
    try {
      const compilation = await this.dependencies.compiler.compile({ objective, shared_context: { ...this.dependencies.shared_context, objective_relationship: objective.relationship } });
      audit = compilation.audit;
      const sessionId = `objective:${objective.objective_id}`; const revision = 1;
      const study: ConfirmedStudySpec = { schema_version: "1.0.0", session_id: sessionId, revision, confirmed_at: this.dependencies.now().toISOString(), integrity_id: createConfirmedStudySpecIntegrityId(sessionId, revision, compilation.study_spec), spec: compilation.study_spec };
      const result = await this.dependencies.local_runs.execute(study);
      terminalResults.push({ objective_id: objective.objective_id, result });
      traces.push({ objective_id: objective.objective_id, question: objective.question, status: result.artifact.status, compilation_audit: audit, study_spec: compilation.study_spec, study_spec_integrity_id: study.integrity_id, manifest_integrity_id: result.artifact.manifest.manifest_id, ...(result.artifact.analysis?.method ? { method_integrity_id: `sha256:${createHash("sha256").update(result.artifact.analysis.method).digest("hex")}` } : {}), run_id: result.artifact.run_id, ...(result.artifact.status === "blocked" && result.artifact.blockers[0] ? { blocker: { status: "blocked", ...result.artifact.blockers[0] } } : {}) });
    } catch (error) {
      const attachedAudit = error && typeof error === "object" && "audit" in error ? (error as { audit?: ObjectiveStudySpecAuditRecord }).audit : undefined;
      if (attachedAudit) audit = [attachedAudit];
      const compilationFailure = Boolean(attachedAudit);
      const blocker: ObjectivePreExecutionBlock = { status: "blocked", stage: compilationFailure ? "research_design" : "data", code: compilationFailure ? attachedAudit?.failure_class ?? "STUDY_SPEC_COMPILATION_FAILED" : "OBJECTIVE_EXECUTION_FAILED", message: compilationFailure ? "The objective could not be compiled into a valid complete StudySpec." : "The objective execution path did not reach a terminal local-data artifact." };
      terminalResults.push({ objective_id: objective.objective_id, result: blocker });
      traces.push({ objective_id: objective.objective_id, question: objective.question, status: "blocked", compilation_audit: audit, blocker });
    }
  }
}
