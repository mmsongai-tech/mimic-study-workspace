import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DesignError } from "../research-design/design-error.js";
import type { ResearchDesignService } from "../research-design/research-design-service.js";
import type { ResearchWorkflowService } from "../research-workflow/research-workflow-service.js";
import { ResearchWorkflowError } from "../research-workflow/research-workflow-service.js";
import { AssociationAnalysisError } from "../association-analysis/domain/association-analysis.js";
import type { DataSourceDescriptor } from "../research-feasibility/domain/preflight.js";
import { RunEvidenceError } from "../run-evidence/domain/run-artifact.js";
import { ReportExportError, type ReportExportService } from "../report-export/index.js";
import { PredictionAnalysisError } from "../prediction-analysis/index.js";
import { TreatmentEffectAnalysisError } from "../treatment-effect-analysis/index.js";
import type { ResearchAnalysisPlanService } from "../analysis-planning/index.js";
import { VariableMappingError, type StudyVariableMappingReview, type StudyVariableMappingService } from "../variable-mapping/index.js";
import type { SystemStatusService } from "./system-status.js";
import type { LocalResearchRunService } from "../clinical-data/index.js";
import type { MultiObjectiveReportBundle } from "../multi-objective-report/index.js";
import type { LocalRunJobView } from "./local-run-job-service.js";
import type { MultiObjectiveRunJobView } from "./multi-objective-run-job-service.js";

type LocalRunBundle = Awaited<ReturnType<LocalResearchRunService["execute"]>> | MultiObjectiveReportBundle;
export type BrowserLocalRunService = {
  execute: (study: Parameters<LocalResearchRunService["execute"]>[0]) => Promise<LocalRunBundle>;
  getRun: (id: string) => Promise<LocalRunBundle | undefined>;
  createAnalysisPlan: LocalResearchRunService["createAnalysisPlan"];
};
export type BrowserLocalRunJobService = {
  start: (study: Parameters<LocalResearchRunService["execute"]>[0]) => Promise<LocalRunJobView<LocalRunBundle>>;
  get: (jobId: string) => Promise<LocalRunJobView<LocalRunBundle> | undefined>;
};
// Runs an arbitrary, free-text MIMIC research question end to end (objective decomposition,
// per-objective StudySpec compilation, mapping, execution, reporting) — never a fixed question.
export type BrowserMultiObjectiveRunJobService = {
  start: (originalQuestion: string, options?: { retry?: boolean }) => Promise<MultiObjectiveRunJobView<MultiObjectiveReportBundle>>;
  get: (jobId: string) => Promise<MultiObjectiveRunJobView<MultiObjectiveReportBundle> | undefined>;
};

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const readJson = async (request: IncomingMessage, maxBytes: number): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new DesignError("DESIGN_LIMIT_EXCEEDED", "The request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DesignError("DESIGN_INVALID_INPUT", "The request body must be valid JSON.");
  }
};

// The frontend must stay purely presentational: it renders whatever this shape hands it and
// makes no confirmability/visibility decisions of its own. All of that business logic — which
// candidates are safe to show, which are actionable — is decided here, once, server-side.
export interface ObjectiveMappingCandidateView {
  mapping_id: string;
  labels: { en: string; zh?: string };
  explanation_kind: "validated" | "candidate";
  confirmable: boolean;
  evidence:
    | { kind: "data_profile"; source_id: string; matched_record_count: number; missing_value_count: number; units: Array<{ value: string; count: number }>; top_values: Array<{ value: string; count: number }> }
    | { kind: "dictionary"; entries: Array<{ dictionary: string; identifier: string; label: string }> }
    | { kind: "none" };
}
export interface ObjectiveMappingVariableView {
  requested_term: string;
  status: "resolved" | "needs_confirmation" | "unmapped";
  candidates: ObjectiveMappingCandidateView[];
}
export interface ObjectiveMappingView {
  status: "ready" | "needs_confirmation" | "blocked";
  variables: ObjectiveMappingVariableView[];
}

