import assert from "node:assert/strict";
import test from "node:test";
import { AssociationAnalysisService, SyntheticLactateMortalityGateway } from "../../association-analysis/index.js";
import { createInMemoryDesignSessionRepository, createResearchDesignService } from "../../research-design/index.js";
import { completeAssociationProposal, modelReturning, startRequest } from "../../research-design/tests/model-fixtures.js";
import { createInitialResearchPreflightService } from "../../research-feasibility/index.js";
import { ResearchWorkflowService } from "../../research-workflow/index.js";
import { InMemoryRunEvidenceRepository, RunEvidenceService } from "../../run-evidence/index.js";
import { createSyntheticResearchDesignModel } from "../../synthetic/synthetic-research-design-model.js";
import { buildObjectiveMappingView, createResearchDesignHttpHandler, createResearchDesignHttpServer, createResearchWorkspaceHttpServer } from "../index.js";
import type { StudyVariableMappingReview } from "../../variable-mapping/index.js";
import { createRetryingResearchDesignModel } from "../retrying-research-design-model.js";
import { StatusTrackingStructuredProvider, SystemStatusService } from "../system-status.js";
import { ModelAuditQueryService } from "../../model-audit/index.js";

const invokeServerRequest = async (
  server: ReturnType<typeof createResearchDesignHttpServer>,
  method: string,
  url: string,
  body?: string,
) => {
  const listener = server.listeners("request")[0];
  if (typeof listener !== "function") throw new Error("Expected a request listener.");
  const request = {
    method,
    url,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, "utf8");
    },
  };
  let statusCode = 0;
  const headers: Record<string, string> = {};
  let responseBody = "";
  const response = {
    writeHead(code: number, responseHeaders?: Record<string, string | number>) {
      statusCode = code;
      if (responseHeaders) {
        for (const [key, value] of Object.entries(responseHeaders)) headers[key] = String(value);
      }
      return this;
    },
    end(chunk?: string | Buffer) {
      if (typeof chunk === "string") {
        responseBody += chunk;
        return;
      }
      if (chunk) responseBody += chunk.toString("utf8");
    },
  };
  await (listener as (request: never, response: never) => Promise<void>)(request as never, response as never);
  return { statusCode, headers, body: responseBody };
};

test("serves the Research Design lifecycle over real HTTP", async () => {
  const service = createResearchDesignService(
    createSyntheticResearchDesignModel(),
    createInMemoryDesignSessionRepository(),
    { now: () => new Date("2026-08-31T08:00:00.000Z") },
  );
  const workflow = new ResearchWorkflowService({
    preflight: createInitialResearchPreflightService(),
    analysis: new AssociationAnalysisService(new SyntheticLactateMortalityGateway()),
    evidence: new RunEvidenceService({
      now: () => new Date("2026-08-31T09:00:00.000Z"),
      createRunId: () => "http-synthetic-run",
    }),
    runs: new InMemoryRunEvidenceRepository(),
  });
  const server = createResearchWorkspaceHttpServer(service, {
    workflow,
    executionDataSource: {
      id: "synthetic-lactate-mortality-fixture",
      version: "1.0.0",
      data_mode: "synthetic",
      available_concepts: ["icu_admission_time", "lactate_measurement", "hospital_discharge_status"],
    },
  });
  const workspaceResponse = await invokeServerRequest(server, "GET", "/");
  assert.equal(workspaceResponse.statusCode, 200);
  assert.match(workspaceResponse.headers["content-security-policy"] ?? "", /default-src 'self'/u);
  assert.match(workspaceResponse.body, /MIMIC Research Workspace/u);

  const applicationResponse = await invokeServerRequest(server, "GET", "/app.js");
  assert.equal(applicationResponse.statusCode, 200);
  assert.match(applicationResponse.body, /researchApi\.start/u);

  const startedResponse = await invokeServerRequest(
    server,
    "POST",
    "/v1/research-design/sessions",
    JSON.stringify({
      message: "Study the association between lactate and in-hospital mortality.",
      client_request_id: "http-start",
    }),
  );
  const started = JSON.parse(startedResponse.body) as { session_id: string; revision: number };
  assert.equal(startedResponse.statusCode, 201);
  assert.equal(started.revision, 1);

  const snapshotResponse = await invokeServerRequest(
    server,
    "GET",
    `/v1/research-design/sessions/${started.session_id}`,
  );
  const snapshot = JSON.parse(snapshotResponse.body) as { phase: string };
  assert.equal(snapshotResponse.statusCode, 200);
  assert.equal(snapshot.phase, "ready_to_confirm");

  const confirmedResponse = await invokeServerRequest(
    server,
    "POST",
    `/v1/research-design/sessions/${started.session_id}/confirm`,
    JSON.stringify({ base_revision: 1, client_request_id: "http-confirm" }),
  );
  const confirmed = JSON.parse(confirmedResponse.body) as { integrity_id: string };
  assert.equal(confirmedResponse.statusCode, 200);
  assert.match(confirmed.integrity_id, /^sha256:/u);

  const runResponse = await invokeServerRequest(
    server,
    "POST",
    "/v1/research-runs",
    JSON.stringify({ session_id: started.session_id, threshold_mmol_l: 2 }),
  );
  const run = JSON.parse(runResponse.body) as {
    artifact: { evidence_level: string; analysis: { counts: { total: number }; estimates: { odds_ratio: number } } };
    report_markdown: string;
  };
  assert.equal(runResponse.statusCode, 201);
  assert.equal(run.artifact.evidence_level, "synthetic_execution");
  assert.equal(run.artifact.analysis.counts.total, 6);
  assert.equal(run.artifact.analysis.estimates.odds_ratio, 4);
  assert.doesNotMatch(run.report_markdown, /SYN-00/u);

  const recoveredResponse = await invokeServerRequest(server, "GET", "/v1/research-runs/http-synthetic-run");
  const recovered = JSON.parse(recoveredResponse.body) as { artifact: { run_id: string; integrity_id: string } };
  assert.equal(recoveredResponse.statusCode, 200);
  assert.equal(recovered.artifact.run_id, "http-synthetic-run");
  assert.match(recovered.artifact.integrity_id, /^sha256:/u);

  const missingResponse = await invokeServerRequest(server, "GET", "/v1/research-design/sessions/missing");
  const missing = JSON.parse(missingResponse.body) as { error: { code: string } };
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(missing.error.code, "DESIGN_SESSION_NOT_FOUND");
});

