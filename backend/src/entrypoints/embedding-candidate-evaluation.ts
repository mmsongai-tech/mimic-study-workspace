import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBackendRuntimeConfig } from "../runtime/index.js";
import { alternativeForms, VariableDefinitionStore, type SynonymTable, type VariableDefinition } from "../variable-definitions/index.js";
import {
  EmbeddingAugmentedTerminologySearch, entryCarriesRequest, FileDictionaryEmbeddingIndexRepository, FileDrugClassRepository, LocalArchiveMimicTerminologySearchClient,
  OpenAiCompatibleTextEmbeddingClient, VariableMappingDiscoveryService,
  type ClinicalTermExpander, type ClinicalTermExpansion, type DrugClassKnowledge, type MimicTerminologyMatch, type MimicTerminologySearchGateway, type VariableMappingCandidate,
  type VariableMappingRecord, type VariableMappingRepository, type VariableMappingStatus,
} from "../variable-mapping/index.js";

// Candidate-level comparison of text search with and without embedding retrieval (BGE-M3), at the same candidate budget.
// Usage: MIMIC_LOCAL_ARCHIVE=/path/mimic-iv-3.1.zip node --import tsx backend/src/entrypoints/embedding-candidate-evaluation.ts --out DIR
// Needs the embedding index (build-dictionary-embedding-index.ts) and the embedding model served at config variable_mapping.embedding_search.
// Gold: (a) every pack concept and shared variable definition with dictionary identifiers, queried by each of its names; (b) the past
// failure terms and (c) near-opposite traps of validation-fixtures/embedding-retrieval/terms.json. Writes aggregate metrics and, under
// DIR (which must be under .local/: it holds MIMIC dictionary labels), per-query details for review. Prints aggregates only.

type Dictionary = MimicTerminologyMatch["dictionary"];
const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const key = (entry: { dictionary: Dictionary; identifier: string; code_version?: 9 | 10 }): string => `${entry.dictionary}|${entry.code_version ?? ""}|${entry.identifier}`;
const SMALL_BUDGET = 10;
// The pipeline's own budgets: at most 10 item candidates, 250 codes per code set, 100 drug labels per label set.
const PIPELINE_BUDGET: Record<Dictionary, number> = { d_labitems: 10, d_items: 10, d_icd_diagnoses: 250, d_icd_procedures: 250, prescriptions_drug: 100 };
const CATEGORY: Record<Dictionary, ClinicalTermExpansion["category"]> = { d_labitems: "laboratory", d_items: "vital_sign", d_icd_diagnoses: "diagnosis", d_icd_procedures: "intervention", prescriptions_drug: "medication" };
const ROLE: Record<Dictionary, VariableMappingCandidate["role"]> = { d_labitems: "covariate", d_items: "covariate", d_icd_diagnoses: "population", d_icd_procedures: "exposure", prescriptions_drug: "exposure" };
const han = (text: string): boolean => /\p{Script=Han}/u.test(text);

interface Spec { concept?: string; drug_class?: string; label_contains?: string[]; label_pattern?: string; icd10?: string[]; icd9?: string[]; icd_pattern?: string }
interface Query { set: "concept" | "failure" | "trap"; id: string; query: string; en?: string; dictionary: Dictionary; gold: Set<string>; trap: Set<string>; no_right_answer: boolean }

class MemoryMappings implements VariableMappingRepository {
  private readonly records = new Map<string, VariableMappingRecord>();
  async save(record: VariableMappingRecord): Promise<boolean> { this.records.set(record.mapping_id, structuredClone(record)); return true; }
  async findById(mappingId: string): Promise<VariableMappingRecord | undefined> { return this.records.get(mappingId); }
  async findByTerm(): Promise<VariableMappingRecord[]> { return []; }
  async listByStatus(statuses: VariableMappingStatus[]): Promise<VariableMappingRecord[]> { return [...this.records.values()].filter(({ status }) => statuses.includes(status)); }
}

