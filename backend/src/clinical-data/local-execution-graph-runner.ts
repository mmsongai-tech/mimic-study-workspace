import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ExecutionManifest, ExecutionManifestVariable } from "../execution-manifest/index.js";
import type { StudyCondition } from "../research-design/index.js";
import { streamArchiveRows, streamArchiveRowsFiltered, type LocalMimicRow } from "./local-analysis-inputs.js";

export interface ProjectedAnalysisRow extends LocalMimicRow { analysis_id: string; exposure?: unknown; outcome?: unknown; treatment?: unknown; }
/** Which projected column carries which manifest variable (aggregate metadata only). */
/** `characteristic`: the column is a described characteristic of a description (never the exposure, outcome or an adjustment variable). */
/** `aggregation`: how the column summarises its mapping's records (two columns of one mapping with different summaries are different variables). */
export interface ProjectedColumn { column: string; role: ExecutionManifestVariable["role"]; characteristic?: boolean; requested_label: string; mapping_id: string; value_type: ExecutionManifestVariable["value_type"]; aggregation?: ExecutionManifestVariable["aggregation"] }
export interface LocalExecutionGraphResult { rows: ProjectedAnalysisRow[]; columns?: ProjectedColumn[]; quality: { source_rows: Record<string, number>; analysis_units: number; complete_rows: number; excluded_rows: number; exclusion_reasons: Record<string, number>; }; cohort_integrity_id: string; }
const identifierPriority = ["stay_id", "hadm_id", "subject_id"] as const;

const listArchiveMembers = async (archivePath: string): Promise<string[]> => new Promise((resolve, reject) => {
  const child = spawn("unzip", ["-Z1", archivePath], { stdio: ["ignore", "pipe", "ignore"] }); const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk)); child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8").split(/\r?\n/u).filter(Boolean)) : reject(new Error("Unable to inspect the local MIMIC archive.")));
});
const moduleDirectory = (schema: string): string => schema.replace(/^mimiciv_/u, "");
/** The derived-variable layer sits next to the archive: mimic-iv-3.1.zip → mimic-iv-3.1-derived.zip (scripts/derived/build_derived.py). */
export const derivedArchivePath = (archivePath: string): string => archivePath.replace(/\.zip$/u, "-derived.zip");
const numeric = (value: unknown): number | undefined => value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
const toValue = (value: unknown, valueType: ExecutionManifestVariable["value_type"]): unknown => valueType === "binary" ? value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true" : ["continuous", "count", "duration"].includes(valueType) ? numeric(value) : value;
const aliasFor = (variable: ExecutionManifestVariable, counters: Record<string, number>): string => {
  if (variable.condition_id && variable.role === "population") return `condition:${variable.condition_id}`;
  // A characteristic keeps a column of its own whatever its role (an outcome-type characteristic is not "the" outcome).
  if (variable.characteristic) { const index = counters.characteristic ?? 0; counters.characteristic = index + 1; return `characteristic_${index}`; }
  if (variable.role === "exposure") return "exposure"; if (variable.role === "outcome") return "outcome"; if (variable.role === "population") return "population"; if (variable.role === "index_time") return "index_time";
  const aliasRole = variable.effect_modifier ? "effect_modifier" : variable.role; const index = counters[aliasRole] ?? 0; counters[aliasRole] = index + 1; return `${aliasRole}_${index}`;
};
const compareNumber = (observed: number, operator: "gt" | "gte" | "eq" | "lt" | "lte", expected: number): boolean => operator === "gt" ? observed > expected : operator === "gte" ? observed >= expected : operator === "eq" ? observed === expected : operator === "lt" ? observed < expected : observed <= expected;
const evaluateCondition = (condition: StudyCondition, values: { get(key: string): ValueState | undefined }): boolean => {
  if (condition.kind === "all") return condition.operands.every((operand) => evaluateCondition(operand, values));
  if (condition.kind === "any") return condition.operands.some((operand) => evaluateCondition(operand, values));
  if (condition.kind === "not") return !evaluateCondition(condition.operand, values);
  const state = values.get(`condition:${condition.condition_id}`);
  if (condition.kind === "concept") return condition.assertion === "present" ? Boolean(state) : !state;
  if (condition.kind === "event_exists") { const occurred = Boolean(state?.value); return condition.occurrence === "present" ? occurred : !occurred; }
  if (condition.kind === "numeric_comparison") return state ? compareNumber(Number(state.value), condition.operator, condition.value) : false;
  if (condition.kind !== "category_comparison") return false;
  if (!state) return false;
  const included = condition.values.map(String).includes(String(state.value));
  return condition.operator === "in" ? included : !included;
};
const timeUnitMs: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_629_746_000, year: 31_556_952_000 };
/** Date-only values (e.g. patients.dod) are taken as the end of that day so same-day events stay after time zero. */
const eventTimestamp = (value: unknown): number => {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? Date.parse(`${text}T23:59:59.999`) : Date.parse(text);
};
const DAY_MS = 86_400_000;
/** Sums group weights; a present superseding group removes the groups it supersedes. No qualifying code scores 0. */
const codeScore = (groups: Array<{ group_id: string; weight: number; supersedes?: string[] }>, present: Set<string> | undefined): number => {
  const active = new Set(present ?? []);
  for (const group of groups) if (active.has(group.group_id)) for (const replaced of group.supersedes ?? []) active.delete(replaced);
  return groups.reduce((sum, group) => sum + (active.has(group.group_id) ? group.weight : 0), 0);
};
const endOfDay = (time: number): number => { const date = new Date(time); date.setHours(23, 59, 59, 999); return date.getTime(); };