test("serves a separate read-only safe model audit view", async () => {
  const service = createResearchDesignService(createSyntheticResearchDesignModel(), createInMemoryDesignSessionRepository());
  const server = createResearchWorkspaceHttpServer(service, {
    workflow: new ResearchWorkflowService({ preflight: createInitialResearchPreflightService(), analysis: new AssociationAnalysisService(new SyntheticLactateMortalityGateway()), evidence: new RunEvidenceService({ now: () => new Date("2026-09-10T00:00:00.000Z") }), runs: new InMemoryRunEvidenceRepository() }),
    executionDataSource: { id: "synthetic", version: "1", data_mode: "synthetic", available_concepts: [] },
    modelAudit: new ModelAuditQueryService({ list: () => [{ stage: "objective_extraction", provider: "router", model: "test-model", json_parse: "pass", schema_validation: "pass", business_validation: "pass", repair_attempts: 0, latency_ms: 10, question: "private question", prompt_text: "secret", output: { patient_id: "P-1" } }] }),
  });
  const page = await invokeServerRequest(server, "GET", "/developer/audit");
  assert.equal(page.statusCode, 200); assert.match(page.body, /模型与结构审计/u);
  const response = await invokeServerRequest(server, "GET", "/v1/model-audit");
  assert.equal(response.statusCode, 200); assert.match(response.headers["cache-control"] ?? "", /no-store/u);
  assert.doesNotMatch(response.body, /private question|secret|patient_id|P-1/u);
  assert.equal((JSON.parse(response.body) as { records: unknown[] }).records.length, 1);
});

