import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInMemoryDesignSessionRepository, createResearchDesignService, DesignError } from "../research-design/index.js";
import { createManifestDraft, freezeConfirmedManifest } from "../research-design/research-definition.js";
import { createConfiguredVariableMappingRuntime, createRepositoryProductPromptRegistry, createRetryingResearchDesignModelFactory, loadRouterApiKey, nodeHttp1Fetch, OpenAiCompatibleStructuredProvider, requireRouterBaseUrl, resolveBackendRuntimeConfig, routerEnvironmentLayer } from "../runtime/index.js";
import type { StudyVariableMappingReview } from "../variable-mapping/index.js";
import { compileExecutionManifest } from "../execution-manifest/index.js";
import { DynamicLocalResearchWorkflow, GenericRAnalysisExecutor, LocalExecutionGraphRunner } from "../clinical-data/index.js";

const DEFAULT_MODEL = "aws/gpt-5.3-codex-spark";
type QuestionBatch = { questions: Array<string | { purpose: "association" | "prediction" | "treatment_effect"; question: string }> };

const parseQuestionBatch = (content: string): QuestionBatch => {
  const candidates = [content, content.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu)?.[1]].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as QuestionBatch; } catch { /* try an embedded object */ }
  }
  const start = content.indexOf("{"); const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(content.slice(start, end + 1)) as QuestionBatch;
  throw new Error("question generation did not return a JSON object");
};

const IDENTIFIER_COLUMNS = new Set(["subject_id", "hadm_id", "stay_id", "itemid", "caregiver_id", "orderid"]);
const RETRYABLE_DESIGN_CODES = new Set(["DESIGN_MODEL_UNAVAILABLE", "DESIGN_MODEL_TIMEOUT", "DESIGN_MODEL_RATE_LIMITED"]);
const progress = (index: number, stage: string, status: "started" | "completed"): void => { process.stderr.write(`${JSON.stringify({ event: "random_sweep_progress", index, stage, status })}\n`); };

export const selectAcceptanceOption = (question: { id: string; prompt: string; options: Array<{ value: string; label: string; explanation: string }> }): string | undefined => {
  if (!question.options.length) return undefined;
  const asksForIndex = /index|time.?zero|起始|起点|时间零点|入组时点/iu.test(`${question.id} ${question.prompt}`);
  if (!asksForIndex) return question.options[0]?.value;
  const score = (option: typeof question.options[number]): number => {
    const text = `${option.value} ${option.label} ${option.explanation}`;
    const observableEncounterAnchor = /admission|encounter.?start|icu.?admission|入院|入科|就诊开始/iu.test(text) ? 4 : 0;
    const treatmentDefinedAnchor = /treatment.?start|drug.?start|initiat|处方|用药|治疗开始/iu.test(text) ? -5 : 0;
    const diagnosisProxy = /diagnos|first.?record|首次记录|诊断/iu.test(text) ? -3 : 0;
    return observableEncounterAnchor + treatmentDefinedAnchor + diagnosisProxy;
  };
  return [...question.options].sort((left, right) => score(right) - score(left))[0]?.value;
};

export const selectExecutionColumn = (columns: readonly string[]): string | undefined =>
  columns.find((column) => !IDENTIFIER_COLUMNS.has(column) && !column.endsWith("time"))
  ?? columns.find((column) => !IDENTIFIER_COLUMNS.has(column))
  ?? columns[0];

export const inferSubjectSelection = (mapping: { matches: Array<{ field_candidates: Array<{ module: "hosp" | "icu" | "derived"; table: string; columns: string[] }> }> }): { relation: string; columns: string[] } | undefined => {
  for (const preferred of ["stay_id", "hadm_id", "subject_id"]) {
    for (const match of mapping.matches) {
      const candidate = match.field_candidates.find(({ columns }) => columns.includes(preferred));
      if (candidate) return { relation: `${candidate.module}.${candidate.table}`, columns: [preferred] };
    }
  }
  return undefined;
};

