import { readFile } from "node:fs/promises";
import {
  ClinicalDatabaseCatalogSnapshotService,
  FileClinicalDatabaseCatalogSnapshotRepository,
} from "../clinical-database/index.js";
import {
  EmbeddingAugmentedTerminologySearch,
  FileDictionaryEmbeddingIndexRepository,
  FileDrugClassRepository,
  FileVariableMappingPackRepository,
  OpenAiCompatibleTextEmbeddingClient,
  OpenAiCompatibleClinicalTermExpander,
  OpenAiCompatibleMappingCandidateReviewer,
  PsqlMimicTerminologySearchClient,
  LocalArchiveMimicTerminologySearchClient,
  LocalArchiveMappingEvidenceProfiler,
  SqliteVariableMappingRepository,
  StudyVariableMappingService,
  VariableMappingDiscoveryService,
  VariableMappingLifecycleService,
  VariableMappingPackService,
  VariableMappingVerificationService,
} from "../variable-mapping/index.js";
import { join } from "node:path";
import { DISCOVERY_RULES_VERSION } from "../variable-mapping/match-fidelity.js";
import { DefinitionPackRepository, DictionaryIndex, DRAFT_AUTHOR, IndexedEvidenceProfiler, nameKey, VariableDefinitionStore } from "../variable-definitions/index.js";
import type { BackendRuntimeConfig } from "./runtime-config.js";
import type { ProductPromptRegistry } from "./product-prompt-registry.js";
import type { GuardedPlannerSettings } from "./guarded-research-runtime.js";
import { MutableVariableMappingMimicCatalog } from "./variable-mapping-mimic-catalog.js";
import { RouterModelAvailabilityProbe } from "./router-availability-probe.js";

