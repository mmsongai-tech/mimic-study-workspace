import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ResearchDesignService } from "../research-design/research-design-service.js";
import type { DataSourceDescriptor } from "../research-feasibility/domain/preflight.js";
import type { ResearchWorkflowService } from "../research-workflow/research-workflow-service.js";
import { createResearchDesignHttpHandler, type BrowserLocalRunJobService, type BrowserLocalRunService, type BrowserMultiObjectiveRunJobService } from "./research-design-http.js";
import type { ReportExportService } from "../report-export/index.js";
import type { ResearchAnalysisPlanService } from "../analysis-planning/index.js";
import type { SystemStatusService } from "./system-status.js";
import type { StudyVariableMappingService } from "../variable-mapping/index.js";
import type { ModelAuditQueryService } from "../model-audit/index.js";

const assets = new Map<string, { source: URL; contentType: string }>([
  ["/statistical-presentation.js", {
    source: new URL("../../../frontend/research-workspace/statistical-presentation.js", import.meta.url),
    contentType: "text/javascript; charset=utf-8",
  }],
  ["/statistical-presentation.css", {
    source: new URL("../../../frontend/research-workspace/statistical-presentation.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  }],
  ["/", {
    source: new URL("../../../frontend/research-workspace/index.html", import.meta.url),
    contentType: "text/html; charset=utf-8",
  }],
  ["/app.js", {
    source: new URL("../../../frontend/research-workspace/app.js", import.meta.url),
    contentType: "text/javascript; charset=utf-8",
  }],
  ["/api.js", {
    source: new URL("../../../frontend/research-workspace/api.js", import.meta.url),
    contentType: "text/javascript; charset=utf-8",
  }],
  ["/translations.js", {
    source: new URL("../../../frontend/research-workspace/translations.js", import.meta.url),
    contentType: "text/javascript; charset=utf-8",
  }],
  ["/styles.css", {
    source: new URL("../../../frontend/research-workspace/styles.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  }],
  ["/legacy.css", {
    source: new URL("../../../frontend/research-workspace/legacy.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  }],
  ["/variable-mapping.css", {
    source: new URL("../../../frontend/research-workspace/variable-mapping.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  }],
  ["/developer", { source: new URL("../../../frontend/research-workspace/developer.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/developer.js", { source: new URL("../../../frontend/research-workspace/developer.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/developer.css", { source: new URL("../../../frontend/research-workspace/developer.css", import.meta.url), contentType: "text/css; charset=utf-8" }],
  ["/developer/audit", { source: new URL("../../../frontend/research-workspace/audit.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/audit.js", { source: new URL("../../../frontend/research-workspace/audit.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
]);

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export const createResearchWorkspaceHttpServer = (
  service: ResearchDesignService,
  options: {
    maxBodyBytes?: number;
    workflow?: ResearchWorkflowService;
    executionDataSource?: DataSourceDescriptor;
    reportExports?: ReportExportService;
    analysisPlans?: ResearchAnalysisPlanService;
    systemStatus?: SystemStatusService;
    variableMappings?: StudyVariableMappingService;
    localRuns?: BrowserLocalRunService;
    runJobs?: BrowserLocalRunJobService;
    multiObjectiveJobs?: BrowserMultiObjectiveRunJobService;
    modelAudit?: ModelAuditQueryService;
  },
): Server => {
  const api = createResearchDesignHttpHandler(service, options);
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/v1/model-audit") {
      if (!options.modelAudit) {
        response.writeHead(503, { ...securityHeaders, "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: { code: "MODEL_AUDIT_UNAVAILABLE", message: "The model audit reader is unavailable." } }));
        return;
      }
      const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
      response.writeHead(200, { ...securityHeaders, "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(await options.modelAudit.list(Number.isFinite(requestedLimit) ? requestedLimit : 50)));
      return;
    }
    if (request.method === "GET" && (url.pathname === "/health/live" || url.pathname === "/health/ready")) {
      const report = options.systemStatus?.report() ?? { schema_version: "1.0.0", status: "ready", capabilities: [] };
      const live = url.pathname === "/health/live";
      response.writeHead(live || report.status === "ready" ? 200 : 503, { ...securityHeaders, "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(live ? { status: "live" } : report));
      return;
    }
    const asset = request.method === "GET" ? assets.get(url.pathname) : undefined;
    if (!asset) {
      await api(request, response);
      return;
    }
    try {
      const body = await readFile(asset.source);
      response.writeHead(200, { ...securityHeaders, "content-type": asset.contentType });
      response.end(body);
    } catch {
      response.writeHead(500, { ...securityHeaders, "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { code: "WORKSPACE_ASSET_UNAVAILABLE", message: "The workspace asset is unavailable." } }));
    }
  });
};
