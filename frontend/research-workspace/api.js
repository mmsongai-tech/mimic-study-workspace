export class ResearchApiError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "ResearchApiError";
    this.code = code;
    this.details = details;
  }
}

const request = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new ResearchApiError(
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? "The request could not be completed.",
      body?.error?.details ?? [],
    );
  }
  return body;
};

const requestId = (operation) => `${operation}-${crypto.randomUUID()}`;

export const researchApi = {
  getSession(sessionId) {
    return request(`/v1/research-design/sessions/${encodeURIComponent(sessionId)}`);
  },

  start(message, allowOpenAiFallback = false) {
    return request("/v1/research-design/sessions", {
      method: "POST",
      body: JSON.stringify({ message, study_spec_contract: "objectives-v1", allow_openai_fallback: allowOpenAiFallback, client_request_id: requestId("start") }),
    });
  },

  confirm(sessionId, revision) {
    return request(`/v1/research-design/sessions/${encodeURIComponent(sessionId)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ base_revision: revision, client_request_id: requestId("confirm") }),
    });
  },

  continue(sessionId, revision, answers, message = "") {
    return request(`/v1/research-design/sessions/${encodeURIComponent(sessionId)}/continue`, {
      method: "POST",
      body: JSON.stringify({
        base_revision: revision,
        answers,
        ...(message ? { message } : {}),
        client_request_id: requestId("continue"),
      }),
    });
  },

  continueSuggestion(sessionId, revision, suggestion) {
    return request(`/v1/research-design/sessions/${encodeURIComponent(sessionId)}/continue`, {
      method: "POST",
      body: JSON.stringify({
        base_revision: revision,
        suggestion_id: suggestion.id,
        client_request_id: requestId("continue-suggestion"),
      }),
    });
  },

  run(sessionId, threshold) {
    return request("/v1/research-runs", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, threshold_mmol_l: threshold }),
    });
  },

  getRun(runId) {
    return request(`/v1/research-runs/${encodeURIComponent(runId)}`);
  },

  getRunJob(jobId) {
    return request(`/v1/research-run-jobs/${encodeURIComponent(jobId)}`);
  },

  analysisPlan(sessionId) {
    return request(`/v1/research-design/sessions/${encodeURIComponent(sessionId)}/analysis-plan`);
  },

  variableMappings(sessionId, live = false) {
    return request(`/v1/research-design/sessions/${encodeURIComponent(sessionId)}/variable-mappings?live=${live}`);
  },

  confirmVariableMapping(mappingId, reviewerNote) {
    return request(`/v1/variable-mappings/${encodeURIComponent(mappingId)}/confirm`, { method: "POST", body: JSON.stringify({ reviewer_note: reviewerNote }) });
  },

  reportExportUrl(runId, format, language) {
    return `/v1/research-runs/${encodeURIComponent(runId)}/exports/${format}?language=${encodeURIComponent(language)}`;
  },

  // Staged multi-objective pipeline: works for any free-text MIMIC question, never a fixed one.
  startMultiObjectiveRun(originalQuestion, retry = false) {
    return request("/v1/multi-objective-runs", {
      method: "POST",
      body: JSON.stringify({ original_question: originalQuestion, ...(retry ? { retry: true } : {}) }),
    });
  },

  getMultiObjectiveRunJob(jobId) {
    return request(`/v1/multi-objective-run-jobs/${encodeURIComponent(jobId)}`);
  },

  objectiveVariableMappings(jobId, objectiveId, live = false) {
    return request(`/v1/multi-objective-runs/${encodeURIComponent(jobId)}/objectives/${encodeURIComponent(objectiveId)}/variable-mappings?live=${live}`);
  },
};