export const buildObjectiveMappingView = (assessment: StudyVariableMappingReview): ObjectiveMappingView => ({
  status: assessment.status,
  variables: assessment.variables.map((variable) => {
    // `candidate_review` is the automated dictionary-evidence review outcome for this VARIABLE
    // (it covers every candidate for the term together), not a per-candidate field — checking it
    // here (rather than on each candidate) is what actually hides candidates the automated review
    // rejected.
    const reviewable = variable.status === "needs_confirmation" && (!variable.candidate_review || variable.candidate_review.decision === "approved")
      ? variable.candidates.filter((candidate) => candidate.requires_clinician_confirmation
        && ["discovered", "database_verified"].includes(candidate.mapping.status))
      : [];
    const visible = variable.status === "resolved" ? variable.candidates.slice(0, 1) : reviewable;
    return {
      requested_term: variable.requested_term,
      status: variable.status,
      candidates: visible.map((candidate): ObjectiveMappingCandidateView => {
        const profile = candidate.mapping.evidence?.data_profile;
        const dictionaryEntries = candidate.mapping.evidence?.dictionary_entries ?? [];
        return {
          mapping_id: candidate.mapping.mapping_id,
          labels: candidate.mapping.labels,
          explanation_kind: ["validated", "clinician_confirmed"].includes(candidate.mapping.status) ? "validated" : "candidate",
          confirmable: Boolean(assessment.verification_available && candidate.requires_clinician_confirmation),
          evidence: profile
            ? { kind: "data_profile", source_id: profile.source_id, matched_record_count: profile.matched_record_count, missing_value_count: profile.missing_value_count, units: profile.units, top_values: profile.top_values }
            : dictionaryEntries.length
              ? { kind: "dictionary", entries: dictionaryEntries.map(({ dictionary, identifier, label }) => ({ dictionary, identifier, label })) }
              : { kind: "none" },
        };
      }),
    };
  }),
});

const errorStatus = (error: DesignError): number => ({
  DESIGN_INVALID_INPUT: 400,
  DESIGN_SESSION_NOT_FOUND: 404,
  DESIGN_REVISION_CONFLICT: 409,
  DESIGN_IDEMPOTENCY_CONFLICT: 409,
  DESIGN_REQUEST_IN_PROGRESS: 409,
  DESIGN_LIMIT_EXCEEDED: 413,
  DESIGN_NOT_READY: 422,
  DESIGN_PROPOSAL_INVALID: 502,
  DESIGN_MODEL_UNAVAILABLE: 503,
  DESIGN_MODEL_TIMEOUT: 504,
  DESIGN_MODEL_AUTHENTICATION_FAILED: 503,
  DESIGN_MODEL_OPENAI_AUTHENTICATION_FAILED: 503,
  DESIGN_MODEL_RESPONSE_INVALID: 502,
  DESIGN_MODEL_RATE_LIMITED: 503,
  DESIGN_MODEL_FALLBACK_AUTHORIZATION_REQUIRED: 503,
  DESIGN_STORAGE_FAILURE: 503,
}[error.code]);

const summarizeInvalidProposalReason = (error: DesignError): string => {
  if (error.details.length === 0) return error.message;
  const uniqueDetails = [...new Set(error.details)].slice(0, 3);
  const suffix = error.details.length > uniqueDetails.length ? " ..." : "";
  return `${error.message} ${uniqueDetails.join("; ")}${suffix}`;
};