test("starts a local manifest run without a synthetic lactate threshold", async () => {
  const service = createResearchDesignService(
    createSyntheticResearchDesignModel(),
    createInMemoryDesignSessionRepository(),
  );
  let executions = 0;
  const completedBundle = ({ artifact: { run_id: "local-run" }, report_markdown: "# Local report" }) as never;
  const localRuns = {
    execute: async () => { executions += 1; return completedBundle; },
    getRun: async () => undefined,
    createAnalysisPlan: async () => ({}) as never,
  };
  let storedJob: Record<string, unknown> | undefined;
  const server = createResearchDesignHttpServer(service, {
    localRuns,
    runJobs: {
      start: async (study) => {
        if (!storedJob) {
          const result = await localRuns.execute();
          storedJob = { job_id: "job:local", session_id: study.session_id, study_integrity_id: study.integrity_id, status: "completed", phase: "completed", attempt: 1, started_at: "2026-09-15T00:00:00.000Z", updated_at: "2026-09-15T00:00:01.000Z", heartbeat_at: "2026-09-15T00:00:01.000Z", elapsed_ms: 1_000, result };
        }
        return storedJob as never;
      },
      get: async () => storedJob as never,
    },
  });
  const startedResponse = await invokeServerRequest(
    server,
    "POST",
    "/v1/research-design/sessions",
    JSON.stringify({ message: "Study the association between lactate and in-hospital mortality.", client_request_id: "local-http-start" }),
  );
  const started = JSON.parse(startedResponse.body) as { session_id: string };
  await invokeServerRequest(
    server,
    "POST",
    `/v1/research-design/sessions/${started.session_id}/confirm`,
    JSON.stringify({ base_revision: 1, client_request_id: "local-http-confirm" }),
  );
  const runResponse = await invokeServerRequest(
    server,
    "POST",
    "/v1/research-runs",
    JSON.stringify({ session_id: started.session_id }),
  );
  assert.equal(runResponse.statusCode, 202);
  const startedJob = JSON.parse(runResponse.body) as { job_id: string };
  const duplicate = await invokeServerRequest(server, "POST", "/v1/research-runs", JSON.stringify({ session_id: started.session_id }));
  assert.equal((JSON.parse(duplicate.body) as { job_id: string }).job_id, startedJob.job_id);
  assert.equal(executions, 1);
  const jobResponse = await invokeServerRequest(server, "GET", `/v1/research-run-jobs/${encodeURIComponent(startedJob.job_id)}`);
  const job = JSON.parse(jobResponse.body) as { status: string; result: { artifact: { run_id: string } } };
  assert.equal(jobResponse.statusCode, 200);
  assert.equal(job.status, "completed");
  assert.equal(job.result.artifact.run_id, "local-run");
});

test("fails closed when local execution is unavailable instead of using a synthetic fallback", async () => {
  const service = createResearchDesignService(
    createSyntheticResearchDesignModel(),
    createInMemoryDesignSessionRepository(),
  );
  const server = createResearchDesignHttpServer(service);
  const startedResponse = await invokeServerRequest(
    server,
    "POST",
    "/v1/research-design/sessions",
    JSON.stringify({ message: "Study the association between lactate and in-hospital mortality.", client_request_id: "no-fallback-start" }),
  );
  const started = JSON.parse(startedResponse.body) as { session_id: string };
  await invokeServerRequest(
    server,
    "POST",
    `/v1/research-design/sessions/${started.session_id}/confirm`,
    JSON.stringify({ base_revision: 1, client_request_id: "no-fallback-confirm" }),
  );
  const response = await invokeServerRequest(server, "POST", "/v1/research-runs", JSON.stringify({ session_id: started.session_id }));
  assert.equal(response.statusCode, 503);
  assert.equal((JSON.parse(response.body) as { error: { code: string } }).error.code, "EXECUTION_UNAVAILABLE");
});

const invokeJsonHandler = async (
  handler: ReturnType<typeof createResearchDesignHttpHandler>,
  method: string,
  url: string,
  body?: unknown,
) => {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const request = {
    method,
    url,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      if (bodyText) yield Buffer.from(bodyText);
    },
  };
  let statusCode = 0;
  let responseBody = "";
  const response = {
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (typeof chunk === "string") responseBody += chunk;
      else if (chunk) responseBody += chunk.toString("utf8");
    },
  };
  await handler(request as never, response as never);
  return {
    statusCode,
    body: responseBody ? JSON.parse(responseBody) as unknown : undefined,
  };
};

const createStatusAwareHandler = (outputs: unknown[], status: SystemStatusService) => {
  const provider = new StatusTrackingStructuredProvider({
    async generateProposal() {
      const output = outputs.shift();
      if (output === undefined) throw new Error("No model fixture remains.");
      return output;
    },
  }, status);
  const model = createRetryingResearchDesignModel(
    provider,
    {
      profile: "status-test",
      timeout_ms: 1_500,
      prompt: {
        id: "research-design",
        version: "0.6.0",
        status: "testing",
        body: "# Status test prompt\n",
      },
      retry_max_attempts: 2,
      retry_backoff_ms: 0,
    },
    {
      max_attempts: 1,
      backoff_ms: 0,
      sleep: async () => {},
    },
  );
  const service = createResearchDesignService(model, createInMemoryDesignSessionRepository());
  const handler = createResearchDesignHttpHandler(service, { systemStatus: status });
  return { handler, status };
};