type ValueState = { value: unknown; count: number; time?: number; values?: number[] };
const aggregate = (current: ValueState | undefined, next: unknown, method: ExecutionManifestVariable["aggregation"], time?: number): ValueState => {
  // A summed or averaged flag (a drug record is "true") counts as one each, so a second record gives 2 and not a mix of true and 2.
  if (!current) return { value: method === "sum" || method === "mean" ? Number(next) : next, count: 1, ...(method === "median" || method === "standard_deviation" ? { values: [Number(next)] } : {}), ...(time !== undefined ? { time } : {}) };
  if (method === "median" || method === "standard_deviation") return { value: next, count: current.count + 1, values: [...(current.values ?? [Number(current.value)]), Number(next)] };
  if (method === "count") return { value: Number(current.value) + 1, count: current.count + 1 };
  if (method === "sum" || method === "mean") return { value: Number(current.value) + Number(next), count: current.count + 1 };
  if (method === "minimum") return { value: Math.min(Number(current.value), Number(next)), count: current.count + 1 };
  if (method === "maximum") return { value: Math.max(Number(current.value), Number(next)), count: current.count + 1 };
  if (method === "any") return { value: Boolean(current.value) || Boolean(next), count: current.count + 1 };
  if (method === "last" && time !== undefined && time >= (current.time ?? Number.NEGATIVE_INFINITY)) return { value: next, count: current.count + 1, time };
  if (method === "first" && time !== undefined && time < (current.time ?? Number.POSITIVE_INFINITY)) return { value: next, count: current.count + 1, time };
  return { ...current, count: current.count + 1 };
};
const finalizedValue = (state: ValueState | undefined, method: ExecutionManifestVariable["aggregation"]): unknown => state
  ? method === "mean" ? Number(state.value) / state.count
    : method === "standard_deviation" ? (() => { const values = state.values ?? []; if (values.length < 2) return undefined; const mean = values.reduce((sum, value) => sum + value, 0) / values.length; return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)); })()
    : method === "median" ? (() => { const values = [...(state.values ?? [])].sort((a, b) => a - b); const middle = Math.floor(values.length / 2); return values.length % 2 ? values[middle] : (values[middle - 1]! + values[middle]!) / 2; })()
      : state.value
  : undefined;
const representsRecordedPresence = (variable: ExecutionManifestVariable): boolean => {
  if (variable.contrast?.kind === "binary_presence") return true;
  const condition = variable.semantic_condition;
  return condition?.kind === "concept"
    ? condition.assertion === "present"
    : condition?.kind === "event_exists" && condition.occurrence === "present";
};
// A yes/no variable read from event records (items, codes, matching values) is "no" when there is no record, unless its
// condition explicitly asks about an absence.
const absentRecordMeansFalse = (variable: ExecutionManifestVariable): boolean => variable.value_type === "binary"
  && variable.value_rule.kind !== "direct"
  && (representsRecordedPresence(variable) || !variable.semantic_condition);

/** Executes a catalog-verified relational manifest against a local ZIP without accepting SQL. */
export interface GraphRunnerProgress { source_id: string; rows_read: number; done: boolean }

export class LocalExecutionGraphRunner {
  /** `on_progress` is called every million rows read and once per finished source, so long scans stay visible. */
  /** `expected_layer` is what the derived layer must have been built from: the fingerprint of the diagnosis definitions and the derived item ids the pack uses (see derived-layer.ts). */
  constructor(private readonly options: { on_progress?: (event: GraphRunnerProgress) => void; expected_layer?: { fingerprint: string; items: readonly number[] } } = {}) {}

  async run(archivePath: string, manifest: ExecutionManifest): Promise<LocalExecutionGraphResult> {
    return (await this.runMany(archivePath, [manifest]))[0]!;
  }

  /**
   * Runs several manifests reading each archive table once per compatible group. Manifests are compatible when they
   * share the analysis unit, the time-zero definition and their joins. Identical variable computations (same table,
   * rule, window and aggregation) are stored once per unit and shared, so memory stays close to a single run.
   * Each result is identical to running its manifest alone.
   */
  async runMany(archivePath: string, manifests: ExecutionManifest[]): Promise<LocalExecutionGraphResult[]> {
    for (const manifest of manifests) {
      if (manifest.status !== "ready" || manifest.blockers.length) throw new Error("Only a ready execution manifest can read local MIMIC data.");
      if (!manifest.analysis_unit) throw new Error("The execution manifest has no analysis unit.");
    }
    const members = await listArchiveMembers(archivePath);
    const derived = manifests.some((manifest) => manifest.sources.some((source) => source.schema === "mimiciv_derived"))
      ? await listArchiveMembers(derivedArchivePath(archivePath)).catch(() => { throw new Error(`A derived variable is used but the derived-variable layer was not found next to the archive (${derivedArchivePath(archivePath)}). 缺少衍生变量层：请复制安装指南里“一条命令完成安装”那一步的整条命令（含 BUILD_DERIVED=1）再运行。/ Copy the whole command of the guide's "Install with one command" step (including BUILD_DERIVED=1) and run it again.`); })
      : [];
    if (derived.length && this.options.expected_layer) await this.checkLayer(archivePath);
    const prepared = manifests.map((manifest) => prepareManifest(manifest));
    const groups: PreparedManifest[][] = [];
    for (const item of prepared) {
      const group = groups.find((candidate) => compatible(candidate[0]!, item) && candidate.every((other) => joinsConsistent(other, item)));
      if (group) group.push(item); else groups.push([item]);
    }
    const results = new Map<PreparedManifest, LocalExecutionGraphResult>();
    for (const group of groups) {
      const scan = await this.scan(archivePath, members, group, derived);
      for (const item of group) results.set(item, finalize(item, scan));
    }
    return prepared.map((item) => results.get(item)!);
  }