const toMappingResult = (review: StudyVariableMappingReview) => ({ schema_version: "1.0.0" as const, data_model: "MIMIC-IV" as const, matches: review.variables.map((variable) => {
  const candidate = variable.candidates[0];
  const status = !candidate ? "unmapped" as const : candidate.mapping.sources.some((item) => item.dictionary_table) ? "requires_dictionary_resolution" as const : "mapped" as const;
  return { requested: { role: variable.role, text: variable.requested_term }, status, ...(candidate ? { concept_id: candidate.mapping.concept_id, label: candidate.mapping.labels.en, field_candidates: candidate.mapping.sources.map((item) => ({ module: item.schema === "mimiciv_icu" ? "icu" as const : item.schema === "mimiciv_derived" ? "derived" as const : "hosp" as const, table: item.table, columns: item.columns, ...(item.dictionary_table ? { dictionary_table: item.dictionary_table } : {}) })) } : { field_candidates: [] }), warnings: variable.reason ? [variable.reason] : [] };
}), blocking_requirements: review.variables.filter((variable) => variable.status === "unmapped").map((variable) => variable.reason ?? `No mapping candidate for ${variable.requested_term}`) });

export const generateUnseededQuestions = async (options: { baseUrl: string; apiKey: string; model: string; count: number; timeoutMs: number }): Promise<string[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const send = (responseFormat: Record<string, unknown>) => nodeHttp1Fetch(`${options.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 4000,
        response_format: responseFormat,
        messages: [{ role: "system", content: "Generate independent, concise Chinese clinical research ideas for a MIMIC-IV hospital/ICU observational database. Do not use templates, examples, a fixed list, or repeat a topic. Each idea must contain one primary objective, one directly recorded exposure or at most two directly recorded predictors, and one directly recorded outcome. Use routinely structured hospital/ICU fields: diagnosis, procedure, medication administration, vital sign, laboratory measurement, organ support, length of stay, or admission/discharge outcome. Avoid scores, composites, derived variability or stability measures, undocumented traits, outpatient follow-up, novel interventions, and variables requiring narrative notes. Across the batch include association, prediction, and treatment_effect purposes, with at least two ideas from each purpose. Return only the required JSON." }, { role: "user", content: `Create exactly ${options.count} different ideas. Randomization nonce: ${randomUUID()}. Do not explain them.` }],
      }),
      signal: controller.signal,
    });
    const schema = { type: "object", additionalProperties: false, required: ["questions"], properties: { questions: { type: "array", minItems: options.count, maxItems: options.count, items: { type: "object", additionalProperties: false, required: ["purpose", "question"], properties: { purpose: { type: "string", enum: ["association", "prediction", "treatment_effect"] }, question: { type: "string", minLength: 8 } } } } } };
    let response = await send({ type: "json_schema", json_schema: { name: "random_research_ideas", strict: true, schema } });
    if ([400, 404, 415, 422].includes(response.status)) response = await send({ type: "json_object" });
    if (!response.ok) throw new Error(`question generation HTTP ${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = parseQuestionBatch(payload.choices?.[0]?.message?.content ?? "{}");
    if (!Array.isArray(parsed.questions) || parsed.questions.length !== options.count) throw new Error("question generation returned the wrong number of questions");
    const typed = parsed.questions.filter((item): item is Exclude<QuestionBatch["questions"][number], string> => Boolean(item && typeof item === "object" && ["association", "prediction", "treatment_effect"].includes(item.purpose) && typeof item.question === "string" && item.question.trim().length >= 8));
    if (typed.length !== options.count || new Set(typed.map(({ purpose }) => purpose)).size !== 3 || ["association", "prediction", "treatment_effect"].some((purpose) => typed.filter((item) => item.purpose === purpose).length < 2)) throw new Error("question generation did not satisfy the three-purpose coverage contract");
    return typed.map(({ question }) => question.trim());
  } finally { clearTimeout(timer); }
};

const hashFile = async (path: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash("sha256"); const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk)); stream.once("error", reject); stream.once("end", () => resolve(`sha256:${hash.digest("hex")}`));
});

