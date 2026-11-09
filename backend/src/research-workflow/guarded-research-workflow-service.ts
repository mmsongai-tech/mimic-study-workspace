import { createHash, randomUUID } from "node:crypto";
import type { AnalysisPlan } from "../analysis-planning/index.js";
import type { GeneratedAnalysisResult } from "../generated-analysis/index.js";
import type { GuardedGeneratedAnalysisWorkflow } from "../generated-analysis/index.js";
import type { ConfirmedStudySpec } from "../research-design/design-session.js";
import type { DataSourceDescriptor } from "../research-feasibility/domain/preflight.js";

export interface GuardedFieldDefinition {
  name: string;
  type: "number" | "integer" | "boolean" | "category";
  role: string;
}

export interface GuardedAnalysisReview {
  schema_version: "1.0.0";
  study_integrity_id: string;
  confirmation_integrity_id: string;
  analysis_plan: AnalysisPlan;
  field_manifest: GuardedFieldDefinition[];
  language: "python" | "r";
  allowed_packages: string[];
  allowed_result_keys: string[];
}

export interface GuardedRunArtifact {
  schema_version: "1.0.0";
  run_id: string;
  created_at: string;
  evidence_level: "synthetic_execution" | "approved_safety_database_execution";
  study: ConfirmedStudySpec;
  data_source: Pick<DataSourceDescriptor, "id" | "version" | "data_mode">;
  confirmation_integrity_id: string;
  analysis_plan: AnalysisPlan;
  field_manifest: GuardedFieldDefinition[];
  result: GeneratedAnalysisResult;
  statistical_review: {
    interpretation_status: "blocked_pending_diagnostic_review";
    blocking_reasons: string[];
  };
  integrity_id: string;
}

export interface GuardedRunEvidenceBundle {
  artifact: GuardedRunArtifact;
  report_markdown: string;
}

export interface GuardedRunEvidenceRepository {
  save(bundle: GuardedRunEvidenceBundle): Promise<boolean>;
  findByRunId(runId: string): Promise<GuardedRunEvidenceBundle | undefined>;
}

export class InMemoryGuardedRunEvidenceRepository implements GuardedRunEvidenceRepository {
  private readonly runs = new Map<string, GuardedRunEvidenceBundle>();

  async save(bundle: GuardedRunEvidenceBundle): Promise<boolean> {
    if (this.runs.has(bundle.artifact.run_id)) return false;
    this.runs.set(bundle.artifact.run_id, structuredClone(bundle));
    return true;
  }

  async findByRunId(runId: string): Promise<GuardedRunEvidenceBundle | undefined> {
    const bundle = this.runs.get(runId);
    return bundle ? structuredClone(bundle) : undefined;
  }
}

export class GuardedResearchWorkflowError extends Error {
  constructor(
    public readonly code: "PLAN_NOT_GENERATABLE" | "CONFIRMATION_MISMATCH" | "RUN_STORAGE_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "GuardedResearchWorkflowError";
  }
}

type AnalysisPlanProvider = {
  create(input: { study: ConfirmedStudySpec; data_source: DataSourceDescriptor }): AnalysisPlan;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
};

const integrity = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;

const createReport = (artifact: GuardedRunArtifact): string => [
  `# ${artifact.analysis_plan.study_spec.title}`,
  "",
  "## Evidence boundary",
  "",
  `- Evidence class: ${artifact.evidence_level}`,
  `- Data source: ${artifact.data_source.id} (${artifact.data_source.version})`,
  `- Study integrity: ${artifact.study.integrity_id}`,
  `- Confirmation integrity: ${artifact.confirmation_integrity_id}`,
  "- Primary interpretation: blocked pending required statistical diagnostic review.",
  "",
  "## Prespecified statistical method",
  "",
  `- Method: ${artifact.analysis_plan.method.primary_method}`,
  `- Rationale: ${artifact.analysis_plan.method.rationale}`,
  `- Required conditions: ${artifact.analysis_plan.method.required_conditions.join("; ") || "None recorded"}`,
  `- Required diagnostics: ${artifact.analysis_plan.method.required_diagnostics.join("; ") || "None recorded"}`,
  `- Sensitivity analyses: ${artifact.analysis_plan.method.sensitivity_analyses.join("; ") || "None recorded"}`,
  "",
  "## Controlled aggregate result",
  "",
  "```json",
  JSON.stringify(artifact.result.aggregate_result, null, 2),
  "```",
  "",
  "## Reproducibility",
  "",
  `- Runtime language: ${artifact.result.language}`,
  `- Generated source digest: ${artifact.result.source_sha256}`,
  `- Artifact integrity: ${artifact.integrity_id}`,
  "- Patient-level rows and model context are not included in this artifact.",
].join("\n");