  private async checkLayer(archivePath: string): Promise<void> {
    const rebuild = "衍生变量层需要重建：请删除 MIMIC 数据文件旁边的 mimic-iv-3.1-derived.zip，再复制安装指南里“一条命令完成安装”那一步的整条命令（含 BUILD_DERIVED=1）运行。/ Rebuild it: delete mimic-iv-3.1-derived.zip next to the MIMIC data file, then run the whole command of the guide's \"Install with one command\" step (including BUILD_DERIVED=1).";
    const text = await new Promise<string>((resolve, reject) => {
      const child = spawn("unzip", ["-p", derivedArchivePath(archivePath), "derived/layer.json"], { stdio: ["ignore", "pipe", "ignore"] }); const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk)); child.once("error", reject); child.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    let built: { diagnosis_fingerprint?: string; items?: number[] } | undefined;
    try { built = JSON.parse(text) as { diagnosis_fingerprint?: string; items?: number[] }; } catch { built = undefined; }
    if (!built?.diagnosis_fingerprint) throw new Error(`The derived-variable layer has no record of the definitions it was built from. ${rebuild}`);
    const expected = this.options.expected_layer!;
    if (built.diagnosis_fingerprint !== expected.fingerprint) throw new Error(`The derived-variable layer was built from other diagnosis definitions than the current ones. ${rebuild}`);
    const present = new Set(built.items ?? []); const missing = expected.items.filter((item) => !present.has(item));
    if (missing.length) throw new Error(`The derived-variable layer lacks ${missing.length} derived item(s) the concept pack uses (for example ${missing[0]}). ${rebuild}`);
  }

  private async scan(archivePath: string, members: string[], group: PreparedManifest[], derivedMembers: string[] = []): Promise<ScanState> {
    const first = group[0]!.manifest;
    const analysisUnit = first.analysis_unit!;
    // Union of sources and joins in an order where every joined table follows the table it joins to.
    const sources = new Map<string, ExecutionManifest["sources"][number]>(); const joins = new Map<string, ExecutionManifest["joins"][number]>();
    for (const { manifest } of group) { for (const source of manifest.sources) if (!sources.has(source.id)) sources.set(source.id, source); for (const join of manifest.joins) if (!joins.has(join.right_source_id)) joins.set(join.right_source_id, join); }
    const ordered: string[] = []; const pending = [...sources.keys()];
    // The table that gives time zero (the ICU stays) is read before the tables whose events are placed in windows from time zero:
    // an event read before its unit has a time zero would escape its window (a "28-day" death counted at any time).
    const indexSources = new Set(group.flatMap(({ manifest }) => manifest.variables.filter(({ role }) => role === "index_time").map(({ source_id }) => source_id)));
    const readable = (id: string): boolean => id === analysisUnit.source_id ? true : ordered.includes(joins.get(id)?.left_source_id ?? "\u0000");
    while (pending.length) {
      const early = pending.findIndex((id) => indexSources.has(id) && readable(id));
      const next = early >= 0 ? early : pending.findIndex(readable);
      if (next < 0) throw new Error("The execution manifests have a join that cannot be ordered.");
      ordered.push(...pending.splice(next, 1));
    }
    const memberBySource = new Map<string, string>();
    for (const id of ordered) {
      const source = sources.get(id)!;
      const isDerived = source.schema === "mimiciv_derived";
      const suffix = `/${moduleDirectory(source.schema)}/${source.table}.csv.gz`; const matches = (isDerived ? derivedMembers : members).filter((member) => isDerived ? member === `derived/${source.table}.csv.gz` : member.endsWith(suffix));
      if (matches.length !== 1) throw new Error(`Expected exactly one archive member for ${source.id}.`); memberBySource.set(source.id, matches[0]!);
    }
    const computations = new Map<string, Computation>();
    for (const item of group) for (const computation of item.computations) { const id = `${computation.key}|${computation.signature}`; if (!computations.has(id)) computations.set(id, computation); }
    const units = new Map<string, Unit>(); const indexes = new Map<string, Map<string, Set<string>>>(); const sourceRows: Record<string, number> = {};
    // A derived event of the whole admission (acute kidney injury, readmission) carries no stay; an ICU-stay analysis unit then
    // reads it through the admission, and the time windows decide which stay it belongs to.
    const admissionFallback = (join: ExecutionManifest["joins"][number]): boolean => join.left_column === "stay_id" && join.right_column === "stay_id" && sources.get(join.right_source_id)?.schema === "mimiciv_derived";
    // With ICU stays as the unit and a follow-up start, a record keyed by stay (ventilation, vasopressors) was already there for the
    // later ICU stays of the same admission, as an admission-keyed one is: it is offered to them to make them ineligible.
    const laterStays = analysisUnit.column === "stay_id" && [...computations.values()].some(flagsBeforeFollowUp);
    const admissionKey = `${analysisUnit.source_id}:hadm_id`;
    const indexedJoinKeys = new Set([...joins.values()].flatMap((join) => [`${join.left_source_id}:${join.left_column}`, ...(admissionFallback(join) ? [`${join.left_source_id}:hadm_id`] : [])]));
    if (laterStays) indexedJoinKeys.add(admissionKey);
    const addIndex = (sourceId: string, column: string, value: string, unitId: string): void => { const key = `${sourceId}:${column}`; const index = indexes.get(key) ?? new Map<string, Set<string>>(); const ids = index.get(value) ?? new Set<string>(); ids.add(unitId); index.set(value, ids); indexes.set(key, index); };
    const indexKey = group[0]!.index_key;
    for (const id of ordered) {
      const source = sources.get(id)!;
      const member = memberBySource.get(source.id)!; const sourceArchive = source.schema === "mimiciv_derived" ? derivedArchivePath(archivePath) : archivePath; const sourceComputations = [...computations.values()].filter((computation) => computation.variable.source_id === source.id); let seen = 0;
      const incoming = joins.get(source.id);
      const encounterRow = source.id === analysisUnit.source_id || (incoming !== undefined && ["hadm_id", "stay_id"].includes(incoming.right_column));
      // Item-filtered tables (chartevents, labevents…) are prefiltered by item id when every variable on them names its items.
      const itemFilters = sourceComputations.map(({ variable }) => { const rule = variable.value_rule; return rule.kind === "item_ids" ? rule.ids.map(String) : rule.kind === "weighted_amount" ? [...new Set(rule.conversions.map(({ item_id }) => String(item_id)))] : rule.kind === "matching_values" ? (rule.column === "itemid" ? rule.values : rule.also?.find(({ column }) => column === "itemid")?.values) : undefined; });
      const itemIds = itemFilters.every((ids) => ids?.length) ? [...new Set(itemFilters.flat() as string[])] : [];
      const sourceRowsInput = itemIds.length ? streamArchiveRowsFiltered(sourceArchive, member, { column: "itemid", values: itemIds }) : streamArchiveRows(sourceArchive, member);
      for await (const row of sourceRowsInput) {
        seen += 1; let unitIds: Iterable<string>;
        if (seen % 1_000_000 === 0) this.options.on_progress?.({ source_id: source.id, rows_read: seen, done: false });
        if (source.id === analysisUnit.source_id) { const unitId = String(row[analysisUnit.column] ?? ""); if (!unitId) continue; if (!units.has(unitId)) units.set(unitId, { identifiers: new Map(), values: new Map() }); unitIds = [unitId]; }
        else if (incoming) { const joinValue = String(row[incoming.right_column] ?? ""); unitIds = joinValue === "" && admissionFallback(incoming) ? indexes.get(`${incoming.left_source_id}:hadm_id`)?.get(String(row.hadm_id ?? "")) ?? [] : indexes.get(`${incoming.left_source_id}:${incoming.left_column}`)?.get(joinValue) ?? []; }
        else continue;
        for (const unitId of unitIds) { const unit = units.get(unitId)!; for (const column of identifierPriority) { const value = row[column]; if (value === undefined || value === null || value === "") continue; const key = `${source.id}:${column}`; unit.identifiers.set(key, String(value)); if (indexedJoinKeys.has(key)) addIndex(source.id, column, String(value), unitId); } for (const computation of sourceComputations) processValue(unit, computation, row, indexKey, analysisUnit.column, encounterRow); }
        if (laterStays && incoming?.right_column === "stay_id" && source.id !== analysisUnit.source_id) {
          const own = new Set(unitIds);
          const stays = new Set([...own].flatMap((unitId) => [...(indexes.get(admissionKey)?.get(units.get(unitId)!.identifiers.get(admissionKey) ?? "") ?? [])]));
          for (const stayId of stays) if (!own.has(stayId)) for (const computation of sourceComputations) processValue(units.get(stayId)!, computation, row, indexKey, analysisUnit.column, true, "later_stay");
        }
      }
      sourceRows[source.id] = seen;
      this.options.on_progress?.({ source_id: source.id, rows_read: seen, done: true });
    }
    return { units, source_rows: sourceRows };
  }
}

