import { handleVariableRoutes } from "./variable-routes.js";
import { CLARIFY_POLICIES, type ClarifyPolicy } from "../question-clarification/index.js";
import type { VariableDefinitionService } from "../variable-definitions/index.js";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { QuestionRunJobService } from "./question-run-jobs.js";
import { restateDraft, restateRun, type PlanOptionChoice, type QuestionRunResult } from "../question-pipeline/index.js";
import { PAGE_NOT_BUILT } from "./startup-checks.js";
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": CONTENT_TYPES[".json"]!, "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};
const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 64_000) throw new Error("Request body too large."); chunks.push(chunk as Buffer); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
};
/** Most requests carry the session token as a header; a plain <a>/<img> navigation (file downloads, figure images)
 * can't set custom headers, so those specific routes also accept it as a ?token= query parameter. */
const sessionToken = (request: IncomingMessage, url: URL): string | undefined => {
  const header = request.headers["x-session-token"];
  const value = (Array.isArray(header) ? header[0] : header) || url.searchParams.get("token") || undefined;
  return value && value.length <= 200 ? value : undefined;
};

/** Serves a file only when it resolves inside `base`; never follows user paths outside the run or static folder. */
const sendFile = async (response: ServerResponse, base: string, relative: string, download?: string): Promise<void> => {
  const root = resolve(base); const target = resolve(root, normalize(relative));
  if (target !== root && !target.startsWith(`${root}${sep}`)) { sendJson(response, 404, { error: "Not found." }); return; }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream", "content-length": info.size, ...(download ? { "content-disposition": `attachment; filename="${download}"` } : {}) });
    createReadStream(target).pipe(response);
  } catch { sendJson(response, 404, { error: "Not found." }); }
};

const PLAN_ID = /^f\d+(?:\.\d+)?$/u;
/** Plan-id → method-id pairs; anything else in the body is ignored. */
const methodChoices = (value: unknown): Record<string, string> | undefined => value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key, method]) => PLAN_ID.test(key) && typeof method === "string" && /^[a-z_]+\.[a-z_]+$/u.test(method))) as Record<string, string>
  : undefined;

