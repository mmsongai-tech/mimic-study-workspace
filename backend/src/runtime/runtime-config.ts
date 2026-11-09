import { STUDY_TYPES, type StudyType } from "../study-framing/index.js";

export interface BackendRuntimeConfig {
  schema_version: 1;
  server: { host: string; port: number };
  storage: { database_path: string };
  clinical_database: {
    enabled: boolean;
    service: string;
    psql_binary: string;
    connect_timeout_seconds: number;
    statement_timeout_ms: number;
    catalog_snapshot_path: string;
    local_evidence_cache_path: string;
    local_evidence_scan_timeout_ms: number;
    local_evidence_max_member_bytes: number;
  };
  /** Variable definitions (docs/decisions/0009): the reviewed shared folder, the private workspace folder, and the dictionary index they are checked against. */
  variable_definitions: { shared_directory: string; workspace_directory: string; dictionary_index_path: string };
  /**
   * Embedding retrieval of dictionary candidates (off by default). When enabled, the labels nearest to a term's meaning are added
   * after the text-search candidates; every check after the search is unchanged. The index is built from the local MIMIC
   * dictionaries (backend/src/entrypoints/build-dictionary-embedding-index.ts) and stays under `.local/`.
   */
  variable_mapping: { embedding_search: { enabled: boolean; base_url: string; model: string; index_directory: string; neighbours: number; timeout_ms: number } };
  statistical_execution: {
    primary_runtime: "r";
    rscript_binary: string;
    timeout_ms: number;
  };
  report_exports: {
    python_binary: string;
    timeout_ms: number;
  };
  generated_analysis: {
    enabled: boolean;
    sandbox: "macos_sandbox";
    python_binary: string;
    rscript_binary: string;
    wall_timeout_ms: number;
    cpu_time_seconds: number;
    memory_limit_mb: number;
    max_source_bytes: number;
    max_input_bytes: number;
    max_output_bytes: number;
    allowed_python_packages: string[];
    allowed_r_packages: string[];
  };
  /**
   * The kinds of question this release accepts, as study types. A framed aim of any other type is not planned; it is
   * reported among the unanswered aims with the reason, and the rest of the question is analysed as usual.
   */
  question_scope: { allowed_study_types: StudyType[] };
  research_design: {
    prompt: { id: string; version: string };
    local: {
      enabled: boolean;
      profile: string;
      base_url: string;
    };
    /**
     * An optional OpenAI-compatible model router, used only by the router entry points. There is deliberately no default host:
     * the platform runs on a local model, and a router must be named in the environment (OPENROUTER_BASE_URL) to be used at all.
     */
    router: { base_url: string | null };
    model: {
      profile: string;
      timeout_ms: number;
      max_output_tokens: number;
      retry_max_attempts: number;
      retry_backoff_ms: number;
    };
    limits: {
      max_request_chars: number;
      max_answers: number;
      max_patch_operations: number;
    };
    supported_study_spec_versions: string[];
    retention: { max_revisions: number };
    idempotency: { request_claim_ttl_ms: number };
  };
}

type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends Array<infer Item>
    ? Item[]
    : T[Key] extends object
      ? DeepPartial<T[Key]>
      : T[Key];
};

export type BackendRuntimeConfigLayer = DeepPartial<BackendRuntimeConfig>;

export class RuntimeConfigError extends Error {
  constructor(public readonly details: string[]) {
    super("The backend runtime configuration is invalid.");
    this.name = "RuntimeConfigError";
  }
}