type Unit = { identifiers: Map<string, string>; values: Map<string, ValueState> };
type ScanState = { units: Map<string, Unit>; source_rows: Record<string, number> };
/** One stored computation: a variable with its effective window; `key` identifies identical computations across manifests. */
type Computation = { key: string; signature: string; variable: ExecutionManifestVariable & { codeKeys?: Set<string> }; window?: TimeWindowLike; landmark_ms?: number; prediction_ms?: number; derivation_windows?: { baseline: TimeWindowLike | undefined; follow_up: TimeWindowLike | undefined } };
type TimeWindowLike = NonNullable<ExecutionManifest["time_windows"]>[number];
type PreparedManifest = { manifest: ExecutionManifest; variables: Array<ExecutionManifestVariable & { alias: string; key: string }>; computations: Computation[]; index_key: string };

/** Values a manifest reads, by its own alias, from the shared per-unit store. */
const viewOf = (unit: Unit, keys: Map<string, string>) => ({ get: (alias: string): ValueState | undefined => unit.values.get(keys.get(alias) ?? alias) });

/**
 * A prediction is made when its predictor window ends (study-spec compiler): a unit discharged or dead before then, or
 * with a dated record of a timed event outcome before then (after time zero, or earlier in the same encounter), is not
 * eligible, so an outcome that happens while the predictors are measured, or was already present, is never predicted.
 * Milliseconds after time zero; undefined for other designs.
 */
const predictionTimeMs = (manifest: ExecutionManifest): number | undefined => {
  if (manifest.study_family !== "prediction") return undefined;
  const window = manifest.time_windows?.find(({ purpose }) => purpose === "baseline");
  const ms = window && "end_offset" in window ? window.end_offset * (timeUnitMs[window.unit] ?? 0) : 0;
  return ms > 0 ? ms : undefined;
};
const timedEventOutcome = (variable: ExecutionManifestVariable): boolean => variable.role === "outcome" && !variable.characteristic && variable.contrast?.kind === "binary_presence" && !variable.derivation;
/** A timed event outcome of a design whose follow-up starts after time zero: a record of it before then makes the unit ineligible. */
const flagsBeforeFollowUp = (computation: Computation): boolean => timedEventOutcome(computation.variable) && Boolean(computation.prediction_ms ?? computation.landmark_ms);
/** The analysis column of a variable: the exposure and outcome conditions of several alternatives share one column. */
const columnOf = (variable: ExecutionManifestVariable & { alias: string }): string => !variable.characteristic && variable.condition_id && (variable.role === "exposure" || variable.role === "outcome") ? variable.role : variable.alias;