test("keeps transport ready and recovers only after an explicit retry", async () => {
  const status = new SystemStatusService([
    { id: "workspace", label: "Workspace", state: "ready", summary: "Loaded" },
    { id: "storage", label: "Storage", state: "ready", summary: "Loaded" },
    { id: "research_design_model", label: "研究设计模型", state: "unknown", summary: "等待首次请求" },
    { id: "research_design_validation", label: "研究方案校验", state: "unknown", summary: "等待首次方案校验" },
  ]);
  const { handler } = createStatusAwareHandler([{ unexpected: true }, completeAssociationProposal()], status);
  const startedResponse = await invokeJsonHandler(
    handler,
    "POST",
    "/v1/research-design/sessions",
    {
      message: "Study the association between lactate and in-hospital mortality.",
      client_request_id: "status-recovery",
    },
  );
  assert.equal(startedResponse.statusCode, 502);
  assert.equal((startedResponse.body as { error: { code: string } }).error.code, "DESIGN_PROPOSAL_INVALID");
  const retriedResponse = await invokeJsonHandler(
    handler,
    "POST",
    "/v1/research-design/sessions",
    {
      message: "Study the association between lactate and in-hospital mortality.",
      client_request_id: "status-recovery-explicit-retry",
    },
  );
  assert.equal(retriedResponse.statusCode, 201);
  const report = status.report();
  assert.equal(report.status, "ready");
  assert.equal(report.capabilities.find(({ id }) => id === "research_design_model")?.state, "ready");
  assert.equal(report.capabilities.find(({ id }) => id === "research_design_validation")?.state, "ready");
});

test("marks only proposal validation degraded after repeated invalid proposals", async () => {
  const status = new SystemStatusService([
    { id: "workspace", label: "Workspace", state: "ready", summary: "Loaded" },
    { id: "storage", label: "Storage", state: "ready", summary: "Loaded" },
    { id: "research_design_model", label: "研究设计模型", state: "unknown", summary: "等待首次请求" },
    { id: "research_design_validation", label: "研究方案校验", state: "unknown", summary: "等待首次方案校验" },
  ]);
  const { handler } = createStatusAwareHandler([{ unexpected: true }, { stillUnexpected: true }], status);
  const startedResponse = await invokeJsonHandler(
    handler,
    "POST",
    "/v1/research-design/sessions",
    {
      message: "Study the association between lactate and in-hospital mortality.",
      client_request_id: "status-validation-failure",
    },
  );
  assert.equal(startedResponse.statusCode, 502);
  const started = startedResponse.body as { error: { code: string } };
  assert.equal(started.error.code, "DESIGN_PROPOSAL_INVALID");

  const report = status.report();
  assert.equal(report.status, "degraded");
  assert.equal(report.capabilities.find(({ id }) => id === "research_design_model")?.state, "ready");
  const validation = report.capabilities.find(({ id }) => id === "research_design_validation");
  assert.equal(validation?.state, "degraded");
  assert.equal(validation?.failure_stage, "proposal_validation");
  assert.match(validation?.reason ?? "", /must|additional properties|required property/u);
  assert.match(validation?.next_action ?? "", /重试/u);
});

test("returns safe errors for malformed JSON and unknown routes", async () => {
  const service = createResearchDesignService(
    modelReturning(completeAssociationProposal()),
    createInMemoryDesignSessionRepository(),
  );
  const server = createResearchDesignHttpServer(service);
  const invalid = await invokeServerRequest(server, "POST", "/v1/research-design/sessions", "not-json");
  assert.equal(invalid.statusCode, 400);
  const unknown = await invokeServerRequest(server, "GET", "/unknown");
  assert.equal(unknown.statusCode, 404);
  const unknownSessionAction = await invokeServerRequest(server, "GET", "/v1/research-design/sessions/example/unknown");
  assert.equal(unknownSessionAction.statusCode, 404);
  assert.equal((JSON.parse(unknownSessionAction.body) as { error: { code: string } }).error.code, "ROUTE_NOT_FOUND");
});

