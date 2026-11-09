import type { IncomingMessage, ServerResponse } from "node:http";
import { VariableDefinitionError, type SearchKind, type VariableDefinition, type VariableDefinitionService } from "../variable-definitions/index.js";

const KINDS: SearchKind[] = ["item", "drug", "diagnosis", "procedure"];

/**
 * Variable-definition routes of the question workspace:
 * GET /api/variables/search?kind=item|drug|diagnosis|procedure&q=…   dictionary entries with their counts
 * GET /api/variables                                                   {shared, workspace} definitions
 * POST /api/variables/check {definition}                               the checks and facts, nothing saved
 * POST /api/variables {definition}                                     check, then save to the workspace
 * DELETE /api/variables/:id                                            remove a workspace definition
 * Returns false when the path is not a variables route.
 */
export const handleVariableRoutes = async (input: {
  request: IncomingMessage; response: ServerResponse; parts: string[]; url: URL; service: VariableDefinitionService | undefined;
  readBody: (request: IncomingMessage) => Promise<unknown>; sendJson: (response: ServerResponse, status: number, body: unknown) => void;
}): Promise<boolean> => {
  const { request, response, parts, url, service, sendJson } = input;
  if (parts[1] !== "variables") return false;
  if (!service) { sendJson(response, 503, { error: "Variable definitions are not available: the dictionary index has not been built (scripts/build-dictionary-index.py)." }); return true; }
  try {
    if (parts[2] === "search" && request.method === "GET") {
      const kind = url.searchParams.get("kind") as SearchKind | null; const query = url.searchParams.get("q") ?? "";
      if (!kind || !KINDS.includes(kind)) { sendJson(response, 400, { error: `kind must be one of ${KINDS.join(", ")}.` }); return true; }
      sendJson(response, 200, { hits: service.search(kind, query.slice(0, 120)) }); return true;
    }
    if (parts.length === 2 && request.method === "GET") { sendJson(response, 200, await service.list()); return true; }
    if (parts[2] === "check" && request.method === "POST") {
      const body = await input.readBody(request) as { definition?: VariableDefinition };
      if (!body.definition) { sendJson(response, 400, { error: "definition is required." }); return true; }
      sendJson(response, 200, await service.check(body.definition)); return true;
    }
    if (parts.length === 2 && request.method === "POST") {
      const body = await input.readBody(request) as { definition?: VariableDefinition };
      if (!body.definition) { sendJson(response, 400, { error: "definition is required." }); return true; }
      sendJson(response, 201, await service.save(body.definition)); return true;
    }
    if (parts.length === 3 && request.method === "DELETE") { await service.remove(parts[2]!); sendJson(response, 200, { deleted: parts[2] }); return true; }
  } catch (error) {
    if (error instanceof VariableDefinitionError) { sendJson(response, 422, { error: error.message, ...(error.report ? { report: error.report } : {}) }); return true; }
    throw error;
  }
  sendJson(response, 404, { error: "Not found." }); return true;
};