export class GuardedResearchWorkflowService {
  constructor(private readonly dependencies: {
    analysisPlans: AnalysisPlanProvider;
    generatedAnalysis: GuardedGeneratedAnalysisWorkflow;
    runs: GuardedRunEvidenceRepository;
    now?: () => string;
    runId?: () => string;
  }) {}

  prepare(input: {
    study: ConfirmedStudySpec;
    data_source: DataSourceDescriptor;
    field_manifest?: GuardedFieldDefinition[];
    language: "python" | "r";
    allowed_packages: string[];
    allowed_result_keys: string[];
  }): GuardedAnalysisReview {
    const analysisPlan = this.dependencies.analysisPlans.create({ study: input.study, data_source: input.data_source });
    if (analysisPlan.status !== "ready_for_confirmation" || analysisPlan.execution_mode !== "guarded_generated") {
      throw new GuardedResearchWorkflowError("PLAN_NOT_GENERATABLE", "The study is not ready for controlled generated analysis.");
    }
    const fieldManifest = input.field_manifest?.length ? input.field_manifest : analysisPlan.field_manifest ?? [];
    if (!fieldManifest.length || !input.allowed_result_keys.length) {
      throw new GuardedResearchWorkflowError("PLAN_NOT_GENERATABLE", "Verified fields and an aggregate result contract are required.");
    }
    const confirmationPayload = {
      study_integrity_id: input.study.integrity_id,
      data_source: { id: input.data_source.id, version: input.data_source.version, data_mode: input.data_source.data_mode },
      analysis_plan: analysisPlan,
      field_manifest: fieldManifest,
      language: input.language,
      allowed_packages: [...input.allowed_packages].sort(),
      allowed_result_keys: [...input.allowed_result_keys].sort(),
    };
    return {
      schema_version: "1.0.0",
      study_integrity_id: input.study.integrity_id,
      confirmation_integrity_id: integrity(confirmationPayload),
      analysis_plan: analysisPlan,
      field_manifest: structuredClone(fieldManifest),
      language: input.language,
      allowed_packages: [...input.allowed_packages],
      allowed_result_keys: [...input.allowed_result_keys],
    };
  }

  async execute(input: {
    study: ConfirmedStudySpec;
    data_source: DataSourceDescriptor;
    confirmed_review: GuardedAnalysisReview;
    controlled_input: unknown;
  }): Promise<GuardedRunEvidenceBundle> {
    const currentReview = this.prepare({
      study: input.study,
      data_source: input.data_source,
      field_manifest: input.confirmed_review.field_manifest,
      language: input.confirmed_review.language,
      allowed_packages: input.confirmed_review.allowed_packages,
      allowed_result_keys: input.confirmed_review.allowed_result_keys,
    });
    if (currentReview.confirmation_integrity_id !== input.confirmed_review.confirmation_integrity_id) {
      throw new GuardedResearchWorkflowError("CONFIRMATION_MISMATCH", "The confirmed study, data source, fields, or analysis plan changed before execution.");
    }
    const result = await this.dependencies.generatedAnalysis.execute({
      analysis_plan: currentReview.analysis_plan,
      field_manifest: currentReview.field_manifest,
      controlled_input: input.controlled_input,
      language: currentReview.language,
      allowed_packages: currentReview.allowed_packages,
      allowed_result_keys: currentReview.allowed_result_keys,
    });
    const base = {
      schema_version: "1.0.0" as const,
      run_id: this.dependencies.runId?.() ?? randomUUID(),
      created_at: this.dependencies.now?.() ?? new Date().toISOString(),
      evidence_level: input.data_source.data_mode === "synthetic" ? "synthetic_execution" as const : "approved_safety_database_execution" as const,
      study: structuredClone(input.study),
      data_source: { id: input.data_source.id, version: input.data_source.version, data_mode: input.data_source.data_mode },
      confirmation_integrity_id: currentReview.confirmation_integrity_id,
      analysis_plan: currentReview.analysis_plan,
      field_manifest: currentReview.field_manifest,
      result,
      statistical_review: {
        interpretation_status: "blocked_pending_diagnostic_review" as const,
        blocking_reasons: ["Required statistical diagnostics have not yet been independently evaluated."],
      },
    };
    const artifact: GuardedRunArtifact = { ...base, integrity_id: integrity(base) };
    const bundle = { artifact, report_markdown: createReport(artifact) };
    try {
      if (!await this.dependencies.runs.save(bundle)) throw new Error("not saved");
    } catch {
      throw new GuardedResearchWorkflowError("RUN_STORAGE_FAILURE", "The controlled run evidence could not be saved.");
    }
    return bundle;
  }

  async getRun(runId: string): Promise<GuardedRunEvidenceBundle | undefined> {
    try {
      return await this.dependencies.runs.findByRunId(runId);
    } catch {
      throw new GuardedResearchWorkflowError("RUN_STORAGE_FAILURE", "The controlled run evidence could not be loaded.");
    }
  }
}