const defaults: BackendRuntimeConfig = {
  schema_version: 1,
  server: { host: "127.0.0.1", port: 3000 },
  storage: { database_path: "./mimic-research-agent-platform.sqlite" },
  clinical_database: {
    enabled: false,
    service: "mimic-iv",
    psql_binary: "psql",
    connect_timeout_seconds: 5,
    statement_timeout_ms: 5_000,
    catalog_snapshot_path: "./config/mimic-iv-catalog/mimic-iv-catalog.snapshot.json",
    local_evidence_cache_path: "./.local/mapping-evidence-cache",
    local_evidence_scan_timeout_ms: 300_000,
    local_evidence_max_member_bytes: 750_000_000,
  },
  variable_definitions: { shared_directory: "./config/variables", workspace_directory: "./.local/variables", dictionary_index_path: "./.local/dictionary-index.json" },
  variable_mapping: { embedding_search: { enabled: false, base_url: "http://127.0.0.1:11434/v1", model: "bge-m3", index_directory: "./.local/dictionary-embeddings/bge-m3", neighbours: 10, timeout_ms: 30_000 } },
  statistical_execution: { primary_runtime: "r", rscript_binary: "Rscript", timeout_ms: 30_000 },
  report_exports: { python_binary: "python3", timeout_ms: 60_000 },
  generated_analysis: {
    enabled: false,
    sandbox: "macos_sandbox",
    python_binary: "python3",
    rscript_binary: "Rscript",
    wall_timeout_ms: 60_000,
    cpu_time_seconds: 30,
    memory_limit_mb: 2_048,
    max_source_bytes: 50_000,
    max_input_bytes: 50_000_000,
    max_output_bytes: 2_000_000,
    allowed_python_packages: ["json", "sys", "math", "statistics", "csv", "numpy", "pandas", "scipy", "statsmodels", "sklearn", "lifelines"],
    allowed_r_packages: ["jsonlite", "stats", "survival", "splines", "boot", "MASS"],
  },
  // Pilot 1: dose-response, effect modification (subgroup or sex changing the effect) and mediation are left out.
  question_scope: { allowed_study_types: ["descriptive", "group_comparison", "association", "treatment_effect", "time_to_event", "longitudinal_change", "prediction"] },
  research_design: {
    prompt: { id: "research-design", version: "0.8.8" },
    local: {
      enabled: false,
      profile: "disabled",
      base_url: "http://127.0.0.1:11434/v1",
    },
    router: { base_url: null },
    model: {
      profile: "disabled",
      timeout_ms: 30_000,
      max_output_tokens: 4_000,
      retry_max_attempts: 3,
      retry_backoff_ms: 250,
    },
    limits: {
      max_request_chars: 12_000,
      max_answers: 50,
      max_patch_operations: 100,
    },
    supported_study_spec_versions: ["1.0.0"],
    retention: { max_revisions: 100 },
    idempotency: { request_claim_ttl_ms: 30_000 },
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const merge = (base: unknown, layer: unknown): unknown => {
  if (!isRecord(base) || !isRecord(layer)) return layer;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    result[key] = key in result ? merge(result[key], value) : value;
  }
  return result;
};

const exactKeys = (
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
  errors: string[],
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not supported`);
  }
};

const requireRecord = (
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> => {
  if (isRecord(value)) return value;
  errors.push(`${path} must be an object`);
  return {};
};

const requireString = (value: unknown, path: string, errors: string[]): void => {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    errors.push(`${path} must be a non-empty string of at most 128 characters`);
  }
};

const requirePositiveInteger = (value: unknown, path: string, errors: string[]): void => {
  if (!Number.isInteger(value) || (value as number) < 1) errors.push(`${path} must be a positive integer`);
};

const validate = (value: unknown): BackendRuntimeConfig => {
  const errors: string[] = [];
  const root = requireRecord(value, "config", errors);
  exactKeys(root, ["schema_version", "server", "storage", "clinical_database", "variable_definitions", "variable_mapping", "statistical_execution", "report_exports", "generated_analysis", "question_scope", "research_design"], "config", errors);
  if (root.schema_version !== 1) errors.push("config.schema_version must equal 1");

  const server = requireRecord(root.server, "config.server", errors);
  exactKeys(server, ["host", "port"], "config.server", errors);
  requireString(server.host, "config.server.host", errors);
  requirePositiveInteger(server.port, "config.server.port", errors);
  if (typeof server.port === "number" && server.port > 65_535) {
    errors.push("config.server.port must be at most 65535");
  }

  const storage = requireRecord(root.storage, "config.storage", errors);
  exactKeys(storage, ["database_path"], "config.storage", errors);
  requireString(storage.database_path, "config.storage.database_path", errors);

  const clinicalDatabase = requireRecord(root.clinical_database, "config.clinical_database", errors);
  exactKeys(clinicalDatabase, ["enabled", "service", "psql_binary", "connect_timeout_seconds", "statement_timeout_ms", "catalog_snapshot_path", "local_evidence_cache_path", "local_evidence_scan_timeout_ms", "local_evidence_max_member_bytes"], "config.clinical_database", errors);
  if (typeof clinicalDatabase.enabled !== "boolean") errors.push("config.clinical_database.enabled must be a boolean");
  requireString(clinicalDatabase.service, "config.clinical_database.service", errors);
  requireString(clinicalDatabase.psql_binary, "config.clinical_database.psql_binary", errors);
  requirePositiveInteger(clinicalDatabase.connect_timeout_seconds, "config.clinical_database.connect_timeout_seconds", errors);
  requirePositiveInteger(clinicalDatabase.statement_timeout_ms, "config.clinical_database.statement_timeout_ms", errors);
  requireString(clinicalDatabase.catalog_snapshot_path, "config.clinical_database.catalog_snapshot_path", errors);
  requireString(clinicalDatabase.local_evidence_cache_path, "config.clinical_database.local_evidence_cache_path", errors);
  requirePositiveInteger(clinicalDatabase.local_evidence_scan_timeout_ms, "config.clinical_database.local_evidence_scan_timeout_ms", errors);
  requirePositiveInteger(clinicalDatabase.local_evidence_max_member_bytes, "config.clinical_database.local_evidence_max_member_bytes", errors);

  const variableDefinitions = requireRecord(root.variable_definitions, "config.variable_definitions", errors);
  exactKeys(variableDefinitions, ["shared_directory", "workspace_directory", "dictionary_index_path"], "config.variable_definitions", errors);
  for (const key of ["shared_directory", "workspace_directory", "dictionary_index_path"] as const) requireString(variableDefinitions[key], `config.variable_definitions.${key}`, errors);

  const variableMapping = requireRecord(root.variable_mapping, "config.variable_mapping", errors);
  exactKeys(variableMapping, ["embedding_search"], "config.variable_mapping", errors);
  const embeddingSearch = requireRecord(variableMapping.embedding_search, "config.variable_mapping.embedding_search", errors);
  exactKeys(embeddingSearch, ["enabled", "base_url", "model", "index_directory", "neighbours", "timeout_ms"], "config.variable_mapping.embedding_search", errors);
  if (typeof embeddingSearch.enabled !== "boolean") errors.push("config.variable_mapping.embedding_search.enabled must be a boolean");
  for (const key of ["base_url", "model", "index_directory"] as const) requireString(embeddingSearch[key], `config.variable_mapping.embedding_search.${key}`, errors);
  requirePositiveInteger(embeddingSearch.neighbours, "config.variable_mapping.embedding_search.neighbours", errors);
  if (typeof embeddingSearch.neighbours === "number" && embeddingSearch.neighbours > 50) errors.push("config.variable_mapping.embedding_search.neighbours must be at most 50");
  requirePositiveInteger(embeddingSearch.timeout_ms, "config.variable_mapping.embedding_search.timeout_ms", errors);

  const statisticalExecution = requireRecord(root.statistical_execution, "config.statistical_execution", errors);
  exactKeys(
    statisticalExecution,
    ["primary_runtime", "rscript_binary", "timeout_ms"],
    "config.statistical_execution",
    errors,
  );
  if (statisticalExecution.primary_runtime !== "r") {
    errors.push("config.statistical_execution.primary_runtime must equal r");
  }
  requireString(statisticalExecution.rscript_binary, "config.statistical_execution.rscript_binary", errors);
  requirePositiveInteger(statisticalExecution.timeout_ms, "config.statistical_execution.timeout_ms", errors);

  const reportExports = requireRecord(root.report_exports, "config.report_exports", errors);
  exactKeys(reportExports, ["python_binary", "timeout_ms"], "config.report_exports", errors);
  requireString(reportExports.python_binary, "config.report_exports.python_binary", errors);
  requirePositiveInteger(reportExports.timeout_ms, "config.report_exports.timeout_ms", errors);

  const generatedAnalysis = requireRecord(root.generated_analysis, "config.generated_analysis", errors);
  exactKeys(generatedAnalysis, [
    "enabled", "sandbox", "python_binary", "rscript_binary", "wall_timeout_ms", "cpu_time_seconds",
    "memory_limit_mb", "max_source_bytes", "max_input_bytes", "max_output_bytes",
    "allowed_python_packages", "allowed_r_packages",
  ], "config.generated_analysis", errors);
  if (typeof generatedAnalysis.enabled !== "boolean") errors.push("config.generated_analysis.enabled must be a boolean");
  if (generatedAnalysis.sandbox !== "macos_sandbox") errors.push("config.generated_analysis.sandbox must equal macos_sandbox");
  requireString(generatedAnalysis.python_binary, "config.generated_analysis.python_binary", errors);
  requireString(generatedAnalysis.rscript_binary, "config.generated_analysis.rscript_binary", errors);
  for (const key of ["wall_timeout_ms", "cpu_time_seconds", "memory_limit_mb", "max_source_bytes", "max_input_bytes", "max_output_bytes"] as const) {
    requirePositiveInteger(generatedAnalysis[key], `config.generated_analysis.${key}`, errors);
  }
  for (const key of ["allowed_python_packages", "allowed_r_packages"] as const) {
    const packages = generatedAnalysis[key];
    if (!Array.isArray(packages)) errors.push(`config.generated_analysis.${key} must be an array`);
    else packages.forEach((value, index) => requireString(value, `config.generated_analysis.${key}[${index}]`, errors));
  }

  const questionScope = requireRecord(root.question_scope, "config.question_scope", errors);
  exactKeys(questionScope, ["allowed_study_types"], "config.question_scope", errors);
  const allowedTypes = questionScope.allowed_study_types;
  if (!Array.isArray(allowedTypes) || allowedTypes.length === 0) errors.push("config.question_scope.allowed_study_types must be a non-empty array");
  else {
    allowedTypes.forEach((type, index) => {
      if (!(STUDY_TYPES as readonly unknown[]).includes(type)) errors.push(`config.question_scope.allowed_study_types[${index}] must be one of ${STUDY_TYPES.join(", ")}`);
    });
    if (new Set(allowedTypes).size !== allowedTypes.length) errors.push("config.question_scope.allowed_study_types must not repeat a study type");
  }

  const researchDesign = requireRecord(root.research_design, "config.research_design", errors);
  exactKeys(
    researchDesign,
    ["prompt", "local", "router", "model", "limits", "supported_study_spec_versions", "retention", "idempotency"],
    "config.research_design",
    errors,
  );

  const prompt = requireRecord(researchDesign.prompt, "config.research_design.prompt", errors);
  exactKeys(prompt, ["id", "version"], "config.research_design.prompt", errors);
  requireString(prompt.id, "config.research_design.prompt.id", errors);
  requireString(prompt.version, "config.research_design.prompt.version", errors);

  const local = requireRecord(researchDesign.local, "config.research_design.local", errors);
  exactKeys(local, ["enabled", "profile", "base_url"], "config.research_design.local", errors);
  if (typeof local.enabled !== "boolean") errors.push("config.research_design.local.enabled must be a boolean");
  requireString(local.profile, "config.research_design.local.profile", errors);
  requireString(local.base_url, "config.research_design.local.base_url", errors);

  const router = requireRecord(researchDesign.router, "config.research_design.router", errors);
  exactKeys(router, ["base_url"], "config.research_design.router", errors);
  if (router.base_url !== null) {
    requireString(router.base_url, "config.research_design.router.base_url", errors);
    if (typeof router.base_url === "string" && !/^https?:\/\/[^\s/]+/u.test(router.base_url)) errors.push("config.research_design.router.base_url must be an http(s) URL or null");
  }

  const model = requireRecord(researchDesign.model, "config.research_design.model", errors);
  exactKeys(
    model,
    ["profile", "timeout_ms", "max_output_tokens", "retry_max_attempts", "retry_backoff_ms"],
    "config.research_design.model",
    errors,
  );
  requireString(model.profile, "config.research_design.model.profile", errors);
  requirePositiveInteger(model.timeout_ms, "config.research_design.model.timeout_ms", errors);
  requirePositiveInteger(model.max_output_tokens, "config.research_design.model.max_output_tokens", errors);
  requirePositiveInteger(
    model.retry_max_attempts,
    "config.research_design.model.retry_max_attempts",
    errors,
  );
  requirePositiveInteger(
    model.retry_backoff_ms,
    "config.research_design.model.retry_backoff_ms",
    errors,
  );

  const limits = requireRecord(researchDesign.limits, "config.research_design.limits", errors);
  exactKeys(
    limits,
    ["max_request_chars", "max_answers", "max_patch_operations"],
    "config.research_design.limits",
    errors,
  );
  requirePositiveInteger(limits.max_request_chars, "config.research_design.limits.max_request_chars", errors);
  requirePositiveInteger(limits.max_answers, "config.research_design.limits.max_answers", errors);
  requirePositiveInteger(limits.max_patch_operations, "config.research_design.limits.max_patch_operations", errors);

  const versions = researchDesign.supported_study_spec_versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    errors.push("config.research_design.supported_study_spec_versions must be a non-empty array");
  } else {
    versions.forEach((version, index) =>
      requireString(version, `config.research_design.supported_study_spec_versions[${index}]`, errors));
  }

  const retention = requireRecord(researchDesign.retention, "config.research_design.retention", errors);
  exactKeys(retention, ["max_revisions"], "config.research_design.retention", errors);
  requirePositiveInteger(retention.max_revisions, "config.research_design.retention.max_revisions", errors);

  const idempotency = requireRecord(researchDesign.idempotency, "config.research_design.idempotency", errors);
  exactKeys(idempotency, ["request_claim_ttl_ms"], "config.research_design.idempotency", errors);
  requirePositiveInteger(
    idempotency.request_claim_ttl_ms,
    "config.research_design.idempotency.request_claim_ttl_ms",
    errors,
  );

  if (errors.length) throw new RuntimeConfigError(errors);
  return structuredClone(value) as BackendRuntimeConfig;
};

export const resolveBackendRuntimeConfig = (layers: {
  versioned?: BackendRuntimeConfigLayer;
  environment?: BackendRuntimeConfigLayer;
  cli?: BackendRuntimeConfigLayer;
} = {}): BackendRuntimeConfig => {
  const merged = [layers.versioned, layers.environment, layers.cli]
    .filter((layer): layer is BackendRuntimeConfigLayer => layer !== undefined)
    .reduce<unknown>((current, layer) => merge(current, layer), defaults);
  return validate(merged);
};

export class RouterNotConfiguredError extends Error {
  constructor() {
    super("No model router is configured: set OPENROUTER_BASE_URL to the router's OpenAI-compatible /v1 address. There is no default router; the platform itself runs on a local model.");
    this.name = "RouterNotConfiguredError";
  }
}

/** The configured router address, or a clear error when none is set (config.research_design.router.base_url has no default). */
export const requireRouterBaseUrl = (config: BackendRuntimeConfig): string => {
  const baseUrl = config.research_design.router.base_url;
  if (baseUrl === null) throw new RouterNotConfiguredError();
  return baseUrl;
};

/**
 * The environment layer for the router address: OPENROUTER_BASE_URL when set; when it is unset or blank the layer is empty, so an
 * address from a lower layer (the versioned file) is kept and there is still no default host.
 */
export const routerEnvironmentLayer = (environment: NodeJS.ProcessEnv): { router?: { base_url: string } } => {
  const baseUrl = environment.OPENROUTER_BASE_URL?.trim();
  return baseUrl ? { router: { base_url: baseUrl } } : {};
};