test("runs an arbitrary multi-objective question end to end, dedupes, exposes blocked-objective mapping review, and restarts on retry", async () => {
  // Deliberately not one of the platform's example questions (metoprolol/blood pressure, lactate/
  // mortality, ...): the multi-objective HTTP surface must work for any free-text MIMIC question.
  const question = "Is early enteral nutrition within 48 hours associated with shorter ICU length of stay among mechanically ventilated patients?";
  const blockedStudySpec = { integrity_id: "spec:blocked-objective" } as never;
  let executions = 0;
  let storedJob: Record<string, unknown> | undefined;
  const objectiveTraces = [
    { objective_id: "objective-1", status: "completed" as const, compilation_audit: [] },
    { objective_id: "objective-2", status: "blocked" as const, compilation_audit: [], study_spec: blockedStudySpec },
  ];
  const multiObjectiveJobs = {
    start: async (originalQuestion: string, options?: { retry?: boolean }) => {
      assert.equal(originalQuestion, question);
      if (!storedJob || options?.retry) {
        executions += 1;
        storedJob = {
          job_id: "program-job:fixed-for-test", status: "completed", phase: "completed", attempt: executions,
          started_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:05.000Z", heartbeat_at: "2026-09-20T00:00:05.000Z",
          elapsed_ms: 5_000, result_id: "report:multi-objective-1", objective_traces: objectiveTraces,
          result: { artifact: { report_id: "report:multi-objective-1" } },
        };
      }
      return storedJob as never;
    },
    get: async (jobId: string) => (storedJob && storedJob.job_id === jobId ? storedJob as never : undefined),
  };
  let assessedSpec: unknown;
  const variableMappings = {
    assess: async (studySpec: unknown) => { assessedSpec = studySpec; return { status: "needs_confirmation", variables: [] } as never; },
    confirm: async () => ({}) as never,
  };
  const service = createResearchDesignService(createSyntheticResearchDesignModel(), createInMemoryDesignSessionRepository());
  const server = createResearchDesignHttpServer(service, { multiObjectiveJobs, variableMappings: variableMappings as never });

  const started = await invokeServerRequest(server, "POST", "/v1/multi-objective-runs", JSON.stringify({ original_question: question }));
  assert.equal(started.statusCode, 202);
  const startedJob = JSON.parse(started.body) as { job_id: string; status: string };
  assert.equal(startedJob.status, "completed");

  const duplicate = await invokeServerRequest(server, "POST", "/v1/multi-objective-runs", JSON.stringify({ original_question: question }));
  assert.equal((JSON.parse(duplicate.body) as { job_id: string }).job_id, startedJob.job_id);
  assert.equal(executions, 1);

  const polled = await invokeServerRequest(server, "GET", `/v1/multi-objective-run-jobs/${encodeURIComponent(startedJob.job_id)}`);
  assert.equal(polled.statusCode, 200);
  assert.equal((JSON.parse(polled.body) as { status: string }).status, "completed");

  const missingJob = await invokeServerRequest(server, "GET", "/v1/multi-objective-run-jobs/program-job%3Adoes-not-exist");
  assert.equal(missingJob.statusCode, 404);

  const mappingReview = await invokeServerRequest(
    server, "GET",
    `/v1/multi-objective-runs/${encodeURIComponent(startedJob.job_id)}/objectives/objective-2/variable-mappings`,
  );
  assert.equal(mappingReview.statusCode, 200);
  assert.equal((JSON.parse(mappingReview.body) as { status: string }).status, "needs_confirmation");
  assert.deepEqual(assessedSpec, blockedStudySpec);

  const completedObjectiveMapping = await invokeServerRequest(
    server, "GET",
    `/v1/multi-objective-runs/${encodeURIComponent(startedJob.job_id)}/objectives/objective-1/variable-mappings`,
  );
  assert.equal(completedObjectiveMapping.statusCode, 404);
  assert.equal((JSON.parse(completedObjectiveMapping.body) as { error: { code: string } }).error.code, "OBJECTIVE_STUDY_SPEC_NOT_FOUND");

  const missingRequest = await invokeServerRequest(
    server, "POST", "/v1/multi-objective-runs", JSON.stringify({ original_question: "   " }),
  );
  assert.equal(missingRequest.statusCode, 400);

  const retried = await invokeServerRequest(server, "POST", "/v1/multi-objective-runs", JSON.stringify({ original_question: question, retry: true }));
  assert.equal(retried.statusCode, 202);
  assert.equal(executions, 2);
});