const prepareManifest = (manifest: ExecutionManifest): PreparedManifest => {
  const aliasCounters: Record<string, number> = {};
  const draft = manifest.variables.map((variable, index) => {
    const alias = aliasFor(variable, aliasCounters) || `variable_${index}`;
    const purpose = variable.role === "outcome" ? "outcome" : variable.role === "exposure" ? "exposure" : variable.role === "predictor" || variable.role === "covariate" ? "baseline" : undefined;
    // An event condition may carry its own window; otherwise the study window for the variable's purpose applies.
    const conditionWindow = variable.semantic_condition?.kind === "event_exists" ? variable.semantic_condition.window : undefined;
    const window = variable.role === "index_time" ? undefined : conditionWindow ?? (purpose ? manifest.time_windows?.find((candidate) => candidate.purpose === purpose) : undefined);
    const derivationWindows = variable.derivation ? {
      baseline: manifest.time_windows?.find((candidate) => candidate.purpose === variable.derivation!.baseline.purpose),
      follow_up: manifest.time_windows?.find((candidate) => candidate.purpose === variable.derivation!.follow_up.purpose),
    } : undefined;
    // Outcomes of a landmark manifest count only after the landmark (a different computation from counting at time zero).
    const landmarkMs = variable.role === "outcome" && manifest.extraction?.landmark_hours ? manifest.extraction.landmark_hours * 3_600_000 : undefined;
    const predictionMs = timedEventOutcome(variable) ? predictionTimeMs(manifest) : undefined;
    const signature = createHash("sha256").update(JSON.stringify([variable.role === "index_time", variable.source_id, variable.value_rule, variable.value_type, variable.time_column ?? null, variable.aggregation ?? null, variable.valid_range ?? null, variable.derivation ?? null, window ?? null, derivationWindows ?? null, landmarkMs ?? null, predictionMs ?? null])).digest("hex").slice(0, 24);
    const computation = { signature, variable: { ...variable, ...(variable.value_rule.kind === "codes" ? { codeKeys: new Set(variable.value_rule.codes.map(({ code, version }) => `${version}:${code}`)) } : {}) }, ...(window ? { window } : {}), ...(landmarkMs ? { landmark_ms: landmarkMs } : {}), ...(predictionMs ? { prediction_ms: predictionMs } : {}), ...(derivationWindows ? { derivation_windows: derivationWindows } : {}) };
    return { variable, alias, computation };
  });
  // Variables sharing an alias (the components of a composite outcome) aggregate into one state, as in a single run;
  // the shared key is derived from all their signatures so it is shared only with an identical group elsewhere.
  const byAlias = new Map<string, string[]>();
  for (const { alias, computation } of draft) byAlias.set(alias, [...(byAlias.get(alias) ?? []), computation.signature]);
  const keyOf = (alias: string): string => { const signatures = byAlias.get(alias)!; return `c:${signatures.length === 1 ? signatures[0] : createHash("sha256").update(JSON.stringify([...signatures].sort())).digest("hex").slice(0, 24)}`; };
  const computations: Computation[] = draft.map(({ alias, computation }) => ({ ...computation, key: keyOf(alias) }));
  const variables = draft.map(({ variable, alias }) => ({ ...variable, alias, key: keyOf(alias) }));
  const indexKey = variables.find(({ role }) => role === "index_time")?.key ?? "index_time";
  return { manifest, variables, computations, index_key: indexKey };
};
const compatible = (left: PreparedManifest, right: PreparedManifest): boolean =>
  JSON.stringify(left.manifest.analysis_unit) === JSON.stringify(right.manifest.analysis_unit) && left.index_key === right.index_key;
const joinsConsistent = (left: PreparedManifest, right: PreparedManifest): boolean => right.manifest.joins.every((join) => {
  const other = left.manifest.joins.find(({ right_source_id }) => right_source_id === join.right_source_id);
  return !other || JSON.stringify(other) === JSON.stringify(join);
});

