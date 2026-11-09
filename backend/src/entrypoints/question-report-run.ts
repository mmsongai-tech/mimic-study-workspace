import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { diagnosisFingerprint, LocalExecutionGraphRunner } from "../clinical-data/index.js";
import { CLARIFY_POLICIES, FileReadingCatalogRepository, type ClarifyPolicy } from "../question-clarification/index.js";
import { assessFrame, assessOutcomeComponents, FileLimitationKnowledgeBaseRepository, limitationSentences, matchLimitations } from "../mimic-limitations/index.js";
import { OpenAiCompatibleStructuredChatClient } from "../model-output/index.js";
import { QuestionPipelineService, type LockedQuestionPlan, type PlanOptionChoice } from "../question-pipeline/index.js";
import { DictionaryIndex, proposeDiagnosisDefinition, proposeDrugDefinition, proposeItemDefinition, VariableDefinitionService, type SynonymTable, VariableDefinitionStore, loadFormulaCatalog, type ProposedDefinition } from "../variable-definitions/index.js";
import { createConfiguredVariableMappingRuntime, createRepositoryProductPromptRegistry, resolveBackendRuntimeConfig } from "../runtime/index.js";
import { RStudyMethodExecutor } from "../study-analysis/index.js";
import { buildConceptFinder, CachedSlotNormalizer, drugNamesIn, populationConcepts, JsonFileNormalizationStore, StudyFramingService, unaccountedConcepts, type NamedConcept } from "../study-framing/index.js";
import { writeQuestionReports } from "../study-report/index.js";
import { FileResultCheckRulesRepository } from "../result-checks/index.js";
import { RunProgressFile } from "../question-workspace/index.js";
import { FileDrugClassRepository, ingredientFor, matchDrugClass, OpenAiCompatibleClinicalTermExpander, TERM_EXPANSION_RULES_VERSION } from "../variable-mapping/index.js";
import { FROZEN_ACCEPTANCE_QUESTIONS } from "./frozen-acceptance-questions.js";

/** Every clinical concept a question can name: the pack's diagnoses, measurements, drugs and scores and the drug catalogue's classes and ingredients. */
const namedConcepts = async (drugClasses: Awaited<ReturnType<FileDrugClassRepository["load"]>>): Promise<NamedConcept[]> => {
  const pack = JSON.parse(await readFile(new URL("../../../config/mappings/mimic-iv-core.json", import.meta.url), "utf8")) as { mappings: Array<{ concept_id: string; category: string; value_type?: string; labels: { en: string; zh: string }; synonyms: string[] }> };
  const kinds = new Set(["diagnosis", "medication", "laboratory", "vital_sign", "intervention", "score", "outcome"]);
  // A yes/no property of the admission (discharged alive, emergency admission) can define who is studied; the ICU stay and the admission themselves are not conditions.
  const attribute = (entry: { category: string; value_type?: string }): boolean => entry.category === "encounter" && entry.value_type === "binary";
  const fromPack = pack.mappings.filter((entry) => (kinds.has(entry.category) || attribute(entry)) && !/^(readmission_|history_of_)/u.test(entry.concept_id)).map((entry) => ({ id: entry.concept_id, label: entry.labels.en, names: [entry.labels.zh, ...entry.synonyms], category: attribute(entry) ? "attribute" : entry.category }));
  const fromClasses = drugClasses.classes.map((item) => ({ id: `class:${item.class_id}`, label: item.labels.en, names: [item.labels.zh, ...item.synonyms], category: "medication" }));
  const ingredients = [...new Set(drugClasses.classes.flatMap((item) => item.ingredients))].map((name) => ({ id: `drug:${name}`, label: name, names: drugClasses.ingredient_names?.[name] ?? [], category: "medication" }));
  // Variables defined by the team or a researcher are named concepts too (ratios and formulas are read by the framing, not listed here).
  const config = resolveBackendRuntimeConfig();
  const defined = (await Promise.all([config.variable_definitions.shared_directory, config.variable_definitions.workspace_directory].map((directory) => new VariableDefinitionStore(directory).list()))).flat()
    .filter((definition) => definition.kind !== "ratio" && definition.kind !== "formula")
    .map((definition) => ({ id: definition.definition_id, label: definition.labels.en, names: [...(definition.labels.zh ? [definition.labels.zh] : []), ...definition.synonyms], category: ({ lab_or_chart: "laboratory", drug: "medication", diagnosis: "diagnosis", procedure_or_event: "intervention" } as Record<string, string>)[definition.kind] ?? "intervention" }));
  return [...fromPack, ...fromClasses, ...ingredients, ...defined];
};