const writeBlockedReport = async (outputDirectory: string, index: number, input: { question: string; stage: string; message: string; details?: unknown[] }): Promise<string> => {
  const stable = { schema_version: "2.0.0", status: "blocked", evidence_level: "pre_execution_block", model: process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL, ...input }; const reproducibility_id = `sha256:${createHash("sha256").update(JSON.stringify(stable)).digest("hex")}`; const artifact = { ...stable, reproducibility_id, integrity_id: `sha256:${createHash("sha256").update(JSON.stringify({ ...stable, reproducibility_id })).digest("hex")}` };
  const report_path = join(outputDirectory, `run-${index}.json`); await mkdir(outputDirectory, { recursive: true }); await writeFile(report_path, `${JSON.stringify({ artifact, report_markdown: `# Blocked dynamic research run\n\nQuestion: ${input.question}\nStage: ${input.stage}\nReason: ${input.message}\nReproducibility: ${reproducibility_id}\nArtifact integrity: ${artifact.integrity_id}` }, null, 2)}\n`, { mode: 0o600 }); return report_path;
};

export const runRandomRouterSweep = async (count = 10, environment: NodeJS.ProcessEnv = process.env, suppliedQuestions?: string[]) => {
  const key = loadRouterApiKey({ environment }); if (!key) throw new Error("Router Virtual Key is not configured.");
  const modelName = environment.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const configuredTimeout = Number(environment.DESIGN_MODEL_TIMEOUT_MS ?? "120000");
  const config = resolveBackendRuntimeConfig({ environment: { research_design: { model: { profile: modelName, timeout_ms: configuredTimeout }, ...routerEnvironmentLayer(environment) } } });
  const routerBaseUrl = requireRouterBaseUrl(config);
  const provider = new OpenAiCompatibleStructuredProvider({ base_url: routerBaseUrl, api_key: key, max_output_tokens: config.research_design.model.max_output_tokens });
  const prompt = await createRepositoryProductPromptRegistry().load(config.research_design.prompt);
  const model = createRetryingResearchDesignModelFactory(provider)({ profile: modelName, timeout_ms: config.research_design.model.timeout_ms, retry_max_attempts: config.research_design.model.retry_max_attempts, retry_backoff_ms: config.research_design.model.retry_backoff_ms, prompt });
  const service = createResearchDesignService(model, createInMemoryDesignSessionRepository());
  const prompts = createRepositoryProductPromptRegistry();
  const archivePath = environment.MIMIC_LOCAL_ARCHIVE;
  const mappingRuntime = await createConfiguredVariableMappingRuntime({ config, prompts, ...(archivePath ? { localArchivePath: archivePath } : {}), planner: { base_url: routerBaseUrl, api_key: key, model: modelName } });
  const archiveSha256 = archivePath ? environment.MIMIC_ARCHIVE_SHA256 ?? await hashFile(archivePath) : undefined;
  const outputDirectory = environment.RANDOM_SWEEP_OUTPUT_DIR ?? join(".local", "router-random-sweep", randomUUID());
  const workflow = archivePath && archiveSha256 && mappingRuntime.catalog ? new DynamicLocalResearchWorkflow({ runner: new LocalExecutionGraphRunner(), statistics: new GenericRAnalysisExecutor({ rscript_binary: config.statistical_execution.rscript_binary, script_path: fileURLToPath(new URL("../clinical-data/runtimes/r/generic_manifest_analysis.R", import.meta.url)), timeout_ms: config.statistical_execution.timeout_ms }), now: () => new Date() }) : undefined;
  // The internal sweep may inspect discovered candidates; production confirmation
  // still promotes mappings through the configured lifecycle service.
  const questions = suppliedQuestions?.length
    ? suppliedQuestions.slice(0, count)
    : await generateUnseededQuestions({ baseUrl: routerBaseUrl, apiKey: key, model: modelName, count, timeoutMs: config.research_design.model.timeout_ms });
  const results = [];
  for (let index = 0; index < questions.length; index += 1) {
    const message = questions[index] ?? "";
    try {
      progress(index + 1, "research_design", "started");
      const startInput = { message: `${message}\n请将这句话中已经明确的研究目的、人群、暴露/预测因子、结局、聚合/对比方式和时间信息写入完整 candidate_spec；spec_patch 留空；只对缺失或真正歧义的内容提问。`, client_request_id: `random-router-sweep-${index + 1}` };
      let view: Awaited<ReturnType<typeof service.start>>;
      for (let attempt = 1; ; attempt += 1) {
        try { view = await service.start(startInput); break; }
        catch (error) { if (!(error instanceof DesignError) || !RETRYABLE_DESIGN_CODES.has(error.code) || attempt >= 3) throw error; }
      }
      // Internal acceptance mode iterates over the model's own clarification defaults.
      // This remains separate from production, where a researcher must answer and confirm.
      let test_assumptions: Array<{ question_id: string; selected: string }> = [];
      for (let revision = 1; revision <= 8 && (view.phase !== "ready_to_confirm" || view.clarifying_questions.length > 0); revision += 1) {
        const assumptions = view.clarifying_questions.map((question) => ({ question_id: question.id, selected: selectAcceptanceOption(question) ?? "Use the operationally explicit interpretation supported by the original question." }));
        test_assumptions = [...test_assumptions, ...assumptions];
        const answers = Object.fromEntries(assumptions.map(({ question_id, selected }) => [question_id, selected]));
        view = await service.continue({ session_id: view.session_id, base_revision: view.revision, message: `Internal acceptance test. Original question: ${message}\nAccepted answers so far: ${JSON.stringify(test_assumptions)}\nResolve every remaining required protocol field from the original question and accepted answers. Return the complete next StudySpec in candidate_spec, preserve resolved fields, do not repeat answered questions, and do not change the research purpose.`, answers, client_request_id: `random-router-sweep-${index + 1}-complete-${revision}` });
      }
      progress(index + 1, "research_design", "completed");
      progress(index + 1, "variable_mapping", "started");
      const variableReview = await mappingRuntime.service.assess(view.study_spec, Boolean(archivePath));
      progress(index + 1, "variable_mapping", "completed");
      const mapping = toMappingResult(variableReview);
      const draft = createManifestDraft(view.study_spec, mapping);
      const fields = draft.fields.map((field) => ({ role: field.role, requested_label: field.requested_label, status: field.status, top_candidates: field.candidates.slice(0, 3) }));
      let manifest: unknown;
      const execution_manifest = mappingRuntime.catalog ? compileExecutionManifest({ study: view.study_spec, mapping: variableReview, catalog: mappingRuntime.catalog, allowDatabaseVerified: true }) : undefined;
      if (workflow && archivePath) progress(index + 1, "local_execution_and_statistics", "started");
      const runBundle = workflow && archivePath ? await workflow.run({ study: view.study_spec, mapping: variableReview, catalog: mappingRuntime.catalog!, archive_path: archivePath, provenance: { data_source_id: "local-mimic-archive", data_source_version: "MIMIC-IV", archive_sha256: archiveSha256! }, allow_database_verified: true }) : undefined;
      if (workflow && archivePath) progress(index + 1, "local_execution_and_statistics", "completed");
      let report_path: string | undefined;
      if (runBundle) { await mkdir(outputDirectory, { recursive: true }); report_path = join(outputDirectory, `run-${index + 1}.json`); await writeFile(report_path, `${JSON.stringify(runBundle, null, 2)}\n`, { mode: 0o600 }); }
      let manifest_blocking_reason: string | undefined;
      try {
        const selections = Object.fromEntries(mapping.matches.map((match) => {
          const first = match.field_candidates[0];
          const selectedColumn = first ? selectExecutionColumn(first.columns) : undefined;
          return first && selectedColumn ? [match.requested.text, { relation: `${first.module}.${first.table}`, columns: [selectedColumn], ...(first.dictionary_table ? { dictionary_table: first.dictionary_table } : {}) }] : [];
        }));
        const subjectSelection = inferSubjectSelection(mapping);
        if (subjectSelection) selections.__subject_id = subjectSelection;
        manifest = freezeConfirmedManifest(view.study_spec, mapping, selections);
      } catch (error) { manifest_blocking_reason = error instanceof Error ? error.message : "Manifest could not be frozen."; }
      const status = runBundle?.artifact.status ?? (view.phase !== "ready_to_confirm" ? "blocked" : execution_manifest?.status === "ready" ? "ready_for_execution" : "blocked");
      results.push({ index: index + 1, message, status, phase: view.phase, intent: view.study_spec.intent_family, readiness: view.intent_assessment.recommended_intent, clarifying_questions: view.clarifying_questions, mapping: { status: draft.blocking_reasons.length ? "blocked" : "candidate", fields, blocking_reasons: draft.blocking_reasons }, ...(execution_manifest ? { execution_manifest } : {}), ...(runBundle ? { run: { run_id: runBundle.artifact.run_id, status: runBundle.artifact.status, diagnostic_decision: runBundle.artifact.diagnostic_decision, evidence_level: runBundle.artifact.evidence_level, reproducibility_id: runBundle.artifact.reproducibility_id, integrity_id: runBundle.artifact.integrity_id, blockers: runBundle.artifact.blockers }, report_path } : {}), test_mode_auto_selection: "bounded_model_completion_then_first_candidate", test_assumptions, ...(manifest ? { compatibility_manifest: manifest } : { manifest_blocking_reason }) });
      progress(index + 1, "terminal_report", "completed");
    } catch (error) { const blocking_reason=error instanceof Error?error.message:"unknown";const details=error&&typeof error==="object"&&"details" in error&&Array.isArray(error.details)?error.details:undefined;const report_path=await writeBlockedReport(outputDirectory,index+1,{question:message,stage:"research_design",message:blocking_reason,...(details?{details}:{})});results.push({ index:index+1,message,status:"blocked",blocked_stage:"research_design",blocking_reason,...(details?{details}:{}),report_path });progress(index+1,"terminal_report","completed"); }
  }
  mappingRuntime.close();
  const summary = { count: questions.length, question_generation: suppliedQuestions?.length ? "supplied_acceptance_batch" : "real_model_unseeded", model: modelName, terminal: results.length, completed: results.filter((item) => item.status === "completed").length, ready_for_execution: results.filter((item) => item.status === "ready_for_execution").length, blocked: results.filter((item) => item.status === "blocked").length, design_ready: results.filter((item) => "phase" in item && item.phase === "ready_to_confirm").length, execution_manifest_ready: results.filter((item) => "execution_manifest" in item && item.execution_manifest?.status === "ready").length, reports_generated: results.filter((item) => "report_path" in item).length, results };
  return summary;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const supplied = process.env.RANDOM_SWEEP_QUESTIONS_JSON
    ? JSON.parse(process.env.RANDOM_SWEEP_QUESTIONS_JSON) as unknown
    : undefined;
  if (supplied !== undefined && (!Array.isArray(supplied) || supplied.some((item) => typeof item !== "string" || !item.trim()))) throw new Error("RANDOM_SWEEP_QUESTIONS_JSON must be a JSON array of non-empty strings.");
  runRandomRouterSweep(Number(process.env.RANDOM_SWEEP_COUNT ?? "10"), process.env, supplied as string[] | undefined).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Router random sweep failed."}\n`); process.exitCode = 1; });
}