/** `encounterRow`: the row is the analysis unit's own or joined to it by admission or stay, so it belongs to the index encounter (not to another admission of the patient). */
/** `scope` "later_stay": the row belongs to another ICU stay of the unit's admission and only marks an outcome recorded before this stay. */
const processValue = (unit: Unit, computation: Computation, row: LocalMimicRow, indexKey: string, analysisColumn: string, encounterRow: boolean, scope: "unit" | "later_stay" = "unit"): void => {
  const variable = computation.variable; const key = computation.key;
  if (scope === "later_stay" && (!flagsBeforeFollowUp(computation) || computation.variable.value_rule.kind === "code_score")) return;
  let raw: unknown;
  const rule = variable.value_rule;
  if (variable.role === "index_time" && scope === "unit") {
    // The encounter end on the same row bounds follow-up for encounter-limited outcomes.
    const end = eventTimestamp(row.dischtime ?? row.outtime);
    if (Number.isFinite(end)) unit.values.set("index_end", { value: end, count: 1 });
  }
  // An outcome row that carries its own encounter end (an admission's discharge) says how long that encounter lasted; with an ICU index
  // the hospital admission outlasts the stay, and an in-hospital outcome is followed to hospital discharge, not to ICU discharge.
  if (variable.role === "outcome" && scope === "unit") {
    const end = eventTimestamp(row.dischtime ?? row.outtime);
    if (Number.isFinite(end) && !(Number(unit.values.get(`${key}:encounter_end`)?.value) >= end)) unit.values.set(`${key}:encounter_end`, { value: end, count: 1 });
  }
  // A binary variable read from its own timestamp column means "the event has a recorded time" (e.g. date of death).
  if (rule.kind === "direct" && variable.value_type === "binary" && rule.column === variable.time_column) raw = row[rule.column] ? true : undefined;
  else if (rule.kind === "direct") raw = row[rule.column];
  // A yes/no item variable (vasopressor infusion, ventilation event) is present when a record of the item exists; its
  // amount or duration is not a yes/no value.
  else if (rule.kind === "item_ids") raw = rule.ids.includes(Number(row[rule.id_column])) ? (variable.value_type === "binary" ? true : row[rule.value_column]) : undefined;
  else if (rule.kind === "weighted_amount") {
    const unit = String(row[rule.unit_column] ?? "").trim().toLocaleLowerCase(); const amount = Number(row[rule.value_column]);
    const factor = rule.conversions.find((entry) => entry.item_id === Number(row[rule.id_column]) && entry.unit.toLocaleLowerCase() === unit)?.factor;
    raw = factor !== undefined && Number.isFinite(amount) && row[rule.value_column] !== "" ? amount * factor : undefined;
  }
  else if (rule.kind === "codes") raw = variable.codeKeys?.has(`${Number(row[rule.version_column])}:${String(row[rule.code_column])}`) ? true : undefined;
  else if (rule.kind === "code_score") {
    // Record which weighted groups this unit has; the score is summed once all rows are read.
    const code = String(row[rule.code_column] ?? ""); const version = Number(row[rule.version_column]);
    const groups = rule.groups.filter(({ code_prefixes }) => code_prefixes.some(({ prefix, version: expected }) => expected === version && code.startsWith(prefix))).map(({ group_id }) => group_id);
    if (!groups.length) return;
    const present = (unit.values.get(key)?.value as Set<string> | undefined) ?? new Set<string>();
    for (const group of groups) present.add(group);
    unit.values.set(key, { value: present, count: present.size });
    return;
  }
  else {
    const matches = (column: string, values: string[]): boolean => values.some((value) => String(row[column]).toLocaleLowerCase() === value.toLocaleLowerCase());
    raw = matches(rule.column, rule.values) && (rule.also ?? []).every(({ column, values }) => matches(column, values)) ? true : undefined;
  }
  if (raw === undefined || raw === null || raw === "") return;
  const value = toValue(raw, variable.value_type); if (value === undefined) return;
  // Values outside the mapping's plausible range are charting artifacts and are ignored (exclusive bounds).
  if (variable.valid_range && typeof value === "number" && ((variable.valid_range.min !== undefined && value <= variable.valid_range.min) || (variable.valid_range.max !== undefined && value >= variable.valid_range.max))) return;
  const eventTime = variable.time_column ? eventTimestamp(row[variable.time_column]) : undefined; const indexState = unit.values.get(indexKey);
  if (scope === "later_stay") {
    if (value === true && Number.isFinite(eventTime) && indexState && eventTime! < Date.parse(String(indexState.value))) unit.values.set(`${key}:before_follow_up`, { value: true, count: 1 });
    return;
  }
  if (variable.derivation) {
    if (!Number.isFinite(eventTime) || !indexState) return;
    const origin = Date.parse(String(indexState.value));
    if (!Number.isFinite(origin)) throw new Error(`The index-time mapping for ${variable.requested_label} did not produce a timestamp.`);
    for (const [endpoint, definition] of [["baseline", variable.derivation.baseline], ["follow_up", variable.derivation.follow_up]] as const) {
      const window = computation.derivation_windows?.[endpoint];
      if (!window) continue;
      const included = "end_offset" in window
        ? eventTime! >= origin + window.start_offset * (timeUnitMs[window.unit] ?? 0) && eventTime! < origin + window.end_offset * (timeUnitMs[window.unit] ?? 0)
        : eventTime! >= origin;
      if (!included) continue;
      const stateKey = `${key}:derivation:${endpoint}`;
      unit.values.set(stateKey, aggregate(unit.values.get(stateKey), value, definition.aggregation, eventTime));
    }
    return;
  }
  const window = computation.window;
  // An event whose time is missing or unreadable cannot be placed in a window (e.g. a prescription without a start time).
  if (window && indexState && variable.time_column && !Number.isFinite(eventTime)) return;
  // A timed event outcome already recorded when follow-up starts (the prediction time or the landmark) makes the unit ineligible
  // (see finalize): recorded after time zero, or earlier in the index encounter (acute kidney injury on the ward before the ICU
  // stay that is time zero, or in an earlier ICU stay of the same admission). A record of another admission before time zero
  // is history, not this unit's outcome; an undated record (a diagnosis code) cannot be placed before it and is left to the
  // outcome window.
  const followUpStartMs = flagsBeforeFollowUp(computation) ? computation.prediction_ms ?? computation.landmark_ms : undefined;
  if (followUpStartMs && value === true && Number.isFinite(eventTime) && indexState) {
    const origin = Date.parse(String(indexState.value));
    if (eventTime! < origin + followUpStartMs && (eventTime! >= origin || encounterRow)) { unit.values.set(`${key}:before_follow_up`, { value: true, count: 1 }); return; }
  }
  if (computation.landmark_ms && Number.isFinite(eventTime) && indexState && eventTime! < Date.parse(String(indexState.value)) + computation.landmark_ms) return;
  if (window && Number.isFinite(eventTime) && indexState) {
    const origin = Date.parse(String(indexState.value));
    if (!Number.isFinite(origin)) throw new Error(`The index-time mapping for ${variable.requested_label} did not produce a timestamp.`);
    if (!("end_offset" in window)) {
      if (!(["hadm_id", "stay_id"] as string[]).includes(analysisColumn)) throw new Error(`Encounter-bounded extraction requires an encounter-level analysis unit for ${variable.requested_label}.`);
      // An event recorded on the encounter's own row (an admission's death time) belongs to that encounter, even when time zero is an ICU
      // stay inside it (3.3 counted only deaths up to ICU discharge) and even when the death time is recorded after the discharge time
      // (MIMIC-IV records some in-hospital death times after the discharge time, by up to a day). Events from other rows are bounded by
      // the index encounter.
      const ownEncounter = Number.isFinite(eventTimestamp(row.dischtime ?? row.outtime));
      const encounterEnd = Number(unit.values.get("index_end")?.value);
      // A date-only event (e.g. date of death) on the discharge day belongs to the encounter.
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(String(row[variable.time_column!] ?? ""));
      const endBound = Number.isFinite(encounterEnd) && dateOnly ? endOfDay(encounterEnd) : encounterEnd;
      if (eventTime! < origin || (!ownEncounter && Number.isFinite(endBound) && eventTime! > endBound)) return;
    } else {
      const unitMs = timeUnitMs[window.unit] ?? 0; const start = origin + window.start_offset * unitMs; const end = origin + window.end_offset * unitMs;
      // A window includes its start and excludes its end, so consecutive windows (0-24 h, 24-72 h) never share an event.
      if (eventTime! < start || eventTime! >= end) return;
    }
  }
  unit.values.set(key, aggregate(unit.values.get(key), value, variable.aggregation, Number.isFinite(eventTime) ? eventTime : undefined));
};

