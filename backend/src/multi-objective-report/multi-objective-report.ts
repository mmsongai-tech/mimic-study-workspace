import { createHash } from "node:crypto";
import type { DynamicLocalRunBundle, DynamicRunBlocker } from "../clinical-data/index.js";
import type {
  ObjectiveCoverageReview,
  ResearchObjective,
  ResearchObjectiveList,
} from "../research-objectives/index.js";

export interface ObjectivePreExecutionBlock {
  status: "blocked";
  stage: "objective_interpretation" | DynamicRunBlocker["stage"];
  code: string;
  message: string;
}

export interface ObjectiveTerminalInput {
  objective_id: string;
  result: DynamicLocalRunBundle | ObjectivePreExecutionBlock;
}

export interface ObjectiveReportProjection {
  objective_id: string;
  relationship: ResearchObjective["relationship"];
  question: string;
  status: "completed" | "blocked";
  evidence_level: "local_mimic_archive_execution" | "pre_execution_block";
  diagnostic_decision: "reportable" | "reportable_with_warnings" | "blocked";
  run_id?: string;
  run_reproducibility_id?: string;
  run_integrity_id?: string;
  cohort?: DynamicLocalRunBundle["artifact"]["cohort"];
  analysis?: DynamicLocalRunBundle["artifact"]["analysis"];
  blockers: Array<{ stage: string; code: string; message: string }>;
  warnings: string[];
}

export interface MultiObjectiveReportArtifact {
  schema_version: "1.0.0";
  report_id: string;
  created_at: string;
  status: "completed" | "partial" | "blocked";
  original_question: string;
  coverage_decision: ObjectiveCoverageReview["decision"];
  objective_counts: { total: number; completed: number; blocked: number };
  objectives: ObjectiveReportProjection[];
  reproducibility_id: string;
  integrity_id: string;
}

export interface MultiObjectiveReportBundle {
  artifact: MultiObjectiveReportArtifact;
  report_markdown: string;
}

export class MultiObjectiveReportError extends Error {
  constructor(public readonly code: "OBJECTIVE_RESULT_MISMATCH" | "OBJECTIVE_RESULTS_INCOMPLETE", message: string) {
    super(message);
    this.name = "MultiObjectiveReportError";
  }
}

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]))
    : value;

const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;

/** Combines terminal objective outcomes without recomputing or upgrading their evidence. */
export class MultiObjectiveReportService {
  constructor(private readonly now: () => Date) {}

  create(input: {
    objective_list: ResearchObjectiveList;
    coverage_review: ObjectiveCoverageReview;
    terminal_results: ObjectiveTerminalInput[];
  }): MultiObjectiveReportBundle {
    const expectedIds = input.objective_list.objectives.map(({ objective_id }) => objective_id);
    const suppliedIds = input.terminal_results.map(({ objective_id }) => objective_id);
    if (new Set(suppliedIds).size !== suppliedIds.length || suppliedIds.some((id) => !expectedIds.includes(id))) {
      throw new MultiObjectiveReportError("OBJECTIVE_RESULT_MISMATCH", "Terminal results must reference unique objectives from the reviewed objective list.");
    }
    const missingIds = expectedIds.filter((id) => !suppliedIds.includes(id));
    if (missingIds.length) {
      throw new MultiObjectiveReportError("OBJECTIVE_RESULTS_INCOMPLETE", `Every objective requires a completed or explicitly blocked terminal result: ${missingIds.join(", ")}`);
    }

    const resultById = new Map(input.terminal_results.map((entry) => [entry.objective_id, entry.result]));
    const objectives = input.objective_list.objectives.map((objective): ObjectiveReportProjection => {
      const result = resultById.get(objective.objective_id)!;
      if ("artifact" in result) {
        return {
          objective_id: objective.objective_id,
          relationship: objective.relationship,
          question: objective.question,
          status: result.artifact.status,
          evidence_level: result.artifact.evidence_level,
          diagnostic_decision: result.artifact.diagnostic_decision,
          run_id: result.artifact.run_id,
          run_reproducibility_id: result.artifact.reproducibility_id,
          run_integrity_id: result.artifact.integrity_id,
          ...(result.artifact.cohort ? { cohort: result.artifact.cohort } : {}),
          ...(result.artifact.analysis ? { analysis: result.artifact.analysis } : {}),
          blockers: result.artifact.blockers,
          warnings: result.artifact.warnings,
        };
      }
      return {
        objective_id: objective.objective_id,
        relationship: objective.relationship,
        question: objective.question,
        status: "blocked",
        evidence_level: "pre_execution_block",
        diagnostic_decision: "blocked",
        blockers: [{ stage: result.stage, code: result.code, message: result.message }],
        warnings: [],
      };
    });
    const completed = objectives.filter(({ status }) => status === "completed").length;
    const counts = { total: objectives.length, completed, blocked: objectives.length - completed };
    const status = completed === objectives.length ? "completed" as const : completed > 0 ? "partial" as const : "blocked" as const;
    const stableObjectives = objectives.map(({ run_integrity_id: _runIntegrityId, ...objective }) => objective);
    const stable = {
      schema_version: "1.0.0" as const,
      status,
      original_question: input.objective_list.original_question,
      coverage_decision: input.coverage_review.decision,
      objective_counts: counts,
      objectives: stableObjectives,
    };
    const reproducibility_id = digest(stable);
    const base = {
      ...stable,
      objectives,
      report_id: `report:${reproducibility_id.slice(7, 27)}`,
      created_at: this.now().toISOString(),
      reproducibility_id,
    };
    const artifact = { ...base, integrity_id: digest(base) };
    return { artifact, report_markdown: this.render(artifact) };
  }