export const createConfiguredVariableMappingRuntime = async (input: {
  config: BackendRuntimeConfig;
  prompts: ProductPromptRegistry;
  planner?: GuardedPlannerSettings;
  localArchivePath?: string;
  profileEvidence?: boolean;
}) => {
  const repository = new SqliteVariableMappingRepository(input.config.storage.database_path);
  const embeddingSearch = input.config.variable_mapping.embedding_search;
  // Discoveries made with embedding search on are not reused with it off, and the reverse: switching drops them, as a rules change does.
  repository.invalidateDiscoveries(embeddingSearch.enabled ? `${DISCOVERY_RULES_VERSION}+embedding:${embeddingSearch.model}:${embeddingSearch.neighbours}` : DISCOVERY_RULES_VERSION);
  await new VariableMappingPackService({
    pack: new FileVariableMappingPackRepository(new URL("../../../config/mappings/mimic-iv-core.json", import.meta.url)),
    mappings: repository,
  }).seed();
  // Variable definitions (shared and workspace) are read as further packs, so a researcher's variable resolves like a built-in one.
  const dictionaryIndex = await DictionaryIndex.load(input.config.variable_definitions.dictionary_index_path).catch(() => undefined);
  const corePack = JSON.parse(await readFile(new URL("../../../config/mappings/mimic-iv-core.json", import.meta.url), "utf8")) as { mappings: Array<{ labels: { en: string; zh?: string }; synonyms: string[] }> };
  const sharedDefinitions = await new VariableDefinitionStore(input.config.variable_definitions.shared_directory).list();
  const packNames = new Set([...corePack.mappings.flatMap((entry) => [entry.labels.en, entry.labels.zh, ...entry.synonyms]), ...sharedDefinitions.flatMap((definition) => [definition.labels.en, definition.labels.zh, ...definition.synonyms])].filter((name): name is string => Boolean(name)).map(nameKey));
  const definitionIds = new Map<string, string[]>();
  const seedDefinitions = async (packId: "shared" | "workspace", directory: string): Promise<void> => {
    const definitionPack = new DefinitionPackRepository({ stores: [new VariableDefinitionStore(directory)], ...(dictionaryIndex ? { index: dictionaryIndex } : {}), packId: `variable-definitions-${packId}`,
      // A definition the platform drafted is dropped once the concept pack or the shared definitions name the same thing (the pack may have learnt it since).
      skip: (definition) => definition.author === DRAFT_AUTHOR && [definition.labels.en, definition.labels.zh, ...definition.synonyms].some((name) => name && packNames.has(nameKey(name))) });
    const seeding = new VariableMappingPackService({ pack: definitionPack, mappings: repository });
    await seeding.seed();
    // A definition deleted from its folder stops resolving: its stored mapping goes with it.
    definitionIds.set(packId, (await definitionPack.load()).mappings.map(({ mapping_id }) => mapping_id));
    if (definitionIds.size === 2) repository.dropVariableDefinitionsExcept([...definitionIds.values()].flat());
    // A changed definition keeps its old content until its version is raised; say so instead of silently using the old one.
    if (seeding.rejected.length) process.stderr.write(`Variable definitions not updated (raise their version): ${seeding.rejected.join(", ")}\n`);
  };
  await seedDefinitions("shared", input.config.variable_definitions.shared_directory);
  await seedDefinitions("workspace", input.config.variable_definitions.workspace_directory);
  let catalog;
  try {
    catalog = (await new ClinicalDatabaseCatalogSnapshotService(
      new FileClinicalDatabaseCatalogSnapshotRepository(input.config.clinical_database.catalog_snapshot_path),
    ).load()).catalog;
  } catch {
    catalog = undefined;
  }
  let mappingModel = input.planner?.model;
  if (input.planner?.api_key && input.planner.models?.length) {
    const candidates = [...new Set(input.planner.models)];
    const probe = new RouterModelAvailabilityProbe({
      base_url: input.planner.base_url,
      api_key: input.planner.api_key,
      timeout_ms: Math.min(5_000, input.config.research_design.model.timeout_ms),
    });
    const checks = await Promise.all(candidates.map(async (model) => {
      try { await probe.check(model); return model; } catch { return undefined; }
    }));
    mappingModel = checks.find((model): model is string => Boolean(model)) ?? input.planner.model;
  }
  const termExpander = input.planner ? new OpenAiCompatibleClinicalTermExpander({
    ...input.planner,
    model: mappingModel!,
    system_prompt: (await input.prompts.load({ id: "variable-mapping", version: "0.3.0" })).body,
    timeout_ms: input.config.research_design.model.timeout_ms,
    max_output_tokens: input.config.research_design.model.max_output_tokens,
  }) : undefined;
  const candidateReviewer = input.planner ? new OpenAiCompatibleMappingCandidateReviewer({
    ...input.planner,
    model: mappingModel!,
    system_prompt: (await input.prompts.load({ id: "mapping-evidence-review", version: "1.1.1" })).body,
    timeout_ms: input.config.research_design.model.timeout_ms,
    max_output_tokens: input.config.research_design.model.max_output_tokens,
  }) : undefined;
  const textTerminology = input.localArchivePath ? new LocalArchiveMimicTerminologySearchClient(input.localArchivePath, {
    cacheDirectory: join(input.config.clinical_database.local_evidence_cache_path, "terminology"),
  }) : input.config.clinical_database.enabled ? new PsqlMimicTerminologySearchClient({
    service: input.config.clinical_database.service,
    binary: input.config.clinical_database.psql_binary,
    connect_timeout_seconds: input.config.clinical_database.connect_timeout_seconds,
    statement_timeout_ms: input.config.clinical_database.statement_timeout_ms,
  }) : undefined;
  // Embedding retrieval only adds candidates after the text ones; an index that is switched on but missing is a configuration error.
  const embeddingIndex = textTerminology && embeddingSearch.enabled ? await new FileDictionaryEmbeddingIndexRepository(embeddingSearch.index_directory).load(embeddingSearch.model) : undefined;
  let embeddingWarned = false;
  const terminology = textTerminology && embeddingIndex ? new EmbeddingAugmentedTerminologySearch(textTerminology, embeddingIndex,
    new OpenAiCompatibleTextEmbeddingClient({ base_url: embeddingSearch.base_url, model: embeddingSearch.model, timeout_ms: embeddingSearch.timeout_ms }),
    { neighbours: embeddingSearch.neighbours, onUnavailable: () => { if (!embeddingWarned) process.stderr.write("Embedding search unavailable; text candidates only for the affected terms.\n"); embeddingWarned = true; } }) : textTerminology;
  const lifecycle = new VariableMappingLifecycleService(repository);
  const mimicCatalog = new MutableVariableMappingMimicCatalog();
  for (const mapping of await repository.listByStatus(["model_reviewed", "clinician_confirmed", "validated"])) mimicCatalog.register(mapping);
  const service = new StudyVariableMappingService({
    mappings: repository,
    lifecycle,
    discovery: new VariableMappingDiscoveryService({
      mappings: repository,
      drugClasses: await new FileDrugClassRepository(new URL("../../../config/drug-classes/drug-classes.json", import.meta.url)).load(),
      ...(terminology ? { terminology } : {}),
      ...(termExpander ? { termExpander } : {}),
      ...(catalog ? { catalog } : {}),
    }),
    ...(catalog ? { verification: new VariableMappingVerificationService(catalog) } : {}),
    ...(input.localArchivePath && input.profileEvidence !== false ? { evidenceProfiler: (() => {
      const scanning = new LocalArchiveMappingEvidenceProfiler(input.localArchivePath, {
        cacheDirectory: input.config.clinical_database.local_evidence_cache_path,
        maxOnlineScanBytes: input.config.clinical_database.local_evidence_max_member_bytes,
        scanTimeoutMs: input.config.clinical_database.local_evidence_scan_timeout_ms,
      });
      // The dictionary index answers the large tables (laboratory items, drug labels, codes) that the scan budget refuses.
      return dictionaryIndex ? new IndexedEvidenceProfiler(dictionaryIndex, scanning) : scanning;
    })() } : {}),
    ...(candidateReviewer ? { candidateReviewer } : {}),
    onExecutableMapping: (mapping) => mimicCatalog.register(mapping),
  });
  return {
    service,
    mimicCatalog,
    catalog,
    catalog_status: catalog ? "ready" as const : "unavailable" as const,
    live_search_status: terminology ? "ready" as const : "disabled" as const,
    embedding_search: embeddingIndex ? { model: embeddingIndex.model, entries: embeddingIndex.entries.length, neighbours: embeddingSearch.neighbours } : undefined,
    mapping_model: mappingModel,
    /** Reads the workspace definitions again, so one saved during a run resolves in the same run. */
    seed_workspace_definitions: async () => { await seedDefinitions("workspace", input.config.variable_definitions.workspace_directory); service.forgetAssessments(); },
    close: () => repository.close(),
  };
};