/** Builds one manifest's analysis rows from the shared scan; identical to a stand-alone run of that manifest. */
const finalize = (prepared: PreparedManifest, scan: ScanState): LocalExecutionGraphResult => {
  const { manifest, variables } = prepared; const { units } = scan;
  const keys = new Map<string, string>(variables.map(({ alias, key }) => [alias, key]));
  for (const { alias, key } of variables) for (const endpoint of ["baseline", "follow_up"]) keys.set(`${alias}:derivation:${endpoint}`, `${key}:derivation:${endpoint}`);
  for (const { alias, key } of variables) keys.set(`${alias}:before_follow_up`, `${key}:before_follow_up`);
  for (const { alias, key } of variables) keys.set(`${alias}:encounter_end`, `${key}:encounter_end`);
  const sourceRows = Object.fromEntries(manifest.sources.map(({ id }) => [id, scan.source_rows[id] ?? 0]));
  const rows: ProjectedAnalysisRow[] = []; let baseExcluded = 0; let modelComplete = 0; let notInPopulation = 0;
  const hasExposure = variables.some(({ role }) => role === "exposure");
  // A description has no outcome (its characteristics are described, not modelled): every selected unit is kept, with whatever its
  // grouping and characteristics recorded, and there is no model whose complete cases are counted.
  const describing = !variables.some(({ role, characteristic }) => role === "outcome" && !characteristic);
  const expectedModelAliases = describing ? [] : [...new Set(variables.filter(({ role }) => !["population", "index_time"].includes(role)).map(columnOf))];
  const landmarkMs = (manifest.extraction?.landmark_hours ?? 0) * 3_600_000; let beforeLandmark = 0;
  // A prediction's follow-up starts at its prediction time; time-to-event is still measured from time zero (below).
  const predictionMs = prepared.computations.some(({ prediction_ms }) => prediction_ms) ? predictionTimeMs(manifest) ?? 0 : 0; let outcomeBeforePrediction = 0; let outcomeBeforeLandmark = 0;
  const followUpStartMs = Math.max(landmarkMs, predictionMs);
  const eventOutcomeAliases = [...new Set(variables.filter(timedEventOutcome).map(({ alias }) => alias))];
  // 1. Eligibility, decided with what is known at time zero (or at the landmark or prediction time): a time zero exists,
  //    still in follow-up at the landmark or prediction time, the outcome not yet recorded then (in this encounter), inside
  //    the population. A unit without a time zero (a hospital admission with no ICU stay in an ICU-anchored design) has no
  //    landmark and no windows, so it is not eligible.
  const eligible: string[] = []; let noTimeZero = 0;
  const needsTimeZero = variables.some(({ role }) => role === "index_time");
  for (const [analysis_id, unit] of units) { const values = viewOf(unit, keys);
    if (needsTimeZero && !Number.isFinite(Date.parse(String(values.get("index_time")?.value ?? "")))) { noTimeZero += 1; continue; }
    if (followUpStartMs) { const origin = Date.parse(String(values.get("index_time")?.value ?? "")); const end = Number(values.get("index_end")?.value); if (Number.isFinite(origin) && Number.isFinite(end) && end < origin + followUpStartMs) { beforeLandmark += 1; continue; } }
    if (eventOutcomeAliases.some((alias) => values.get(`${alias}:before_follow_up`))) { if (predictionMs) outcomeBeforePrediction += 1; else outcomeBeforeLandmark += 1; continue; }
    if (manifest.population_predicate && !evaluateCondition(manifest.population_predicate, values)) { notInPopulation += 1; continue; }
    eligible.push(analysis_id);
  }
  // 2. The analysis unit: each patient's earliest eligible unit by index time. It is chosen before anything measured after
  //    time zero is looked at, so a missing exposure or outcome never moves a patient to a later admission.
  let notFirst = 0; let selected = eligible;
  if (manifest.extraction?.unit_selection === "first_per_subject") {
    const earliest = new Map<string, { id: string; at: number }>();
    const subjectOf = (id: string): string | undefined => [...units.get(id)!.identifiers].find(([key]) => key.endsWith(":subject_id"))?.[1];
    const indexAt = (id: string): number => Date.parse(String(viewOf(units.get(id)!, keys).get("index_time")?.value ?? "")) || Number.POSITIVE_INFINITY;
    for (const id of eligible) {
      const subject = subjectOf(id); if (!subject) continue;
      const current = earliest.get(subject); const at = indexAt(id);
      if (!current || at < current.at || (at === current.at && id < current.id)) earliest.set(subject, { id, at });
    }
    const keep = new Set([...earliest.values()].map(({ id }) => id));
    selected = eligible.filter((id) => !subjectOf(id) || keep.has(id));
    notFirst = eligible.length - selected.length;
  }
  // 3. The selected unit's exposure and outcome; a unit missing either is excluded (missing data), not replaced.
  for (const analysis_id of selected) { const values = viewOf(units.get(analysis_id)!, keys);
    const row: Record<string, unknown> = { analysis_id }; for (const variable of variables) { const state = values.get(variable.alias); let value: unknown; if (variable.derivation) { const baseline = finalizedValue(values.get(`${variable.alias}:derivation:baseline`), variable.derivation.baseline.aggregation); const followUp = finalizedValue(values.get(`${variable.alias}:derivation:follow_up`), variable.derivation.follow_up.aggregation); if (baseline !== undefined && followUp !== undefined) value = variable.derivation.direction === "baseline_minus_follow_up" ? Number(baseline) - Number(followUp) : Number(followUp) - Number(baseline); } else if (variable.value_rule.kind === "code_score") value = codeScore(variable.value_rule.groups, state?.value as Set<string> | undefined); else value = finalizedValue(state, variable.aggregation); if (variable.contrast?.kind === "binary_presence") value = variable.value_rule.kind === "direct" && variable.value_type === "binary" ? Boolean(state?.value) : Boolean(state); else if (value === undefined && absentRecordMeansFalse(variable)) value = variable.aggregation === "sum" || variable.aggregation === "count" ? 0 : false; /* a summed or counted quantity with no record is 0, not "false" */ if (variable.contrast?.kind === "threshold" && value !== undefined) { const observed = Number(value); const threshold = variable.contrast.value; value = variable.contrast.operator === "gt" ? observed > threshold : variable.contrast.operator === "gte" ? observed >= threshold : variable.contrast.operator === "lt" ? observed < threshold : observed <= threshold; } const analysisAlias = columnOf(variable); if (value !== undefined && variable.role !== "population" && variable.role !== "index_time") // An outcome or exposure written as several alternatives is present when any alternative is.
 row[analysisAlias] = (analysisAlias === "outcome" || analysisAlias === "exposure") && row[analysisAlias] === true && value === false ? true : value; } const inputsReady = describing || (manifest.study_family === "prediction" ? Object.keys(row).some((key) => key.startsWith("predictor_")) : !hasExposure || row.exposure !== undefined); if (!inputsReady || (!describing && row.outcome === undefined)) { baseExcluded += 1; continue; } rows.push(row as ProjectedAnalysisRow); }
  const timing = manifest.extraction?.outcome_timing;
  if (timing) {
    const horizonMs = timing.horizon_days * DAY_MS;
    // A composite outcome has several component variables; the earliest recorded component is the event.
    const outcomeAliases = variables.filter(({ role }) => role === "outcome").map(({ alias }) => alias);
    for (const row of rows) {
      const values = viewOf(units.get(row.analysis_id)!, keys);
      const origin = Date.parse(String(values.get("index_time")?.value ?? "")) + landmarkMs;
      if (!Number.isFinite(origin)) { delete (row as Record<string, unknown>).outcome; continue; }
      const eventTimes = outcomeAliases.map((alias) => values.get(alias)).filter((state) => state && state.value !== false && state.time !== undefined).map((state) => state!.time!);
      const eventAt = eventTimes.length ? Math.min(...eventTimes) : undefined;
      // Follow-up ends with the later of the index encounter and the outcome's own encounter (hospital discharge for in-hospital death with an
      // ICU index; never cut short to an ICU stay when time zero is the hospital admission).
      const ends = [Number(values.get("index_end")?.value), ...outcomeAliases.map((alias) => Number(values.get(`${alias}:encounter_end`)?.value))].filter(Number.isFinite);
      const end = ends.length ? Math.max(...ends) : Number.NaN;
      const censorMs = timing.follow_up === "encounter" && Number.isFinite(end) ? Math.min(horizonMs, Math.max(0, endOfDay(end) - origin)) : horizonMs;
      const occurred = row.outcome === true && eventAt !== undefined && eventAt - origin <= censorMs;
      // Cox models need positive times; same-instant events are placed one hour after time zero.
      const record = row as Record<string, unknown>;
      record.event = occurred ? 1 : 0;
      record.time = Math.max(occurred ? (eventAt! - origin) / DAY_MS : censorMs / DAY_MS, 1 / 24);
    }
  }
  modelComplete = rows.filter((row) => expectedModelAliases.every((alias) => row[alias] !== undefined && row[alias] !== null && row[alias] !== "")).length;
  const incompleteModel = rows.length - modelComplete;
  const excluded = noTimeZero + baseExcluded + incompleteModel + notFirst + notInPopulation + beforeLandmark + outcomeBeforeLandmark + outcomeBeforePrediction;
  rows.sort((a, b) => a.analysis_id.localeCompare(b.analysis_id)); const aggregateEvidence = { manifest_id: manifest.manifest_id, rows: rows.map(({ analysis_id: _id, ...row }) => row), source_rows: sourceRows, excluded };
  const columns = variables.filter(({ role }) => role !== "population" && role !== "index_time").map((variable) => ({ column: columnOf(variable), role: variable.role, ...(variable.characteristic ? { characteristic: true } : {}), requested_label: variable.requested_label, mapping_id: variable.mapping_id, value_type: variable.value_type, ...(variable.aggregation ? { aggregation: variable.aggregation } : {}) }));
  return { rows, columns, quality: { source_rows: sourceRows, analysis_units: units.size, complete_rows: modelComplete, excluded_rows: excluded, exclusion_reasons: { ...(noTimeZero ? { no_time_zero: noTimeZero } : {}), ...(beforeLandmark ? { ended_before_landmark: beforeLandmark } : {}), ...(outcomeBeforeLandmark ? { outcome_before_landmark: outcomeBeforeLandmark } : {}), ...(outcomeBeforePrediction ? { outcome_before_prediction_time: outcomeBeforePrediction } : {}), ...(notInPopulation ? { not_in_population: notInPopulation } : {}), ...(notFirst ? { not_first_eligible_unit_of_patient: notFirst } : {}), ...(baseExcluded ? { incomplete_required_variables: baseExcluded } : {}), ...(incompleteModel ? { incomplete_model_variables: incompleteModel } : {}) } }, cohort_integrity_id: `sha256:${createHash("sha256").update(JSON.stringify(aggregateEvidence)).digest("hex")}` };
};
