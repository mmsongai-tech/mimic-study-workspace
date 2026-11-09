import { createHash } from "node:crypto";
import type { ClinicalDatabaseCatalog } from "../clinical-database/index.js";
import { compileExecutionManifest, type ExecutionManifest } from "../execution-manifest/index.js";
import { assessResearchProtocol, type OutcomeStructure, type StudySpec } from "../research-design/index.js";
import { selectStatisticalMethod } from "../analysis-planning/index.js";
import { isCandidateExecutable, semanticCodeHintCoverage, type StudyVariableMappingReview } from "../variable-mapping/index.js";
import { GenericRAnalysisExecutor, type GenericStatisticalResult } from "./generic-r-analysis-executor.js";
import { LocalExecutionGraphRunner, type LocalExecutionGraphResult } from "./local-execution-graph-runner.js";

export interface DynamicRunBlocker { stage: "research_design" | "variable_mapping" | "manifest" | "data" | "statistics"; code: string; message: string; }
export interface DynamicLocalRunArtifact { schema_version: "2.0.0"; run_id: string; created_at: string; status: "completed" | "blocked"; evidence_level: "local_mimic_archive_execution" | "pre_execution_block"; study: StudySpec; manifest: ExecutionManifest; data_provenance: { data_source_id: string; data_source_version: string; archive_sha256: string }; cohort?: LocalExecutionGraphResult["quality"] & { cohort_integrity_id: string }; analysis?: GenericStatisticalResult; diagnostic_decision: "reportable" | "reportable_with_warnings" | "blocked"; blockers: DynamicRunBlocker[]; warnings: string[]; reproducibility_id: string; integrity_id: string; }
export interface DynamicLocalRunBundle { artifact: DynamicLocalRunArtifact; report_markdown: string; }

const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,canonicalize(child)])) : value;
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
const supportedOutcome = (family: StudySpec["intent_family"], outcome: OutcomeStructure | undefined): outcome is OutcomeStructure => Boolean(outcome && (family === "association" || family === "treatment_effect" ? ["binary","continuous"].includes(outcome) : outcome === "binary"));
const distinctObserved = (rows: LocalExecutionGraphResult["rows"], field: string): Set<string> => new Set(rows.map((row) => row[field]).filter((value) => value !== undefined && value !== null && value !== "").map(String));
const statisticalPreflight = (study: StudySpec, cohort: LocalExecutionGraphResult): DynamicRunBlocker[] => {
  if (cohort.rows.length < 20) return [{ stage: "statistics", code: "INSUFFICIENT_COMPLETE_RECORDS", message: `The registered method requires at least 20 complete analysis units; local evidence contains ${cohort.rows.length}.` }];
  const blockers: DynamicRunBlocker[] = [];
  if (study.outcome_structure === "binary" && distinctObserved(cohort.rows, "outcome").size < 2) blockers.push({ stage: "statistics", code: "OUTCOME_VARIATION_MISSING", message: "The binary outcome has fewer than two observed classes in the complete local cohort." });
  if (study.outcome_structure === "continuous" && distinctObserved(cohort.rows, "outcome").size < 2) blockers.push({ stage: "statistics", code: "OUTCOME_VARIATION_MISSING", message: "The continuous outcome has no observable variation in the complete local cohort." });
  if (study.intent_family !== "prediction" && distinctObserved(cohort.rows, "exposure").size < 2) blockers.push({ stage: "statistics", code: "EXPOSURE_VARIATION_MISSING", message: "The exposure has fewer than two observed values in the complete local cohort." });
  if (study.intent_family === "treatment_effect" && !cohort.rows.some((row) => Object.keys(row).some((key) => key.startsWith("covariate_") || key.startsWith("effect_modifier_")))) blockers.push({ stage: "statistics", code: "PRETREATMENT_COVARIATES_MISSING", message: "The registered propensity-weighted treatment method requires at least one mapped pretreatment covariate." });
  return blockers;
};