export const createResearchDesignHttpHandler = (
  service: ResearchDesignService,
  options: {
    maxBodyBytes?: number;
    workflow?: ResearchWorkflowService;
    executionDataSource?: DataSourceDescriptor;
    reportExports?: ReportExportService;
    analysisPlans?: ResearchAnalysisPlanService;
    variableMappings?: StudyVariableMappingService;
    systemStatus?: SystemStatusService;
    localRuns?: BrowserLocalRunService;
    runJobs?: BrowserLocalRunJobService;
    multiObjectiveJobs?: BrowserMultiObjectiveRunJobService;
  } = {},
) => async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && segments.length === 3 && segments[0] === "v1" && segments[1] === "research-run-jobs") {
      if (!options.runJobs) { json(response, 503, { error: { code: "EXECUTION_UNAVAILABLE", message: "Research execution is unavailable." } }); return; }
      const job = await options.runJobs.get(decodeURIComponent(segments[2] ?? ""));
      if (!job) { json(response, 404, { error: { code: "RUN_JOB_NOT_FOUND", message: "The research run job was not found." } }); return; }
      json(response, 200, job);
      return;
    }
    // Starts (or resumes, or — with retry:true after a mapping review — restarts) the generic
    // objective-decomposition pipeline for ANY free-text MIMIC research question. Never a fixed
    // question: the model reads `original_question` fresh on every call.
    if (request.method === "POST" && url.pathname === "/v1/multi-objective-runs") {
      if (!options.multiObjectiveJobs) {
        json(response, 503, { error: { code: "MULTI_OBJECTIVE_EXECUTION_UNAVAILABLE", message: "Multi-objective research execution is unavailable." } });
        return;
      }
      const body = await readJson(request, options.maxBodyBytes ?? 32_768);
      const originalQuestion = body && typeof body === "object" ? (body as Record<string, unknown>).original_question : undefined;
      if (typeof originalQuestion !== "string" || originalQuestion.trim().length === 0) {
        throw new DesignError("DESIGN_INVALID_INPUT", "A non-empty research question is required.");
      }
      const retry = Boolean(body && typeof body === "object" && (body as Record<string, unknown>).retry === true);
      json(response, 202, await options.multiObjectiveJobs.start(originalQuestion, { retry }));
      return;
    }
    if (request.method === "GET" && segments.length === 3 && segments[0] === "v1" && segments[1] === "multi-objective-run-jobs") {
      if (!options.multiObjectiveJobs) {
        json(response, 503, { error: { code: "MULTI_OBJECTIVE_EXECUTION_UNAVAILABLE", message: "Multi-objective research execution is unavailable." } });
        return;
      }
      const job = await options.multiObjectiveJobs.get(decodeURIComponent(segments[2] ?? ""));
      if (!job) { json(response, 404, { error: { code: "MULTI_OBJECTIVE_RUN_JOB_NOT_FOUND", message: "The multi-objective run job was not found." } }); return; }
      json(response, 200, job);
      return;
    }
    // Mapping review for one objective of a multi-objective run: pulls that objective's compiled
    // StudySpec (whatever it turned out to be for this question — never a fixed spec) from the
    // completed job and hands it to the same generic mapping assessor used by the single-question
    // flow, so every variable's candidate mappings and evidence render the same way in both flows.
    if (
      request.method === "GET" && segments.length === 6 && segments[0] === "v1" && segments[1] === "multi-objective-runs" &&
      segments[3] === "objectives" && segments[5] === "variable-mappings"
    ) {
      if (!options.multiObjectiveJobs || !options.variableMappings) {
        json(response, 503, { error: { code: "VARIABLE_MAPPING_UNAVAILABLE", message: "Variable mapping is unavailable." } });
        return;
      }
      const job = await options.multiObjectiveJobs.get(decodeURIComponent(segments[2] ?? ""));
      if (!job) { json(response, 404, { error: { code: "MULTI_OBJECTIVE_RUN_JOB_NOT_FOUND", message: "The multi-objective run job was not found." } }); return; }
      const objectiveId = decodeURIComponent(segments[4] ?? "");
      const trace = job.objective_traces?.find((candidate) => candidate.objective_id === objectiveId);
      if (!trace?.study_spec) {
        json(response, 404, { error: { code: "OBJECTIVE_STUDY_SPEC_NOT_FOUND", message: "No compiled study specification was found for this objective." } });
        return;
      }
      const assessment = await options.variableMappings.assess(trace.study_spec, url.searchParams.get("live") === "true");
      json(response, 200, buildObjectiveMappingView(assessment));
      return;
    }
    if (
      request.method === "GET" && segments.length === 5 && segments[0] === "v1" &&
      segments[1] === "research-design" && segments[2] === "sessions" && segments[4] === "variable-mappings"
    ) {
      if (!options.variableMappings) {
        json(response, 503, { error: { code: "VARIABLE_MAPPING_UNAVAILABLE", message: "Variable mapping is unavailable." } });
        return;
      }
      const snapshot = await service.getSession(decodeURIComponent(segments[3] ?? ""));
      json(response, 200, await options.variableMappings.assess(snapshot.study_spec, url.searchParams.get("live") === "true"));
      return;
    }
    if (request.method === "POST" && segments.length === 4 && segments[0] === "v1" && segments[1] === "variable-mappings" && segments[3] === "confirm") {
      if (!options.variableMappings) {
        json(response, 503, { error: { code: "VARIABLE_MAPPING_UNAVAILABLE", message: "Variable mapping is unavailable." } });
        return;
      }
      const body = await readJson(request, options.maxBodyBytes ?? 32_768);
      const reviewerNote = body && typeof body === "object" ? (body as Record<string, unknown>).reviewer_note : undefined;
      if (typeof reviewerNote !== "string") throw new DesignError("DESIGN_INVALID_INPUT", "A reviewer note is required.");
      json(response, 200, await options.variableMappings.confirm(decodeURIComponent(segments[2] ?? ""), reviewerNote));
      return;
    }
    if (
      request.method === "GET" && segments.length === 5 && segments[0] === "v1" &&
      segments[1] === "research-design" && segments[2] === "sessions" && segments[4] === "analysis-plan"
    ) {
      if (!options.localRuns && (!options.analysisPlans || !options.executionDataSource)) {
        json(response, 503, { error: { code: "ANALYSIS_PLANNING_UNAVAILABLE", message: "Analysis planning is unavailable." } });
        return;
      }
      const snapshot = await service.getSession(decodeURIComponent(segments[3] ?? ""));
      if (!snapshot.confirmed) throw new DesignError("DESIGN_NOT_READY", "The design is not confirmed.");
      json(response, 200, options.localRuns
        ? await options.localRuns.createAnalysisPlan(snapshot.confirmed)
        : options.analysisPlans!.create({ study: snapshot.confirmed, data_source: options.executionDataSource! }));
      return;
    }
    if (request.method === "GET" && segments.length === 3 && segments[0] === "v1" && segments[1] === "research-runs") {
      if (!options.workflow && !options.localRuns) {
        json(response, 503, { error: { code: "EXECUTION_UNAVAILABLE", message: "Research execution is unavailable." } });
        return;
      }
      const runId = decodeURIComponent(segments[2] ?? "");
      const bundle = await options.localRuns?.getRun(runId) ?? await options.workflow?.getRun(runId);
      if (!bundle) {
        json(response, 404, { error: { code: "RUN_NOT_FOUND", message: "The research run was not found." } });
        return;
      }
      json(response, 200, bundle);
      return;
    }
    if (
      request.method === "GET" && segments.length === 5 && segments[0] === "v1" &&
      segments[1] === "research-runs" && segments[3] === "exports"
    ) {
      if (!options.reportExports) {
        json(response, 503, { error: { code: "REPORT_EXPORT_UNAVAILABLE", message: "Report export is unavailable." } });
        return;
      }
      const format = segments[4];
      const language = url.searchParams.get("language") ?? "en";
      if ((format !== "docx" && format !== "pdf") || (language !== "en" && language !== "zh")) {
        json(response, 400, { error: { code: "REPORT_EXPORT_INVALID", message: "The requested report export is invalid." } });
        return;
      }
      const exported = await options.reportExports.create(decodeURIComponent(segments[2] ?? ""), format, language);
      options.systemStatus?.set({ id: "report_runtime", label: "报告运行时", state: "ready", summary: `最近一次 ${format.toUpperCase()} 报告已成功生成` });
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": exported.content_type,
        "content-disposition": `attachment; filename="${exported.filename}"`,
        "content-length": exported.content.length,
        "x-content-type-options": "nosniff",
      });
      response.end(exported.content);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/research-runs") {
      if (!options.localRuns && (!options.workflow || !options.executionDataSource)) {
        json(response, 503, { error: { code: "EXECUTION_UNAVAILABLE", message: "Research execution is unavailable." } });
        return;
      }
      const body = await readJson(request, options.maxBodyBytes ?? 32_768);
      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as Record<string, unknown>).session_id !== "string" ||
        (!options.localRuns && typeof (body as Record<string, unknown>).threshold_mmol_l !== "number")
      ) {
        throw new DesignError(
          "DESIGN_INVALID_INPUT",
          options.localRuns ? "A session identifier is required." : "A session identifier and numeric threshold are required.",
        );
      }
      const runRequest = body as { session_id: string; threshold_mmol_l?: number };
      const snapshot = await service.getSession(runRequest.session_id);
      if (!snapshot.confirmed) throw new DesignError("DESIGN_NOT_READY", "The design is not confirmed.");
      if (options.localRuns) {
        if (!options.runJobs) { json(response, 503, { error: { code: "EXECUTION_UNAVAILABLE", message: "Persistent research execution is unavailable." } }); return; }
        json(response, 202, await options.runJobs.start(snapshot.confirmed));
        return;
      }
      json(response, 201, await options.workflow!.execute({
        study: snapshot.confirmed,
        threshold_mmol_l: runRequest.threshold_mmol_l!,
        data_source: options.executionDataSource!,
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/research-design/sessions") {
      const result = await service.start(await readJson(request, options.maxBodyBytes ?? 32_768) as never);
      options.systemStatus?.set({ id: "research_design_validation", label: "研究方案校验", state: "ready", summary: "最近一次模型方案已通过结构与业务规则校验" });
      json(response, 201, result);
      return;
    }
    if (segments.length === 4 && segments[0] === "v1" && segments[1] === "research-design" && segments[2] === "sessions") {
      const sessionId = decodeURIComponent(segments[3] ?? "");
      if (request.method === "GET") {
        json(response, 200, await service.getSession(sessionId));
        return;
      }
    }
    if (segments.length === 5 && segments[0] === "v1" && segments[1] === "research-design" && segments[2] === "sessions") {
      if (request.method !== "POST" || (segments[4] !== "continue" && segments[4] !== "confirm")) {
        json(response, 404, { error: { code: "ROUTE_NOT_FOUND", message: "The route was not found." } });
        return;
      }
      const sessionId = decodeURIComponent(segments[3] ?? "");
      const body = await readJson(request, options.maxBodyBytes ?? 32_768);
      const normalizedBody = typeof body === "object" && body !== null && "suggestion_id" in body && typeof body.suggestion_id === "object" && body.suggestion_id !== null && "id" in body.suggestion_id
        ? { ...body, suggestion_id: body.suggestion_id.id }
        : body;
      const input = typeof normalizedBody === "object" && normalizedBody !== null ? { ...normalizedBody, session_id: sessionId } : normalizedBody;
      if (request.method === "POST" && segments[4] === "continue") {
        const result = await service.continue(input as never);
        options.systemStatus?.set({ id: "research_design_validation", label: "研究方案校验", state: "ready", summary: "最近一次模型方案已通过结构与业务规则校验" });
        json(response, 200, result);
        return;
      }
      if (request.method === "POST" && segments[4] === "confirm") {
        json(response, 200, await service.confirm(input as never));
        return;
      }
    }
    json(response, 404, { error: { code: "ROUTE_NOT_FOUND", message: "The route was not found." } });
  } catch (error) {
    if (error instanceof DesignError) {
      if (error.code === "DESIGN_PROPOSAL_INVALID") {
        options.systemStatus?.set({
          id: "research_design_validation",
          label: "研究方案校验",
          state: "degraded",
          summary: "Router 已响应，但最近一次方案未通过业务校验",
          failure_stage: "proposal_validation",
          reason: summarizeInvalidProposalReason(error),
          next_action: "可重试该问题；系统不会保存或执行未通过校验的方案。",
        });
      }
      json(response, errorStatus(error), { error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error instanceof AssociationAnalysisError) {
      json(response, error.code === "ANALYSIS_DATA_UNAVAILABLE" ? 503 : 422, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof PredictionAnalysisError || error instanceof TreatmentEffectAnalysisError) {
      json(response, error.code === "ANALYSIS_DATA_UNAVAILABLE" ? 503 : 422, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ResearchWorkflowError) {
      json(response, 503, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof RunEvidenceError) {
      json(response, 422, { error: { code: "RUN_EVIDENCE_INVALID", message: error.message } });
      return;
    }
    if (error instanceof ReportExportError) {
      options.systemStatus?.set({ id: "report_runtime", label: "报告运行时", state: "degraded", summary: "最近一次报告生成失败", failure_stage: "report_export", reason: error.message, next_action: "检查项目报告环境后重试；已有运行证据不会被修改。" });
      const status = error.code === "REPORT_NOT_FOUND" ? 404 : error.code === "REPORT_EXPORT_INVALID" ? 400 : 503;
      json(response, status, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof VariableMappingError) {
      const status = error.code === "MAPPING_NOT_FOUND" ? 404 : error.code === "MAPPING_SEARCH_UNAVAILABLE" ? 503 : error.code === "MAPPING_STORAGE_FAILURE" ? 503 : 422;
      json(response, status, { error: { code: error.code, message: error.message } });
      return;
    }
    json(response, 500, { error: { code: "INTERNAL_ERROR", message: "An internal error occurred." } });
  }
};

export const createResearchDesignHttpServer = (
  service: ResearchDesignService,
  options: {
    maxBodyBytes?: number;
    workflow?: ResearchWorkflowService;
    executionDataSource?: DataSourceDescriptor;
    reportExports?: ReportExportService;
    analysisPlans?: ResearchAnalysisPlanService;
    variableMappings?: StudyVariableMappingService;
    localRuns?: BrowserLocalRunService;
    runJobs?: BrowserLocalRunJobService;
    multiObjectiveJobs?: BrowserMultiObjectiveRunJobService;
    systemStatus?: SystemStatusService;
  } = {},
): Server => createServer(createResearchDesignHttpHandler(service, options));