const main = async (): Promise<void> => {
  const archivePath = argument("--archive") ?? process.env.MIMIC_LOCAL_ARCHIVE;
  const out = argument("--out");
  if (!archivePath || !out) throw new Error("Pass --out DIR (under .local/) and set MIMIC_LOCAL_ARCHIVE.");
  const config = resolveBackendRuntimeConfig();
  const settings = config.variable_mapping.embedding_search;
  const text = new LocalArchiveMimicTerminologySearchClient(archivePath, { cacheDirectory: join(config.clinical_database.local_evidence_cache_path, "terminology") });
  const index = await new FileDictionaryEmbeddingIndexRepository(settings.index_directory).load(settings.model);
  const latencies: number[] = [];
  const timed = new OpenAiCompatibleTextEmbeddingClient({ base_url: settings.base_url, model: settings.model, timeout_ms: settings.timeout_ms });
  const embedder = { model: timed.model, embed: async (texts: string[]) => { const started = performance.now(); const result = await timed.embed(texts); latencies.push(performance.now() - started); return result; } };
  let failures = 0;
  const embedding = new EmbeddingAugmentedTerminologySearch(text, index, embedder, { neighbours: settings.neighbours, onUnavailable: () => { failures += 1; } });
  const drugClasses = await new FileDrugClassRepository(new URL("../../../config/drug-classes/drug-classes.json", import.meta.url)).load();
  const synonyms = JSON.parse(await readFile(new URL("../../../config/dictionary-synonyms/synonyms.json", import.meta.url), "utf8")) as SynonymTable;
  const fixture = JSON.parse(await readFile(new URL("../validation-fixtures/embedding-retrieval/terms.json", import.meta.url), "utf8")) as { terms: Array<{ id: string; set: "failure" | "trap"; query: string; en?: string; dictionary: Dictionary; right: Spec; trap: Spec }> };

  // The scored universe: entries embedding search can return (ICD codes that occur in the data, every other dictionary entry).
  const universe = new Map<Dictionary, MimicTerminologyMatch[]>();
  for (const entry of index.entries) universe.set(entry.dictionary, [...(universe.get(entry.dictionary) ?? []), entry]);
  const indexed = new Set(index.entries.map(key));

  // Gold identifiers of every concept with dictionary identifiers.
  const pack = JSON.parse(await readFile(new URL("../../../config/mappings/mimic-iv-core.json", import.meta.url), "utf8")) as { mappings: VariableMappingRecord[] };
  const definitions = await new VariableDefinitionStore(config.variable_definitions.shared_directory).list();
  const conceptGold = new Map<string, { names: string[]; en: string; dictionary: Dictionary; ids: Set<string> }>();
  for (const mapping of pack.mappings) {
    const source = mapping.sources[0];
    if (!source || source.schema === "mimiciv_derived") continue;
    const names = [mapping.labels.en, mapping.labels.zh, ...mapping.synonyms].filter((name): name is string => Boolean(name));
    if (source.item_ids?.length && (source.dictionary_table === "d_items" || source.dictionary_table === "d_labitems")) conceptGold.set(mapping.concept_id, { names, en: mapping.labels.en, dictionary: source.dictionary_table, ids: new Set(source.item_ids.map((id) => key({ dictionary: source.dictionary_table as Dictionary, identifier: String(id) }))) });
    else if (source.codes?.length && source.kind === "diagnosis_code") conceptGold.set(mapping.concept_id, { names, en: mapping.labels.en, dictionary: "d_icd_diagnoses", ids: new Set(source.codes.map(({ code, version }) => key({ dictionary: "d_icd_diagnoses", identifier: code, code_version: version as 9 | 10 }))) });
    else if (source.kind === "medication_label" && source.value_filters?.length) conceptGold.set(mapping.concept_id, { names, en: mapping.labels.en, dictionary: "prescriptions_drug", ids: new Set(source.value_filters.flatMap(({ values }) => values).map((value) => key({ dictionary: "prescriptions_drug", identifier: value }))) });
  }
  const fromDefinition = (definition: VariableDefinition): { dictionary: Dictionary; ids: Set<string> } | undefined => {
    if (definition.items?.item_ids.length) { const dictionary: Dictionary = definition.items.table === "labevents" ? "d_labitems" : "d_items"; return { dictionary, ids: new Set(definition.items.item_ids.map((id) => key({ dictionary, identifier: String(id) }))) }; }
    if (definition.drug?.input_item_ids?.length) return { dictionary: "d_items", ids: new Set(definition.drug.input_item_ids.map((id) => key({ dictionary: "d_items", identifier: String(id) }))) };
    if (definition.drug?.prescription_labels?.length) return { dictionary: "prescriptions_drug", ids: new Set(definition.drug.prescription_labels.map((label) => key({ dictionary: "prescriptions_drug", identifier: label }))) };
    if (definition.diagnosis?.codes.length) return { dictionary: "d_icd_diagnoses", ids: new Set(definition.diagnosis.codes.map(({ code, version }) => key({ dictionary: "d_icd_diagnoses", identifier: code.replace(/\*$/u, ""), code_version: version }))) };
    return undefined;
  };
  for (const definition of definitions) {
    const gold = fromDefinition(definition);
    if (gold) conceptGold.set(definition.definition_id, { names: [definition.labels.en, ...(definition.labels.zh ? [definition.labels.zh] : []), ...definition.synonyms], en: definition.labels.en, ...gold });
  }
  const resolveSpec = (spec: Spec, dictionary: Dictionary): Set<string> => {
    const ids = new Set<string>();
    if (spec.concept) for (const id of conceptGold.get(spec.concept)?.ids ?? []) ids.add(id);
    const entries = universe.get(dictionary) ?? [];
    const drugClass = spec.drug_class ? (drugClasses as DrugClassKnowledge).classes.find(({ class_id }) => class_id === spec.drug_class) : undefined;
    const pattern = spec.label_pattern ? new RegExp(spec.label_pattern, "iu") : undefined; const codePattern = spec.icd_pattern ? new RegExp(spec.icd_pattern, "u") : undefined;
    for (const entry of entries) {
      const label = entry.label.toLocaleLowerCase();
      if (drugClass && drugClass.ingredients.some((ingredient) => label.includes(ingredient) && !(drugClasses.label_exclusions?.[ingredient] ?? []).some((word) => label.includes(word)))) ids.add(key(entry));
      if (spec.label_contains?.some((word) => label.includes(word.toLocaleLowerCase()))) ids.add(key(entry));
      if (pattern?.test(entry.label)) ids.add(key(entry));
      if (entry.code_version === 10 && spec.icd10?.some((prefix) => entry.identifier.startsWith(prefix))) ids.add(key(entry));
      if (entry.code_version === 9 && spec.icd9?.some((prefix) => entry.identifier.startsWith(prefix))) ids.add(key(entry));
      if (codePattern && entry.code_version && codePattern.test(entry.identifier)) ids.add(key(entry));
    }
    return ids;
  };

  const queries: Query[] = [];
  for (const [id, concept] of conceptGold) {
    const gold = new Set([...concept.ids].filter((entry) => indexed.has(entry)));
    if (!gold.size) continue;
    for (const name of [...new Set(concept.names.map((value) => value.trim()))].filter((value) => value.length >= 2 && value.length <= 120)) {
      queries.push({ set: "concept", id, query: name, ...(han(name) ? { en: concept.en } : {}), dictionary: concept.dictionary, gold, trap: new Set(), no_right_answer: false });
    }
  }
  for (const term of fixture.terms) {
    const gold = new Set([...resolveSpec(term.right, term.dictionary)].filter((entry) => indexed.has(entry)));
    queries.push({ set: term.set, id: term.id, query: term.query, ...(term.en ? { en: term.en } : {}), dictionary: term.dictionary, gold, trap: resolveSpec(term.trap, term.dictionary), no_right_answer: Object.keys(term.right).length === 0 });
  }

  // Raw retrieval for one query: text search of the query (and, with synonyms, of each synonym spelling), then embedding neighbours.
  const textList = async (query: string, dictionary: Dictionary, withSynonyms: boolean): Promise<MimicTerminologyMatch[]> => {
    const forms = withSynonyms ? alternativeForms(query, synonyms) : [query];
    const found: MimicTerminologyMatch[] = []; const seen = new Set<string>();
    for (const form of forms) {
      if (form.trim().length < 2) continue;
      for (const match of (await text.searchByCategory(form, CATEGORY[dictionary])).filter((entry) => entry.dictionary === dictionary)) if (!seen.has(key(match))) { seen.add(key(match)); found.push(match); }
    }
    return found;
  };
  // The per-entry rules the discovery applies before anything is a candidate: fidelity (judged on the written English words, or the
  // English label of a Chinese query), and the drug-label exemption for labels that text search found.
  const passesEntryRules = (query: Query, match: MimicTerminologyMatch): boolean => (match.dictionary === "prescriptions_drug" && match.retrieved_by !== "embedding")
    || entryCarriesRequest([query.query, query.en], match.label);
  const score = (query: Query, list: MimicTerminologyMatch[], budget: number) => {
    const kept = list.slice(0, budget).filter((entry) => indexed.has(key(entry)));
    const ids = kept.map(key);
    return { size: kept.length, gold: ids.filter((id) => query.gold.has(id)).length, non_gold: ids.filter((id) => !query.gold.has(id)).length, trap: ids.filter((id) => query.trap.has(id)).length, ids };
  };

  // The discovery itself with a deterministic stand-in for the model's term expansion (no model call): the query's English words, or the
  // English label of a Chinese query; "failed" leaves a Chinese query without any English label, as when the expander fails.
  const discoveryEntries = async (query: Query, terminology: MimicTerminologySearchGateway, expansion: "oracle" | "failed"): Promise<{ ids: string[]; status: string }> => {
    const label = han(query.query) ? query.en : query.query;
    const expander: ClinicalTermExpander | undefined = expansion === "failed" ? undefined : { async expand() { return { normalized_label_en: label ?? query.query, synonyms: [], category: CATEGORY[query.dictionary], ambiguities: [] }; } };
    const result = await new VariableMappingDiscoveryService({ mappings: new MemoryMappings(), terminology, drugClasses, ...(expander ? { termExpander: expander } : {}), now: () => "2026-10-28T00:00:00.000Z" })
      .search({ term: query.query, role: ROLE[query.dictionary], allow_live_search: true });
    const ids = [...new Set(result.candidates.flatMap(({ mapping }) => (mapping.evidence.dictionary_entries ?? []).filter((entry) => entry.dictionary === query.dictionary)
      .map((entry) => key({ dictionary: entry.dictionary as Dictionary, identifier: entry.identifier, ...(entry.code_version ? { code_version: entry.code_version } : {}) }))))].filter((id) => indexed.has(id));
    return { ids, status: result.status };
  };

  const rows: Array<Record<string, unknown>> = [];
  const addedForReview: Array<Record<string, unknown>> = [];
  const label = new Map(index.entries.map((entry) => [key(entry), entry.label]));
  const started = Date.now();
  for (const [position, query] of queries.entries()) {
    const row: Record<string, unknown> = { set: query.set, id: query.id, query: query.query, language: han(query.query) ? "zh" : "en", dictionary: query.dictionary, gold: query.gold.size, trap_set: query.trap.size, no_right_answer: query.no_right_answer };
    for (const withSynonyms of [false, true]) {
      const t = await textList(query.query, query.dictionary, withSynonyms);
      const added = await embedding.neighbours(query.query, [query.dictionary], t);
      const e = [...t, ...added];
      const tag = withSynonyms ? "syn" : "nosyn";
      for (const [budgetName, budget] of [["k10", SMALL_BUDGET], ["pipeline", PIPELINE_BUDGET[query.dictionary]]] as const) {
        const ts = score(query, t, budget); const es = score(query, e, budget);
        const tc = score(query, t.slice(0, budget).filter((entry) => passesEntryRules(query, entry)), budget); const ec = score(query, e.slice(0, budget).filter((entry) => passesEntryRules(query, entry)), budget);
        row[`${tag}.${budgetName}`] = { text: { ...ts, ids: undefined }, embedding: { ...es, ids: undefined }, text_checked: { ...tc, ids: undefined }, embedding_checked: { ...ec, ids: undefined },
          added: es.ids.filter((id) => !ts.ids.includes(id)).length, added_gold: es.ids.filter((id) => !ts.ids.includes(id) && query.gold.has(id)).length,
          added_checked: ec.ids.filter((id) => !tc.ids.includes(id)).length, added_checked_gold: ec.ids.filter((id) => !tc.ids.includes(id) && query.gold.has(id)).length,
          added_checked_trap: ec.ids.filter((id) => !tc.ids.includes(id) && query.trap.has(id)).length };
        if (!withSynonyms && budgetName === "pipeline") for (const id of ec.ids.filter((value) => !tc.ids.includes(value))) addedForReview.push({ stage: "entry_rules", set: query.set, id: query.id, query: query.query, dictionary: query.dictionary, entry: id, label: label.get(id), gold: query.gold.has(id), trap: query.trap.has(id) });
      }
    }
    for (const expansion of han(query.query) ? ["oracle", "failed"] as const : ["oracle"] as const) {
      const dt = await discoveryEntries(query, text, expansion); const de = await discoveryEntries(query, embedding, expansion);
      const s = (ids: string[]) => ({ size: ids.length, gold: ids.filter((id) => query.gold.has(id)).length, non_gold: ids.filter((id) => !query.gold.has(id)).length, trap: ids.filter((id) => query.trap.has(id)).length });
      const newIds = de.ids.filter((id) => !dt.ids.includes(id)); const lost = dt.ids.filter((id) => !de.ids.includes(id));
      row[`discovery.${expansion}`] = { text: { ...s(dt.ids), status: dt.status }, embedding: { ...s(de.ids), status: de.status }, added: newIds.length, added_gold: newIds.filter((id) => query.gold.has(id)).length, added_trap: newIds.filter((id) => query.trap.has(id)).length, lost: lost.length };
      for (const id of newIds) addedForReview.push({ stage: `discovery_${expansion}`, set: query.set, id: query.id, query: query.query, dictionary: query.dictionary, entry: id, label: label.get(id), gold: query.gold.has(id), trap: query.trap.has(id) });
    }
    rows.push(row);
    if ((position + 1) % 50 === 0) process.stdout.write(`${position + 1}/${queries.length} queries, ${Math.round((Date.now() - started) / 1000)} s\n`);
  }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "rows.json"), `${JSON.stringify(rows, null, 1)}\n`, { mode: 0o600 });
  await writeFile(join(out, "added-for-review.json"), `${JSON.stringify(addedForReview, null, 1)}\n`, { mode: 0o600 });
  const sorted = [...latencies].sort((a, b) => a - b); const quantile = (q: number): number => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  // Aggregates with their denominators: recall = gold entries in the list / gold entries asked for; hit = queries with at least one.
  type Arm = { size: number; gold: number; non_gold: number; trap: number };
  type Retrieval = { text: Arm; embedding: Arm; text_checked: Arm; embedding_checked: Arm; added: number; added_gold: number; added_checked: number; added_checked_gold: number; added_checked_trap: number };
  const aggregate = (selected: Array<Record<string, unknown>>) => {
    const withGold = selected.filter((row) => Number(row.gold) > 0); const withTrap = selected.filter((row) => Number(row.trap_set) > 0);
    const goldTotal = withGold.reduce((sum, row) => sum + Number(row.gold), 0);
    const retrieval = Object.fromEntries(["nosyn.k10", "nosyn.pipeline", "syn.k10", "syn.pipeline"].map((name) => {
      const cells = selected.map((row) => row[name] as Retrieval); const goldCells = withGold.map((row) => row[name] as Retrieval); const trapCells = withTrap.map((row) => row[name] as Retrieval);
      const arm = (pick: (cell: Retrieval) => Arm) => ({ recall: `${goldCells.reduce((sum, cell) => sum + pick(cell).gold, 0)}/${goldTotal}`, hit: `${goldCells.filter((cell) => pick(cell).gold > 0).length}/${goldCells.length}`,
        listed: cells.reduce((sum, cell) => sum + pick(cell).size, 0), non_gold: cells.reduce((sum, cell) => sum + pick(cell).non_gold, 0), trap_queries: `${trapCells.filter((cell) => pick(cell).trap > 0).length}/${trapCells.length}`, trap_entries: trapCells.reduce((sum, cell) => sum + pick(cell).trap, 0) });
      return [name, { text: arm((cell) => cell.text), embedding: arm((cell) => cell.embedding), text_checked: arm((cell) => cell.text_checked), embedding_checked: arm((cell) => cell.embedding_checked),
        added: cells.reduce((sum, cell) => sum + cell.added, 0), added_gold: cells.reduce((sum, cell) => sum + cell.added_gold, 0), added_checked: cells.reduce((sum, cell) => sum + cell.added_checked, 0),
        added_checked_gold: cells.reduce((sum, cell) => sum + cell.added_checked_gold, 0), added_checked_trap: cells.reduce((sum, cell) => sum + cell.added_checked_trap, 0) }];
    }));
    type Discovery = { text: Arm & { status: string }; embedding: Arm & { status: string }; added: number; added_gold: number; added_trap: number; lost: number };
    const discovery = Object.fromEntries(["oracle", "failed"].map((mode) => {
      const cells = selected.map((row) => row[`discovery.${mode}`] as Discovery | undefined).filter((cell): cell is Discovery => Boolean(cell));
      const goldCells = withGold.map((row) => row[`discovery.${mode}`] as Discovery | undefined).filter((cell): cell is Discovery => Boolean(cell));
      const trapCells = withTrap.map((row) => row[`discovery.${mode}`] as Discovery | undefined).filter((cell): cell is Discovery => Boolean(cell));
      const goldOf = withGold.filter((row) => row[`discovery.${mode}`]).reduce((sum, row) => sum + Number(row.gold), 0);
      const arm = (pick: (cell: Discovery) => Arm & { status: string }) => ({ recall: `${goldCells.reduce((sum, cell) => sum + pick(cell).gold, 0)}/${goldOf}`, hit: `${goldCells.filter((cell) => pick(cell).gold > 0).length}/${goldCells.length}`,
        non_gold: cells.reduce((sum, cell) => sum + pick(cell).non_gold, 0), trap_queries: `${trapCells.filter((cell) => pick(cell).trap > 0).length}/${trapCells.length}`, unmapped: `${cells.filter((cell) => pick(cell).status === "unmapped").length}/${cells.length}` });
      return [mode, { queries: cells.length, text: arm((cell) => cell.text), embedding: arm((cell) => cell.embedding), added: cells.reduce((sum, cell) => sum + cell.added, 0),
        added_gold: cells.reduce((sum, cell) => sum + cell.added_gold, 0), added_trap: cells.reduce((sum, cell) => sum + cell.added_trap, 0), lost: cells.reduce((sum, cell) => sum + cell.lost, 0) }];
    }));
    return { queries: selected.length, queries_with_gold: withGold.length, gold_entries: goldTotal, queries_with_trap: withTrap.length, retrieval, discovery };
  };
  const groups: Record<string, Array<Record<string, unknown>>> = {};
  for (const row of rows) for (const name of [`${row.set}.all`, `${row.set}.${row.language}`, `all.${row.language}`, "all.all"]) (groups[name] ??= []).push(row);
  const summary = { queries: queries.length, by_set: Object.fromEntries(["concept", "failure", "trap"].map((set) => [set, queries.filter((query) => query.set === set).length])), embedding_failures: failures,
    neighbours: settings.neighbours, budgets: { k10: SMALL_BUDGET, pipeline: PIPELINE_BUDGET },
    query_embedding_ms: { n: sorted.length, median: quantile(0.5), p90: quantile(0.9), max: Math.round(sorted.at(-1) ?? 0) }, seconds: Math.round((Date.now() - started) / 1000),
    groups: Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([name, selected]) => [name, aggregate(selected)])) };
  await writeFile(join(out, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ queries: summary.queries, by_set: summary.by_set, embedding_failures: failures, query_embedding_ms: summary.query_embedding_ms, seconds: summary.seconds })}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : "The evaluation failed."}\n`);
  process.exitCode = 1;
});