const prepareAssociationRows = (study: StudySpec, manifest: ExecutionManifest, rows: LocalExecutionGraphResult["rows"]): { rows: LocalExecutionGraphResult["rows"]; warnings: string[] } => {
  if (study.intent_family !== "association") return { rows, warnings: [] };
  const covariates: Array<{ alias: string; label: string }> = []; const modifiers: Array<{ alias: string; label: string }> = [];
  let covariateIndex = 0; let modifierIndex = 0;
  for (const variable of manifest.variables.filter(({ role }) => role === "covariate")) {
    if (variable.effect_modifier) modifiers.push({ alias: `effect_modifier_${modifierIndex++}`, label: variable.requested_label });
    else covariates.push({ alias: `covariate_${covariateIndex++}`, label: variable.requested_label });
  }
  const present = (row: LocalExecutionGraphResult["rows"][number], field: string): boolean => row[field] !== undefined && row[field] !== null && row[field] !== "";
  const complete = (fields: string[]): LocalExecutionGraphResult["rows"] => rows.filter((row) => fields.every((field) => present(row, field)));
  const required = ["exposure", "outcome", ...modifiers.map(({ alias }) => alias)];
  let retained = [...covariates]; let selected = complete([...required, ...retained.map(({ alias }) => alias)]); const fullyAdjustedCount = selected.length;
  const omitted: Array<{ alias: string; label: string }> = [];
  while (selected.length < 20 && retained.length) {
    retained.sort((left, right) => rows.filter((row) => !present(row, right.alias)).length - rows.filter((row) => !present(row, left.alias)).length || left.alias.localeCompare(right.alias));
    omitted.push(retained.shift()!);
    selected = complete([...required, ...retained.map(({ alias }) => alias)]);
  }
  if (!omitted.length) return { rows: selected, warnings: [] };
  const stripped = selected.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !omitted.some(({ alias }) => alias === key))) as LocalExecutionGraphResult["rows"][number]);
  return {
    rows: stripped,
    warnings: [`PRIMARY_ADJUSTMENT_REDUCED: The fully adjusted estimand was not produced because fewer than 20 complete units were available (${fullyAdjustedCount}). The fixed association fallback omitted ${omitted.map(({ label }) => label).join(", ")} and analyzed ${selected.length} complete units.`],
  };
};

const normalizedVariableName = (value: string): string => value.trim().toLocaleLowerCase();
const prepareOptionalCovariates = (study: StudySpec, mapping: StudyVariableMappingReview): { study: StudySpec; mapping: StudyVariableMappingReview; warnings: string[] } => {
  const modifiers = new Set((study.effect_modifiers ?? []).map(({ variable_name }) => normalizedVariableName(variable_name)));
  const omitted = mapping.variables.filter((variable) => variable.role === "covariate"
    && variable.status !== "resolved"
    && !modifiers.has(normalizedVariableName(variable.requested_term)));
  if (!omitted.length) return { study, mapping, warnings: [] };
  const omittedNames = new Set(omitted.map(({ requested_term }) => normalizedVariableName(requested_term)));
  const variables = mapping.variables.filter((variable) => !omitted.includes(variable));
  const summary = {
    resolved: variables.filter(({ status }) => status === "resolved").length,
    needs_confirmation: variables.filter(({ status }) => status === "needs_confirmation").length,
    unmapped: variables.filter(({ status }) => status === "unmapped").length,
  };
  return {
    study: { ...study, covariates: (study.covariates ?? []).filter(({ name }) => !omittedNames.has(normalizedVariableName(name))) },
    mapping: { ...mapping, variables, summary, status: summary.unmapped ? "blocked" : summary.needs_confirmation ? "needs_confirmation" : "ready" },
    warnings: [`PRESPECIFIED_COVARIATES_OMITTED: Local evidence did not support ${omitted.map(({ requested_term }) => requested_term).join(", ")}. These ordinary covariates were omitted from this objective; the report must not claim a fully adjusted causal estimate.`],
  };
};