test("returns 503 for multi-objective routes when the feature is unavailable", async () => {
  const service = createResearchDesignService(createSyntheticResearchDesignModel(), createInMemoryDesignSessionRepository());
  const server = createResearchDesignHttpServer(service);
  const start = await invokeServerRequest(server, "POST", "/v1/multi-objective-runs", JSON.stringify({ original_question: "Any MIMIC question at all?" }));
  assert.equal(start.statusCode, 503);
  const poll = await invokeServerRequest(server, "GET", "/v1/multi-objective-run-jobs/program-job%3Aabc");
  assert.equal(poll.statusCode, 503);
  const mapping = await invokeServerRequest(server, "GET", "/v1/multi-objective-runs/program-job%3Aabc/objectives/objective-1/variable-mappings");
  assert.equal(mapping.statusCode, 503);
});

test("buildObjectiveMappingView keeps all mapping business logic server-side: it hides candidates an automated evidence review rejected, and never leaks internal fields the frontend has no use for", () => {
  const mapping = (id: string, status: "discovered" | "database_verified" | "validated") => ({
    schema_version: "1.0.0" as const, mapping_id: id, concept_id: id, mapping_version: "1.0.0",
    labels: { en: `English ${id}`, zh: `中文 ${id}` }, synonyms: [], category: "laboratory" as const, value_type: "continuous" as const,
    definition: { summary: "s", temporal_rule: "t", value_rule: "v", missingness_rule: "m" },
    sources: [{ kind: "direct_field" as const, schema: "mimiciv_icu" as const, table: "icustays", columns: ["los"] }],
    status, provenance: "realtime_discovery" as const,
    evidence: { data_profile: { source_id: "mimiciv_icu.icustays", matched_record_count: 12, missing_value_count: 3, distinct_value_count: 5, units: [], top_values: [], profiled_at: "2026-09-20T00:00:00.000Z" } },
    created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z",
  });
  const candidate = (id: string, status: "discovered" | "database_verified" | "validated", confirmable = true) => ({
    candidate_id: id, requested_term: "term", normalized_term: "term", role: "exposure" as const,
    mapping: mapping(id, status), match_basis: ["database_dictionary" as const], confidence: "medium" as const,
    requires_clinician_confirmation: confirmable, explanation: "why",
  });
  const review: StudyVariableMappingReview = {
    schema_version: "1.0.0", status: "needs_confirmation",
    variables: [
      // An automated evidence review rejected every candidate for this term: nothing should render.
      { schema_version: "1.0.0", requested_term: "rejected-term", role: "exposure", status: "needs_confirmation", candidates: [candidate("a", "discovered")], candidate_review: { decision: "rejected", reason_codes: [] } as never },
      // No automated review ran (or it approved): the reviewable candidate should render, a
      // non-reviewable one (requires_clinician_confirmation: false) should not.
      { schema_version: "1.0.0", requested_term: "open-term", role: "exposure", status: "needs_confirmation", candidates: [candidate("b", "database_verified"), candidate("c", "discovered", false)] },
      // Resolved variables show only their first candidate, never asking for confirmation.
      { schema_version: "1.0.0", requested_term: "resolved-term", role: "outcome", status: "resolved", candidates: [candidate("d", "validated", false)] },  // resolved: already validated, no further confirmation needed
    ],
    summary: { resolved: 1, needs_confirmation: 2, unmapped: 0 },
    verification_available: true,
  };

  const view = buildObjectiveMappingView(review);
  assert.equal(view.variables[0]!.candidates.length, 0);
  assert.deepEqual(view.variables[1]!.candidates.map((c: { mapping_id: string }) => c.mapping_id), ["b"]);
  assert.equal(view.variables[1]!.candidates[0]!.confirmable, true);
  assert.equal(view.variables[1]!.candidates[0]!.explanation_kind, "candidate");
  assert.deepEqual(view.variables[1]!.candidates[0]!.evidence, { kind: "data_profile", source_id: "mimiciv_icu.icustays", matched_record_count: 12, missing_value_count: 3, units: [], top_values: [] });
  assert.deepEqual(view.variables[2]!.candidates.map((c: { mapping_id: string }) => c.mapping_id), ["d"]);
  assert.equal(view.variables[2]!.candidates[0]!.confirmable, false);
  assert.equal(view.variables[2]!.candidates[0]!.explanation_kind, "validated");
  // Only the fields the frontend renders are exposed — no raw mapping/source/status internals.
  assert.deepEqual(Object.keys(view.variables[1]!.candidates[0]!).sort(), ["confirmable", "evidence", "explanation_kind", "labels", "mapping_id"]);
});