  private render(artifact: MultiObjectiveReportArtifact): string {
    const chinese = /\p{Script=Han}/u.test(artifact.original_question);
    const lines = chinese
      ? ["# 多目标 MIMIC-IV 研究报告", "", `原始研究构想：${artifact.original_question}`, `总体状态：${artifact.status}`, `目标覆盖复核：${artifact.coverage_decision}`, `目标统计：共 ${artifact.objective_counts.total} 项，完成 ${artifact.objective_counts.completed} 项，阻断 ${artifact.objective_counts.blocked} 项`, ""]
      : ["# Multi-objective MIMIC-IV research report", "", `Original research idea: ${artifact.original_question}`, `Overall status: ${artifact.status}`, `Coverage review: ${artifact.coverage_decision}`, `Objectives: ${artifact.objective_counts.total} total, ${artifact.objective_counts.completed} completed, ${artifact.objective_counts.blocked} blocked`, ""];
    for (const objective of artifact.objectives) {
      lines.push(`## ${objective.objective_id}: ${objective.question}`, "", chinese ? `关系：${objective.relationship}` : `Relationship: ${objective.relationship}`, chinese ? `状态：${objective.status}` : `Status: ${objective.status}`, chinese ? `证据：${objective.evidence_level}` : `Evidence: ${objective.evidence_level}`, chinese ? `诊断结论：${objective.diagnostic_decision}` : `Diagnostic decision: ${objective.diagnostic_decision}`);
      if (objective.run_id) lines.push(chinese ? `运行标识：${objective.run_id}` : `Run: ${objective.run_id}`);
      if (objective.cohort) lines.push(chinese ? `队列核算：${JSON.stringify(objective.cohort)}` : `Cohort accounting: ${JSON.stringify(objective.cohort)}`);
      if (objective.analysis) {
        lines.push(
          chinese ? `统计方法：${objective.analysis.method}` : `Statistical method: ${objective.analysis.method}`,
          chinese ? `统计估计：${JSON.stringify(objective.analysis.estimates)}` : `Statistical estimates: ${JSON.stringify(objective.analysis.estimates)}`,
          chinese ? `诊断：${JSON.stringify(objective.analysis.diagnostics)}` : `Diagnostics: ${JSON.stringify(objective.analysis.diagnostics)}`,
          chinese ? `敏感性分析：${JSON.stringify(objective.analysis.sensitivity)}` : `Sensitivity analysis: ${JSON.stringify(objective.analysis.sensitivity)}`,
        );
        for (const table of objective.analysis.publication_outputs.tables) lines.push(`### ${table.title}`, "", `| ${table.columns.join(" | ")} |`, `| ${table.columns.map(() => "---").join(" | ")} |`, ...table.rows.map((row) => `| ${row.join(" | ")} |`));
        for (const listing of objective.analysis.publication_outputs.listings) lines.push(`### ${listing.title}`, "", chinese ? "仅包含聚合结果，不含患者级记录。" : "Aggregate only; no patient-level records.", "", `| ${listing.columns.join(" | ")} |`, `| ${listing.columns.map(() => "---").join(" | ")} |`, ...listing.rows.map((row) => `| ${row.join(" | ")} |`));
        for (const figure of objective.analysis.publication_outputs.figures) lines.push(chinese ? `图形：${figure.title}（${figure.id}）` : `Figure: ${figure.title} (${figure.id})`);
      }
      for (const blocker of objective.blockers) lines.push(`- ${blocker.stage}/${blocker.code}: ${blocker.message}`);
      for (const warning of objective.warnings) lines.push(chinese ? `- 警告：${warning}` : `- Warning: ${warning}`);
      lines.push("");
    }
    lines.push(chinese ? `复现标识：${artifact.reproducibility_id}` : `Reproducibility: ${artifact.reproducibility_id}`, chinese ? `报告完整性：${artifact.integrity_id}` : `Report integrity: ${artifact.integrity_id}`);
    return lines.join("\n");
  }
}