/** The derived layer must come from the diagnosis definitions in use; this is what the platform expects it to record. */
const currentLayer = async (): Promise<{ fingerprint: string; items: number[] }> => {
  const read = async <T>(path: string): Promise<T> => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as T;
  const pack = await read<{ mappings: Array<{ concept_id: string; sources: Array<{ kind: string; schema?: string; item_ids?: number[]; codes?: Array<{ code: string; version: number }> }> }> }>("../../../config/mappings/mimic-iv-core.json");
  const { order } = await read<{ order: string[] }>("../../../config/derived/diagnosis-order.json");
  const fingerprint = diagnosisFingerprint(order, pack.mappings.filter((entry) => entry.sources[0]?.kind === "diagnosis_code" && entry.sources[0].codes?.length).map((entry) => ({ concept_id: entry.concept_id, codes: entry.sources[0]!.codes! })));
  const items = [...new Set(pack.mappings.filter((entry) => entry.sources[0]?.schema === "mimiciv_derived").flatMap((entry) => entry.sources[0]!.item_ids ?? []))].sort((a, b) => a - b);
  return { fingerprint, items };
};

// Runs one research question end to end on the local MIMIC-IV archive with a local model and writes bilingual reports.
// Usage: MIMIC_LOCAL_ARCHIVE=/path/mimic-iv-3.1.zip node --import tsx backend/src/entrypoints/question-report-run.ts
//          (--question "..." | --formal 1-4 | --case lit-xx-01 | --from-run DIR) [--model M] [--out DIR] [--method METHOD_ID]
//          [--methods '{"f1":"treatment.psm"}'] [--options '{"f1":{"landmark":false,"severity_on":["Creatinine"]}}']
// --from-run reuses the saved framing of an earlier run (no model call for framing), e.g. to re-analyse with other
//   methods or design options (a plan without an --options entry keeps its own design defaults, same as a first run).
// --draft writes <out>/plan-draft.json (framing, mapping, frozen manifests, protocol, method options) and reads no
//   patient data; --locked FILE runs a confirmed locked plan (no model call, no re-mapping) and writes the reports.
// Progress is printed as "PROGRESS <json>" lines for the workspace server.

const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };

const main = async (): Promise<void> => {
  const archivePath = argument("--archive") ?? process.env.MIMIC_LOCAL_ARCHIVE;
  if (!archivePath) throw new Error("Set MIMIC_LOCAL_ARCHIVE or pass --archive; there is no synthetic fallback.");
  const model = argument("--model") ?? process.env.MIMIC_LOCAL_MODEL_PROFILE ?? "qwen2.5:7b-instruct-q4_K_M";
  const baseUrl = process.env.MIMIC_LOCAL_MODEL_BASE_URL || "http://127.0.0.1:11434/v1";
  const caseId = argument("--case");
  const fromRun = argument("--from-run");
  const savedFrames = fromRun ? (JSON.parse(await readFile(join(fromRun, "run.json"), "utf8")) as { frame_set: import("../study-framing/index.js").StudyFrameSet }).frame_set : undefined;
  const lockedFile = argument("--locked");
  const locked = lockedFile ? JSON.parse(await readFile(lockedFile, "utf8")) as LockedQuestionPlan : undefined;
  const draftOnly = process.argv.includes("--draft");
  const formal = argument("--formal");
  const question = locked?.draft.question ?? savedFrames?.original_question ?? argument("--question")
    ?? (formal ? FROZEN_ACCEPTANCE_QUESTIONS[Number(formal) - 1] : undefined)
    ?? (caseId ? (JSON.parse(await readFile(new URL("../validation-fixtures/literature-benchmark/cases.json", import.meta.url), "utf8")) as Array<{ id: string; question_zh: string }>).find(({ id }) => id === caseId)?.question_zh : undefined);
  if (!question) throw new Error("Pass --question, --formal 1-4, --case with a literature benchmark id, or --from-run.");
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "");
  const outDir = argument("--out") ?? join(".local", "question-runs", `${stamp}-${caseId ?? (formal ? `formal-${formal}` : "question")}`);
  await mkdir(outDir, { recursive: true });

  // A fresh checkout has no .local folder; the mapping store and the normalisation cache live there.
  await mkdir(join(".local", "question-runs"), { recursive: true });
  // MIMIC_EMBEDDING_SEARCH=1 turns on embedding retrieval of dictionary candidates (an evaluation switch; off by default).
  const embeddingSearch = process.env.MIMIC_EMBEDDING_SEARCH === "1";
  const config = resolveBackendRuntimeConfig({ environment: { storage: { database_path: join(".local", "question-runs", "mapping.sqlite") }, research_design: { model: { profile: model, timeout_ms: 300_000 } },
    ...(embeddingSearch ? { variable_mapping: { embedding_search: { enabled: true, base_url: baseUrl } } } : {}) } });
  const prompts = createRepositoryProductPromptRegistry();
  const [split, extraction, extractionEn, mappingPrompt] = await Promise.all([
    prompts.load({ id: "study-question-split", version: "1.0.0" }),
    prompts.load({ id: "study-frame-extraction", version: "1.0.0" }),
    prompts.load({ id: "study-frame-extraction-en", version: "1.0.0" }),
    prompts.load({ id: "variable-mapping", version: "0.3.0" }),
  ]);
  const client = new OpenAiCompatibleStructuredChatClient({ provider: "local", base_url: baseUrl, model, timeout_ms: 300_000 });
  const expander = new OpenAiCompatibleClinicalTermExpander({ base_url: baseUrl, model, system_prompt: mappingPrompt.body, timeout_ms: 300_000, max_output_tokens: 400, temperature: 0 });
  // Normalizations are cached per phrase, model and prompt version so re-runs search the same MIMIC concepts.
  const normalizer = new CachedSlotNormalizer(
    { normalize: async ({ text, role }) => { const result = await expander.expand({ term: text, role }); return { label_en: result.normalized_label_en, category: result.category }; } },
    new JsonFileNormalizationStore(join(".local", "question-runs", "normalization-cache.json")),
    `${model}|variable-mapping@${mappingPrompt.version}|rules@${TERM_EXPANSION_RULES_VERSION}`,
  );
  // A phrase that names a drug class in the catalog ("SAMA", "β2受体激动剂", "ARB") is normalised to that class by rule, not by the
  // small model, which has turned such abbreviations and drug names into unrelated labels (奥美沙坦, olmesartan, became omeprazole).
  const drugClasses = await new FileDrugClassRepository(new URL("../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const classAwareNormalizer = { normalize: async (input: { text: string; role: string }) => {
    const named = ["exposure", "covariate", "predictor"].includes(input.role);
    const drugClass = named ? matchDrugClass(drugClasses, input.text) : undefined;
    if (drugClass) return { label_en: drugClass.labels.en, category: "medication" as const, source: "catalog" as const };
    // A drug named in Chinese or by an alternative name ("奥美沙坦", "salbutamol") is looked up, never translated by the model.
    const ingredient = named ? ingredientFor(drugClasses, input.text) : undefined;
    if (ingredient) return { label_en: `${ingredient[0]!.toUpperCase()}${ingredient.slice(1)}`, category: "medication" as const, source: "catalog" as const };
    const translated = await normalizer.normalize(input);
    // A model label that is itself a catalogued class or ingredient is as good as a catalog lookup.
    return { ...translated, source: named && translated.category === "medication" && (matchDrugClass(drugClasses, translated.label_en) || ingredientFor(drugClasses, translated.label_en)) ? "catalog" as const : "model" as const };
  } };
  const concepts = await namedConcepts(drugClasses);
  const formulas = await loadFormulaCatalog({ stores: [new VariableDefinitionStore(config.variable_definitions.shared_directory), new VariableDefinitionStore(config.variable_definitions.workspace_directory)], packFile: new URL("../../../config/mappings/mimic-iv-core.json", import.meta.url) });
  const framing = new StudyFramingService({ model: client, prompts: { split, extraction, extraction_en: extractionEn }, normalizer: classAwareNormalizer, formulas, population_parts: (text) => populationConcepts(concepts, text), drug_names: (text) => drugNamesIn(concepts, text) });
  // A variable that only partly matches the question can be defined from the dictionary: drafted here, saved to the workspace and seeded so the same run resolves it.
  const definitionIndex = await DictionaryIndex.load(config.variable_definitions.dictionary_index_path).catch(() => undefined);
  const definitionService = definitionIndex ? new VariableDefinitionService({
    index: definitionIndex, shared: new VariableDefinitionStore(config.variable_definitions.shared_directory), workspace: new VariableDefinitionStore(config.variable_definitions.workspace_directory),
    packFile: new URL("../../../config/mappings/mimic-iv-core.json", import.meta.url), drugClassFile: new URL("../../../config/drug-classes/drug-classes.json", import.meta.url),
  }) : undefined;
  const mappingRuntime = await createConfiguredVariableMappingRuntime({ config, prompts, localArchivePath: archivePath, profileEvidence: true, planner: { base_url: baseUrl, model, temperature: 0 } });
  if (!mappingRuntime.catalog) throw new Error("The clinical database catalog snapshot is unavailable.");
  if (mappingRuntime.embedding_search) process.stdout.write(`Embedding search on: ${mappingRuntime.embedding_search.model}, ${mappingRuntime.embedding_search.entries} dictionary labels, ${mappingRuntime.embedding_search.neighbours} neighbours per search.\n`);
  const synonyms = JSON.parse(await readFile(new URL("../../../config/dictionary-synonyms/synonyms.json", import.meta.url), "utf8")) as SynonymTable;
  const mappingProposal = definitionIndex && definitionService ? {
    propose: async (term: string, role: string): Promise<ProposedDefinition | undefined> => {
      // A drug or measurement is named by its labels; a population or outcome by its diagnosis codes.
      // A population or outcome is named by diagnosis codes; an exposure first as a drug, then as a measurement; a predictor or covariate as a measurement
      // (never as a drug: "weight" would find "low molecular weight heparin").
      const draft = role === "population" || role === "outcome" ? proposeDiagnosisDefinition(definitionIndex, term, synonyms)
        : role === "exposure" ? proposeDrugDefinition(definitionIndex, term, synonyms) ?? proposeItemDefinition(definitionIndex, term, synonyms) ?? proposeDiagnosisDefinition(definitionIndex, term, synonyms)
        : proposeItemDefinition(definitionIndex, term, synonyms) ?? proposeDiagnosisDefinition(definitionIndex, term, synonyms);
      return draft && (await definitionService.check(draft.definition)).ok ? draft : undefined;
    },
    define: async (proposal: ProposedDefinition): Promise<void> => { await definitionService.save(proposal.definition); await mappingRuntime.seed_workspace_definitions(); },
  } : undefined;
  const conceptFinder = buildConceptFinder(concepts); const conceptLabels = new Map(concepts.map((item) => [item.id, item.label]));
  const knowledge = await new FileLimitationKnowledgeBaseRepository(new URL("../../../config/mimic-limitations/mimic-iv-3.1.json", import.meta.url)).load();
  const clarificationReadings = await new FileReadingCatalogRepository(new URL("../../../config/clarifications/vague-outcome-readings.json", import.meta.url)).load();
  const clarify = (argument("--clarify") ?? "ask") as ClarifyPolicy;
  if (!CLARIFY_POLICIES.includes(clarify)) throw new Error(`--clarify must be one of ${CLARIFY_POLICIES.join(", ")}.`);
  const resultChecks = await new FileResultCheckRulesRepository(new URL("../../../config/result-checks/result-checks.json", import.meta.url)).load();
  const accept = JSON.parse(argument("--accept") ?? "[]") as string[];
  const chosenMethod = argument("--method");
  const perPlanMethods = JSON.parse(argument("--methods") ?? "{}") as Record<string, string>;
  const perPlanOptions = JSON.parse(argument("--options") ?? "{}") as Record<string, PlanOptionChoice>;
  const progressFile = new RunProgressFile(outDir, question);
  await progressFile.start();
  let currentPlan = "";
  // Every event goes to stdout (for the workspace server and log tails) and to <out>/progress.json with a heartbeat.
  const progress = (event: Record<string, unknown>): void => {
    process.stdout.write(`PROGRESS ${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    const detail = [event.plan_id, event.state, event.detail, event.index !== undefined ? `${event.index}/${event.total}` : undefined, event.status].filter(Boolean).join(" · ");
    void progressFile.event(String(event.stage), detail || undefined);
  };
  try {
    const started = Date.now();
    const pipeline = new QuestionPipelineService({
      clarification_readings: clarificationReadings, allowed_study_types: config.question_scope.allowed_study_types,
      ...(mappingProposal ? { mapping_proposal: mappingProposal } : {}),
      assess_outcome_components: (components) => assessOutcomeComponents(knowledge, components),
      assess_frame: (frame) => assessFrame(knowledge, frame),
      unaccounted_terms: (frame) => unaccountedConcepts(frame, conceptFinder).map((id) => conceptLabels.get(id) ?? id),
      framing: savedFrames ? { frame: async () => ({ frame_set: savedFrames, audits: [] }) } : framing, model, data_source: { id: "local-mimic-archive", version: basename(archivePath) },
      catalog: mappingRuntime.catalog, archive_path: archivePath, mapping: mappingRuntime.service,
      runner: new LocalExecutionGraphRunner({ expected_layer: await currentLayer(), on_progress: ({ source_id, rows_read, done }) => progress({ stage: "cohort_scan", plan_id: currentPlan, detail: `${source_id}: ${rows_read.toLocaleString("en-US")} rows${done ? " (done)" : ""}` }) }),
      on_stage: (event) => { currentPlan = event.plan_id; progress({ stage: event.stage, plan_id: event.plan_id, state: event.state, ...(event.detail ? { detail: event.detail } : {}) }); }, executor: new RStudyMethodExecutor({ rscript_binary: config.statistical_execution.rscript_binary, timeout_ms: 1_800_000 }),
      output_dir: join(outDir, "analyses"), result_checks: resultChecks,
      ...(chosenMethod || Object.keys(perPlanMethods).length ? { choose_method: (plan, options) => {
        const wanted = perPlanMethods[plan.plan_id] ?? chosenMethod;
        return options.find(({ method_id, readiness }) => method_id === wanted && readiness.available)?.method_id;
      } } : {}),
      on_plan: (outcome, index, total) => {
        progress({ stage: "plan", index, total, plan_id: outcome.plan_id, status: outcome.status, stage_reached: outcome.stage_reached, seconds: Math.round((Date.now() - started) / 1000) });
        process.stdout.write(`[${Math.round((Date.now() - started) / 1000)}s] plan ${index}/${total} ${outcome.plan_id}: ${outcome.status} at ${outcome.stage_reached}${outcome.blockers[0] ? ` — ${outcome.blockers[0].message.en}` : ""}\n`);
      },
    });
    if (draftOnly) {
      progress({ stage: savedFrames ? "reusing_framing" : "framing", seconds: 0 });
      const draft = await pipeline.draft(question, { clarify, accept });
      const target = join(outDir, "plan-draft.json"); const temporary = `${target}.tmp`;
      await writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`); await rename(temporary, target);
      const ready = draft.plans.filter(({ status }) => status === "ready").length;
      process.stdout.write(`${JSON.stringify({ draft_id: draft.draft_id, plans: draft.plans.length, ready, seconds: Math.round((Date.now() - started) / 1000) }, null, 2)}\n`);
      await progressFile.event("draft_ready", `${ready} of ${draft.plans.length} plans ready to run`);
      await progressFile.finish("completed");
      return;
    }
    progress({ stage: locked ? "locked_plan" : savedFrames ? "reusing_framing" : "framing", seconds: 0, ...(locked ? { detail: locked.lock_id.slice(-12) } : {}) });
    const result = locked ? await pipeline.runLocked(locked)
      : await pipeline.run(question, { methods: perPlanMethods, excluded: [], ...(Object.keys(perPlanOptions).length ? { options: perPlanOptions } : {}) }, clarify);
    progress({ stage: "reporting", seconds: Math.round((Date.now() - started) / 1000) });
    const matched = matchLimitations(knowledge, result.frame_set.frames);
    const reports = await writeQuestionReports(result, outDir, { limitations: { zh: limitationSentences(matched, "zh"), en: limitationSentences(matched, "en") } });
    process.stdout.write(`${JSON.stringify({ run_id: result.run_id, summary: result.summary, seconds: Math.round((Date.now() - started) / 1000), reports: reports.map(({ language, markdown, docx, docx_error }) => ({ language, markdown, docx, docx_error })) }, null, 2)}\n`);
    await progressFile.event("done", `${result.summary.completed} completed, ${result.summary.blocked} blocked, ${result.summary.failed} failed`);
    await progressFile.finish("completed");
  } catch (error) {
    await progressFile.finish("failed", error instanceof Error ? error.message : "The question run failed.");
    throw error;
  } finally { mappingRuntime.close(); }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "The question run failed."}\n`);
  process.exitCode = 1;
});