/** Owns the terminal completed-or-blocked path from reviewed mappings to a reproducible local report. */
export class DynamicLocalResearchWorkflow {
  constructor(private readonly dependencies: { runner: Pick<LocalExecutionGraphRunner,"run">; statistics: Pick<GenericRAnalysisExecutor,"execute">; now: () => Date; compile?: typeof compileExecutionManifest }) {}
  async run(input: { study: StudySpec; mapping: StudyVariableMappingReview; catalog: ClinicalDatabaseCatalog; archive_path: string; provenance: { data_source_id: string; data_source_version: string; archive_sha256: string }; allow_database_verified?: boolean }): Promise<DynamicLocalRunBundle> {
    const prepared = prepareOptionalCovariates(input.study, input.mapping);
    const manifest = (this.dependencies.compile ?? compileExecutionManifest)({ study:prepared.study, mapping:prepared.mapping, catalog:input.catalog, ...(input.allow_database_verified !== undefined ? { allowDatabaseVerified:input.allow_database_verified } : {}) });
    const mappingAccepted = prepared.mapping.status === "ready" && prepared.mapping.variables.every(({ candidates }) => candidates.some((candidate) => isCandidateExecutable(candidate, input.allow_database_verified)));
    const outcomeMapping = prepared.mapping.variables.find(({ role, status, candidates }) => role === "outcome" && status === "resolved" && candidates.some((candidate) => isCandidateExecutable(candidate, input.allow_database_verified)));
    const manifestOutcome = outcomeMapping && manifest.status === "ready"
      ? manifest.variables.find(({ role, mapping_id }) => role === "outcome" && outcomeMapping.candidates.some((candidate) => candidate.mapping.mapping_id === mapping_id && isCandidateExecutable(candidate, input.allow_database_verified)))
      : undefined;
    const mappedLegacyOutcome = Boolean(!prepared.study.outcome?.definition && mappingAccepted && outcomeMapping && manifestOutcome);
    const protocol = assessResearchProtocol(input.study); const blockers: DynamicRunBlocker[] = protocol.requirements
      .filter(({severity,code})=>severity==="required" && !(code === "STRUCTURED_OUTCOME_REQUIRED" && mappedLegacyOutcome))
      .map((requirement)=>({stage:"research_design",code:requirement.code,message:requirement.reason}));
    if(!mappingAccepted) {
      blockers.push({stage:"variable_mapping",code:"MAPPING_REVIEW_REQUIRED",message:"Every selected variable mapping must be resolved before local data execution."});
      for (const variable of prepared.mapping.variables.filter(({ status }) => status !== "resolved")) blockers.push({
        stage: "variable_mapping",
        code: variable.status === "unmapped" ? "VARIABLE_UNMAPPED" : "VARIABLE_CONFIRMATION_REQUIRED",
        message: `${variable.role} “${variable.requested_term}”: ${variable.reason ?? variable.candidate_review?.reason_codes.join(", ") ?? "No executable evidence-backed mapping was frozen."}`,
      });
    }
    blockers.push(...manifest.blockers.map((blocker)=>({ stage:"manifest" as const, code:blocker.code, message:blocker.message }))); let cohort: LocalExecutionGraphResult | undefined; let analysis: GenericStatisticalResult | undefined; let statisticalRows: LocalExecutionGraphResult["rows"] | undefined;
    if (!blockers.length && !supportedOutcome(prepared.study.intent_family,prepared.study.outcome_structure)) blockers.push({ stage:"statistics", code:"METHOD_NOT_SUPPORTED", message:`No generic ${prepared.study.intent_family}/${prepared.study.outcome_structure ?? "undefined"} executor is registered.` });
    if (!blockers.length) { try { cohort=await this.dependencies.runner.run(input.archive_path,manifest); } catch { blockers.push({stage:"data",code:"LOCAL_EXECUTION_FAILED",message:"The catalog-verified local data execution did not complete."}); } }
    const preparation = cohort ? prepareAssociationRows(prepared.study, manifest, cohort.rows) : undefined;
    statisticalRows = preparation?.rows ?? cohort?.rows;
    if (!blockers.length && cohort && statisticalRows) blockers.push(...statisticalPreflight(prepared.study, { ...cohort, rows: statisticalRows }));
    if (!blockers.length && statisticalRows) { try { const registered=selectStatisticalMethod(prepared.study); analysis=await this.dependencies.statistics.execute({rows:statisticalRows,study_family:manifest.study_family,outcome_structure:prepared.study.outcome_structure!,registered_method_id:registered.method_id,registered_method_version:registered.method_version}); } catch { blockers.push({stage:"statistics",code:"STATISTICAL_EXECUTION_FAILED",message:"The registered statistical executor did not produce a valid aggregate result after passing deterministic preflight checks."}); } }
    const warnings = [...new Set([...prepared.warnings, ...(mappedLegacyOutcome ? ["STRUCTURED_OUTCOME_RESOLVED_BY_MAPPING: The confirmed StudySpec used a legacy narrative outcome; execution used the reviewed outcome mapping bound in the frozen manifest without modifying the confirmed design."] : []), ...(preparation?.warnings ?? []), ...prepared.mapping.variables.flatMap((variable) => variable.candidates
      .filter(({ mapping }) => manifest.variables.some((selected) => selected.mapping_id === mapping.mapping_id
        && selected.role === variable.role
        && selected.condition_id === variable.condition_id
        && selected.requested_label === variable.requested_term))
      .flatMap(({ mapping }) => {
        const coverage = semanticCodeHintCoverage(mapping);
        return coverage.has_verified_matches && coverage.unmatched_prefixes.length
          ? [`${variable.role} “${variable.requested_term}”: requested code prefixes absent from the local MIMIC dictionary were retained as zero-match categories: ${coverage.unmatched_prefixes.join(", ")}.`]
          : [];
      }))])];
    let decision: DynamicLocalRunArtifact["diagnostic_decision"]="blocked";
    if (analysis) { const converged=analysis.diagnostics.converged===true; const eventsPerParameter=analysis.diagnostics.events_per_parameter; decision=converged?(warnings.length?"reportable_with_warnings":"reportable"):"blocked"; if(!converged) blockers.push({stage:"statistics",code:"MODEL_NOT_CONVERGED",message:"The fitted statistical model did not converge."}); if(typeof eventsPerParameter==="number"&&eventsPerParameter<10){warnings.push("Fewer than 10 outcome events per fitted parameter.");decision=decision==="blocked"?"blocked":"reportable_with_warnings";} if(analysis.study_family==="treatment_effect"){warnings.push("Causal interpretation additionally requires clinical review of exchangeability, positivity, consistency, and interference assumptions.");decision=decision==="blocked"?"blocked":"reportable_with_warnings";} }
    const stable={schema_version:"2.0.0" as const,status:blockers.length?"blocked" as const:"completed" as const,evidence_level:cohort?"local_mimic_archive_execution" as const:"pre_execution_block" as const,study:input.study,manifest,data_provenance:input.provenance,...(cohort?{cohort:{...cohort.quality,cohort_integrity_id:cohort.cohort_integrity_id}}:{}),...(analysis?{analysis}:{}),diagnostic_decision:decision,blockers,warnings}; const reproducibility_id=digest(stable); const base={...stable,run_id:`run:${reproducibility_id.slice(7,27)}`,created_at:this.dependencies.now().toISOString(),reproducibility_id}; const artifact={...base,integrity_id:digest(base)}; return {artifact,report_markdown:this.report(artifact)};
  }
  private report(a: DynamicLocalRunArtifact): string {
    const chinese = /\p{Script=Han}/u.test(`${a.study.title ?? ""}${a.study.research_question ?? ""}`);
    const lines = chinese
      ? [`# ${a.study.title ?? "MIMIC-IV 动态研究报告"}`, "", `状态：${a.status}`, `研究问题：${a.study.research_question ?? "未记录"}`, `研究目的：${a.study.intent_family}`, `执行清单：${a.manifest.manifest_id}`, `数据来源：${a.data_provenance.data_source_id} ${a.data_provenance.data_source_version}`, `证据类型：${a.evidence_level}`, ""]
      : [`# ${a.study.title ?? "Dynamic MIMIC-IV research report"}`, "", `Status: ${a.status}`, `Research question: ${a.study.research_question ?? "not recorded"}`, `Research purpose: ${a.study.intent_family}`, `Manifest: ${a.manifest.manifest_id}`, `Data source: ${a.data_provenance.data_source_id} ${a.data_provenance.data_source_version}`, `Evidence: ${a.evidence_level}`, ""];
    if (a.cohort) lines.push(chinese ? "## 队列核算" : "## Cohort accounting", "", ...(chinese ? [`分析单位：${a.cohort.analysis_units}`, `完整记录：${a.cohort.complete_rows}`, `排除记录：${a.cohort.excluded_rows}`, `来源行数：${JSON.stringify(a.cohort.source_rows)}`] : [`Analysis units: ${a.cohort.analysis_units}`, `Complete rows: ${a.cohort.complete_rows}`, `Excluded rows: ${a.cohort.excluded_rows}`, `Source rows: ${JSON.stringify(a.cohort.source_rows)}`]), "");
    if (a.analysis) lines.push(chinese ? "## 统计结果" : "## Statistical result", "", ...(chinese ? [`注册方法：${a.analysis.registered_method_id}@${a.analysis.registered_method_version}`, `实际运行方法：${a.analysis.method}`, `计数：${JSON.stringify(a.analysis.counts)}`, `估计值：${JSON.stringify(a.analysis.estimates)}`, `诊断：${JSON.stringify(a.analysis.diagnostics)}`, `敏感性分析：${JSON.stringify(a.analysis.sensitivity)}`, `结论状态：${a.diagnostic_decision}`] : [`Registered method: ${a.analysis.registered_method_id}@${a.analysis.registered_method_version}`, `Executed method: ${a.analysis.method}`, `Counts: ${JSON.stringify(a.analysis.counts)}`, `Estimates: ${JSON.stringify(a.analysis.estimates)}`, `Diagnostics: ${JSON.stringify(a.analysis.diagnostics)}`, `Sensitivity: ${JSON.stringify(a.analysis.sensitivity)}`, `Decision: ${a.diagnostic_decision}`]), "");
    if (a.analysis?.publication_outputs) {
      for (const table of a.analysis.publication_outputs.tables) lines.push(`## ${table.title}`, "", `| ${table.columns.join(" | ")} |`, `| ${table.columns.map(() => "---").join(" | ")} |`, ...table.rows.map((row) => `| ${row.join(" | ")} |`), "");
      for (const listing of a.analysis.publication_outputs.listings) lines.push(`## ${listing.title}`, "", chinese ? "仅包含聚合结果，不含患者级记录。" : "Aggregate only; no patient-level records.", "", `| ${listing.columns.join(" | ")} |`, `| ${listing.columns.map(() => "---").join(" | ")} |`, ...listing.rows.map((row) => `| ${row.join(" | ")} |`), "");
      for (const figure of a.analysis.publication_outputs.figures) lines.push(`## ${figure.title}`, "", chinese ? `图形产物：${figure.id}（SVG）` : `Figure artifact: ${figure.id} (SVG)`, "");
    }
    if (a.blockers.length) lines.push(chinese ? "## 阻断证据" : "## Blocking evidence", "", ...a.blockers.map((b) => `- ${b.stage}/${b.code}: ${b.message}`), "");
    if (a.warnings.length) lines.push(chinese ? "## 警告" : "## Warnings", "", ...a.warnings.map((w) => `- ${w}`), "");
    lines.push(chinese ? `复现标识：${a.reproducibility_id}` : `Reproducibility: ${a.reproducibility_id}`, chinese ? `产物完整性：${a.integrity_id}` : `Artifact integrity: ${a.integrity_id}`);
    return lines.join("\n");
  }
}
