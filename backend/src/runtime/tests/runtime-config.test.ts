import assert from "node:assert/strict";
import test from "node:test";
import { requireRouterBaseUrl, resolveBackendRuntimeConfig, RouterNotConfiguredError, routerEnvironmentLayer, RuntimeConfigError } from "../index.js";

test("resolves safe defaults through the typed configuration entry point", () => {
  const config = resolveBackendRuntimeConfig();

  assert.equal(config.schema_version, 1);
  assert.deepEqual(config.server, { host: "127.0.0.1", port: 3000 });
  assert.equal(config.storage.database_path, "./mimic-research-agent-platform.sqlite");
  assert.deepEqual(config.clinical_database, {
    enabled: false,
    service: "mimic-iv",
    psql_binary: "psql",
    connect_timeout_seconds: 5,
    statement_timeout_ms: 5_000,
    catalog_snapshot_path: "./config/mimic-iv-catalog/mimic-iv-catalog.snapshot.json",
    local_evidence_cache_path: "./.local/mapping-evidence-cache",
    local_evidence_scan_timeout_ms: 300_000,
    local_evidence_max_member_bytes: 750_000_000,
  });
  assert.deepEqual(config.variable_definitions, { shared_directory: "./config/variables", workspace_directory: "./.local/variables", dictionary_index_path: "./.local/dictionary-index.json" });
  // Embedding retrieval of dictionary candidates is off unless a deployment turns it on.
  assert.deepEqual(config.variable_mapping, { embedding_search: { enabled: false, base_url: "http://127.0.0.1:11434/v1", model: "bge-m3", index_directory: "./.local/dictionary-embeddings/bge-m3", neighbours: 10, timeout_ms: 30_000 } });
  assert.deepEqual(config.statistical_execution, {
    primary_runtime: "r",
    rscript_binary: "Rscript",
    timeout_ms: 30_000,
  });
  assert.deepEqual(config.report_exports, { python_binary: "python3", timeout_ms: 60_000 });
  assert.equal(config.generated_analysis.enabled, false);
  assert.equal(config.generated_analysis.sandbox, "macos_sandbox");
  assert.deepEqual(config.research_design.prompt, { id: "research-design", version: "0.8.8" });
  assert.equal(config.research_design.model.profile, "disabled");
  assert.equal(config.research_design.model.max_output_tokens, 4_000);
});

test("applies versioned, environment, and command-line precedence", () => {
  const config = resolveBackendRuntimeConfig({
    versioned: { research_design: { model: { profile: "versioned", timeout_ms: 20_000 } } },
    environment: { research_design: { model: { profile: "environment" } } },
    cli: { research_design: { model: { profile: "cli" } } },
  });

  assert.equal(config.research_design.model.profile, "cli");
  assert.equal(config.research_design.model.timeout_ms, 20_000);

  const runtime = resolveBackendRuntimeConfig({
    versioned: { server: { port: 3001 } },
    environment: { server: { port: 3002 } },
    cli: { server: { port: 3003 }, storage: { database_path: "/tmp/mimic-test.sqlite" } },
  });
  assert.equal(runtime.server.port, 3003);
  assert.equal(runtime.storage.database_path, "/tmp/mimic-test.sqlite");
});

test("rejects unknown or invalid runtime configuration", () => {
  assert.throws(
    () => resolveBackendRuntimeConfig({ cli: { research_design: { model: { timeout_ms: 0 } } } }),
    (error: unknown) => error instanceof RuntimeConfigError,
  );
  assert.throws(
    () => resolveBackendRuntimeConfig({ cli: { research_design: { model: { max_output_tokens: 0 } } } }),
    (error: unknown) => error instanceof RuntimeConfigError,
  );
  assert.throws(
    () => resolveBackendRuntimeConfig({ cli: { research_design: { unsupported: true } } as never }),
    (error: unknown) =>
      error instanceof RuntimeConfigError &&
      error.details.some((detail) => detail.includes("unsupported")),
  );
});

test("embedding search is a typed, validated switch", () => {
  const enabled = resolveBackendRuntimeConfig({ environment: { variable_mapping: { embedding_search: { enabled: true } } } });
  assert.equal(enabled.variable_mapping.embedding_search.enabled, true);
  assert.equal(enabled.variable_mapping.embedding_search.model, "bge-m3");
  for (const invalid of [{ enabled: "yes" }, { neighbours: 0 }, { neighbours: 51 }, { timeout_ms: -1 }, { model: "" }, { unknown: 1 }]) {
    assert.throws(() => resolveBackendRuntimeConfig({ cli: { variable_mapping: { embedding_search: invalid } } as never }), (error: unknown) => error instanceof RuntimeConfigError, JSON.stringify(invalid));
  }
});

test("the model router has no default address and fails clearly when it is needed but not configured", () => {
  const config = resolveBackendRuntimeConfig();
  assert.equal(config.research_design.router.base_url, null);
  assert.throws(() => requireRouterBaseUrl(config), (error: unknown) => error instanceof RouterNotConfiguredError && /OPENROUTER_BASE_URL/u.test(error.message));
  // An empty, blank or missing variable is the same as unset: the layer is empty and keeps an address from a lower layer.
  for (const environment of [{ OPENROUTER_BASE_URL: "" }, { OPENROUTER_BASE_URL: "   " }, {}]) {
    assert.deepEqual(routerEnvironmentLayer(environment), {});
    const blank = resolveBackendRuntimeConfig({ environment: { research_design: routerEnvironmentLayer(environment) } });
    assert.throws(() => requireRouterBaseUrl(blank), RouterNotConfiguredError);
    const versioned = resolveBackendRuntimeConfig({
      versioned: { research_design: { router: { base_url: "https://versioned.example.test/v1" } } },
      environment: { research_design: routerEnvironmentLayer(environment) },
    });
    assert.equal(requireRouterBaseUrl(versioned), "https://versioned.example.test/v1");
  }
  const configured = resolveBackendRuntimeConfig({ environment: { research_design: { model: { profile: "example" }, ...routerEnvironmentLayer({ OPENROUTER_BASE_URL: " https://router.example.test/v1 " }) } } });
  assert.equal(requireRouterBaseUrl(configured), "https://router.example.test/v1");
  assert.equal(configured.research_design.model.profile, "example");
  for (const invalid of [{ base_url: "router.example.test" }, { base_url: 3 }, { base_url: "" }, { unknown: 1 }]) {
    assert.throws(() => resolveBackendRuntimeConfig({ cli: { research_design: { router: invalid } } as never }), (error: unknown) => error instanceof RuntimeConfigError, JSON.stringify(invalid));
  }
});

test("the question scope allows every study type except dose-response, effect modification and mediation by default, and checks the names", () => {
  assert.deepEqual(resolveBackendRuntimeConfig().question_scope.allowed_study_types, ["descriptive", "group_comparison", "association", "treatment_effect", "time_to_event", "longitudinal_change", "prediction"]);
  assert.deepEqual(resolveBackendRuntimeConfig({ cli: { question_scope: { allowed_study_types: ["mediation"] } } }).question_scope.allowed_study_types, ["mediation"]);
  for (const invalid of [[], ["subgroup"], ["prediction", "prediction"]]) {
    assert.throws(() => resolveBackendRuntimeConfig({ cli: { question_scope: { allowed_study_types: invalid } } as never }),
      (error: unknown) => error instanceof RuntimeConfigError && error.details.some((detail) => detail.startsWith("config.question_scope.allowed_study_types")), JSON.stringify(invalid));
  }
});
