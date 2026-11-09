import type { DefinitionReport, SearchHit, SearchKind, VariableDefinition, VariableLists } from "./variables-types";
import type { PlanOptionChoice, QuestionPlanDraft, QuestionRunRecord, QuestionRunResult } from "./api-types";

/**
 * Thin client for the workspace HTTP API (backend/src/question-workspace/question-workspace-http.ts). All endpoints
 * are same-origin (the built app is served by the same Node server that answers /api/*); the Vite dev server proxies
 * /api to port 9000 (see vite.config.ts) so `npm run dev` works against a live local run too.
 */
class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * With an invite code configured, the server issues a per-browser-session token (POST /api/access) that must accompany
 * every /api/runs* call: as an `x-session-token` header for fetches, and as `?token=` for plain <a>/<img> navigations
 * (report downloads, figures) which cannot set headers. sessionStorage keeps it per tab and drops it when the tab closes.
 */
const TOKEN_KEY = "mimic-session-token";
export const UNAUTHORIZED_EVENT = "mimic-unauthorized";
const readToken = (): string | undefined => {
  try { return window.sessionStorage.getItem(TOKEN_KEY) ?? undefined; } catch { return undefined; }
};
const writeToken = (token: string | undefined): void => {
  try { if (token) window.sessionStorage.setItem(TOKEN_KEY, token); else window.sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: the gate will simply ask again */ }
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readToken();
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && (path.startsWith("/api/runs") || path.startsWith("/api/variables"))) { writeToken(undefined); window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)); }
  if (!response.ok) throw new ApiError((body as { error?: string }).error ?? `HTTP ${response.status}`, response.status);
  return body as T;
}

export const api = {
  accessStatus: () => request<{ gate_enabled: boolean }>("/api/access/status"),
  hasToken: () => Boolean(readToken()),
  unlock: async (code: string): Promise<void> => {
    const { token } = await request<{ token: string }>("/api/access", { method: "POST", body: JSON.stringify({ code }) });
    writeToken(token);
  },
  listRuns: () => request<{ runs: QuestionRunRecord[] }>("/api/runs").then((r) => r.runs),
  getRun: (id: string) => request<QuestionRunRecord>(`/api/runs/${encodeURIComponent(id)}`),
  getPlan: (id: string) => request<QuestionPlanDraft>(`/api/runs/${encodeURIComponent(id)}/plan`),
  getResult: (id: string) => request<QuestionRunResult>(`/api/runs/${encodeURIComponent(id)}/result`),
  startRun: (input: { question: string; auto_confirm?: boolean; accept?: string[] }) =>
    request<QuestionRunRecord>("/api/runs", { method: "POST", body: JSON.stringify(input) }),
  reanalyse: (input: { reanalysis_of: string; methods: Record<string, string>; options?: Record<string, PlanOptionChoice> }) =>
    request<QuestionRunRecord>("/api/runs", { method: "POST", body: JSON.stringify(input) }),
  deleteRun: (id: string) => request<{ deleted: string }>(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  cancelRun: (id: string) => request<QuestionRunRecord>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  confirmPlan: (id: string, input: { methods: Record<string, string>; excluded: string[]; options?: Record<string, PlanOptionChoice> }) =>
    request<QuestionRunRecord>(`/api/runs/${encodeURIComponent(id)}/confirm`, { method: "POST", body: JSON.stringify(input) }),
  searchVariables: (kind: SearchKind, query: string) => request<{ hits: SearchHit[] }>(`/api/variables/search?kind=${kind}&q=${encodeURIComponent(query)}`).then((r) => r.hits),
  listVariables: () => request<VariableLists>("/api/variables"),
  checkVariable: (definition: VariableDefinition) => request<DefinitionReport>("/api/variables/check", { method: "POST", body: JSON.stringify({ definition }) }),
  saveVariable: (definition: VariableDefinition) => request<{ definition: VariableDefinition; report: DefinitionReport }>("/api/variables", { method: "POST", body: JSON.stringify({ definition }) }),
  deleteVariable: (id: string) => request<{ deleted: string }>(`/api/variables/${encodeURIComponent(id)}`, { method: "DELETE" }),
  fileUrl: (runId: string, relativePath: string) => {
    const token = readToken();
    return `/api/runs/${encodeURIComponent(runId)}/files/${relativePath.split("/").map(encodeURIComponent).join("/")}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  },
  figureUrl: (runId: string, outputDir: string, file: string) => {
    const marker = "/analyses/";
    const at = outputDir.indexOf(marker);
    const relative = at >= 0 ? `analyses/${outputDir.slice(at + marker.length)}/${file}` : file;
    return api.fileUrl(runId, relative);
  },
};

export { ApiError };