/** Plan-id → { landmark?, severity_on?, time? }; names and hours are checked against the plan's offered options when locking. */
const hours = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 24 * 365 ? value : undefined;
const optionChoices = (value: unknown): Record<string, PlanOptionChoice> | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(([key, choice]) => PLAN_ID.test(key) && choice && typeof choice === "object").map(([key, choice]) => {
    const { landmark, severity_on: severity, time } = choice as { landmark?: unknown; severity_on?: unknown; time?: { exposure_hours?: unknown; follow_up_end_hours?: unknown; outcome_horizon_hours?: unknown } | null };
    const timeChoice = { ...(hours(time?.exposure_hours) !== undefined ? { exposure_hours: hours(time?.exposure_hours)! } : {}), ...(hours(time?.follow_up_end_hours) !== undefined ? { follow_up_end_hours: hours(time?.follow_up_end_hours)! } : {}), ...(hours(time?.outcome_horizon_hours) !== undefined ? { outcome_horizon_hours: hours(time?.outcome_horizon_hours)! } : {}) };
    return [key, { ...(typeof landmark === "boolean" ? { landmark } : {}), ...(Array.isArray(severity) ? { severity_on: severity.filter((name): name is string => typeof name === "string" && name.length <= 80) } : {}), ...(Object.keys(timeChoice).length ? { time: timeChoice } : {}) }] as const;
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
};

/**
 * HTTP API and static page for the question workspace (port 9000). Endpoints:
 * GET /api/access/status; POST /api/access {code}; POST /api/runs {question, auto_confirm?} | {reanalysis_of, methods};
 * GET /api/runs; GET /api/runs/:id; GET /api/runs/:id/plan (plan-draft.json); POST /api/runs/:id/confirm {methods, excluded, options};
 * POST /api/runs/:id/cancel (a run still waiting in the queue); DELETE /api/runs/:id (a run that is not drafting or running);
 * GET /api/runs/:id/result (run.json); GET /api/runs/:id/files/<path> (reports, figures).
 * /api/variables/* define and check variables (see variable-routes.ts).
 *
 * When `input.invite_code` is set, every /api/runs* route requires a valid `x-session-token` header (obtained from
 * POST /api/access) and only ever sees runs started with that same token — one shared invite code, but each
 * browser session gets its own isolated run history. Leaving `invite_code` unset (the default) disables the gate
 * entirely: no token is required and every run is visible, exactly as before this existed.
 */
export const createQuestionWorkspaceServer = (input: { jobs: QuestionRunJobService; static_root: string; invite_code?: string; variables?: VariableDefinitionService }): Server => {
  const issuedTokens = new Set<string>();
  const gateEnabled = Boolean(input.invite_code);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api") {
        const relative = parts.length ? parts.join("/") : "index.html";
        // Before the web page is built, the start page says how to build it (both languages) instead of a JSON 404.
        if (relative === "index.html" && !(await stat(join(input.static_root, relative)).then((info) => info.isFile(), () => false))) {
          response.writeHead(503, { "content-type": CONTENT_TYPES[".html"]!, "cache-control": "no-store" }); response.end(PAGE_NOT_BUILT); return;
        }
        await sendFile(response, input.static_root, relative); return;
      }

      if (parts[1] === "access") {
        if (parts.length === 3 && parts[2] === "status" && request.method === "GET") { sendJson(response, 200, { gate_enabled: gateEnabled }); return; }
        if (parts.length === 2 && request.method === "POST") {
          const body = await readBody(request) as { code?: unknown };
          if (!gateEnabled) { sendJson(response, 200, { token: randomUUID() }); return; }
          if (typeof body.code !== "string" || body.code !== input.invite_code) { sendJson(response, 401, { error: "Invalid invite code." }); return; }
          const token = randomUUID();
          issuedTokens.add(token);
          sendJson(response, 200, { token });
          return;
        }
        sendJson(response, 404, { error: "Not found." }); return;
      }

      if (parts[1] === "variables") {
        const variableToken = sessionToken(request, url);
        if (gateEnabled && !(variableToken && issuedTokens.has(variableToken))) { sendJson(response, 401, { error: "Enter the invite code to use this workspace." }); return; }
        await handleVariableRoutes({ request, response, parts, url, service: input.variables, readBody, sendJson }); return;
      }
      if (parts[1] !== "runs") { sendJson(response, 404, { error: "Not found." }); return; }

      const token = sessionToken(request, url);
      if (gateEnabled && !(token && issuedTokens.has(token))) { sendJson(response, 401, { error: "Enter the invite code to use this workspace." }); return; }
      // A run this session doesn't own is reported as not found, not forbidden, so a guessed id confirms nothing.
      const owns = (record: { session_owner?: string }): boolean => !gateEnabled || record.session_owner === token;

      if (parts.length === 2 && request.method === "GET") { sendJson(response, 200, { runs: (await input.jobs.list()).filter(owns) }); return; }
      if (parts.length === 2 && request.method === "POST") {
        const body = await readBody(request) as { question?: unknown; reanalysis_of?: unknown; methods?: unknown; options?: unknown; auto_confirm?: unknown; clarify?: unknown; accept?: unknown };
        if (gateEnabled && typeof body.reanalysis_of === "string") {
          const source = await input.jobs.get(body.reanalysis_of);
          if (!source || !owns(source)) { sendJson(response, 404, { error: "Run not found." }); return; }
        }
        const methods = methodChoices(body.methods);
        const options = optionChoices(body.options);
        const record = await input.jobs.start({ question: typeof body.question === "string" ? body.question : "", ...(typeof body.reanalysis_of === "string" ? { reanalysis_of: body.reanalysis_of } : {}), ...(methods ? { methods } : {}), ...(options ? { options } : {}), ...(body.auto_confirm === true ? { auto_confirm: true } : {}), ...(typeof body.clarify === "string" && (CLARIFY_POLICIES as readonly string[]).includes(body.clarify) ? { clarify: body.clarify as ClarifyPolicy } : {}), ...(Array.isArray(body.accept) && body.accept.every((item) => typeof item === "string" && item.length < 200) && body.accept.length <= 20 ? { accept: body.accept as string[] } : {}), ...(gateEnabled && token ? { session_owner: token } : {}) });
        sendJson(response, 202, record); return;
      }
      const id = parts[2]!;
      const record = await input.jobs.get(id);
      if (!record || !owns(record)) { sendJson(response, 404, { error: "Run not found." }); return; }
      if (parts.length === 3 && request.method === "DELETE") {
        try { await input.jobs.remove(id); sendJson(response, 200, { deleted: id }); }
        catch (error) { sendJson(response, 409, { error: error instanceof Error ? error.message : "The run cannot be deleted." }); }
        return;
      }
      if (parts[3] === "cancel" && request.method === "POST") {
        try { sendJson(response, 200, await input.jobs.cancel(id)); }
        catch (error) { sendJson(response, 409, { error: error instanceof Error ? error.message : "The run cannot be cancelled." }); }
        return;
      }
      if (parts.length === 3) { sendJson(response, 200, record); return; }
      if (parts[3] === "plan" && request.method === "GET") {
        const draft = await input.jobs.plan(id);
        if (draft) sendJson(response, 200, restateDraft(draft)); else sendJson(response, 404, { error: "The plan is not ready yet." });
        return;
      }
      if (parts[3] === "confirm" && request.method === "POST") {
        const body = await readBody(request) as { methods?: unknown; excluded?: unknown; options?: unknown };
        const excluded = Array.isArray(body.excluded) ? body.excluded.filter((value): value is string => typeof value === "string" && PLAN_ID.test(value)) : [];
        const options = optionChoices(body.options);
        sendJson(response, 202, await input.jobs.confirm(id, { methods: methodChoices(body.methods) ?? {}, excluded, ...(options ? { options } : {}) }));
        return;
      }
      if (parts[3] === "result") {
        // The page shows each plan's sentences as the report does (restated for runs written by an earlier compiler).
        try { const saved = JSON.parse(await readFile(join(input.jobs.directoryOf(id), "run.json"), "utf8")) as QuestionRunResult; response.writeHead(200, { "content-type": CONTENT_TYPES[".json"]!, "cache-control": "no-store" }); response.end(JSON.stringify(restateRun(saved))); }
        catch { sendJson(response, 404, { error: "The run has no result yet." }); }
        return;
      }
      if (parts[3] === "files" && parts.length > 4) {
        const relative = parts.slice(4).join("/");
        await sendFile(response, input.jobs.directoryOf(id), relative, /\.(?:docx|md|txt)$/u.test(relative) ? `${id}-${parts.at(-1)}` : undefined);
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." });
    }
  });
};
