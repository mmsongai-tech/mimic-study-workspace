import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DictionaryEmbeddingIndex, EmbeddingAugmentedTerminologySearch, FileDictionaryEmbeddingIndexRepository, OpenAiCompatibleTextEmbeddingClient, VariableMappingDiscoveryService,
  type ClinicalTermExpander, type DrugClassKnowledge, type MimicTerminologyMatch, type MimicTerminologySearchGateway, type TextEmbeddingClient, type VariableMappingRecord, type VariableMappingRepository, type VariableMappingStatus,
} from "../index.js";

// Synthetic fixture: invented identifiers and labels, three-dimensional "meanings". Nothing here comes from MIMIC.
const entries: MimicTerminologyMatch[] = [
  { dictionary: "d_labitems", identifier: "910001", label: "Synthetic lactate", category: "Blood Gas" },
  { dictionary: "d_labitems", identifier: "910002", label: "Synthetic lactate dehydrogenase", category: "Chemistry" },
  { dictionary: "d_labitems", identifier: "910003", label: "Synthetic platelet count", category: "Hematology" },
  { dictionary: "d_icd_diagnoses", identifier: "Q9901", label: "Synthetic raised pressure disorder", code_version: 10 },
  { dictionary: "d_icd_diagnoses", identifier: "Q9902", label: "Synthetic lowered pressure disorder", code_version: 10 },
  { dictionary: "prescriptions_drug", identifier: "Alphalol", label: "Alphalol", category: "Medication", source_table: "prescriptions" },
  { dictionary: "prescriptions_drug", identifier: "Betalol", label: "Betalol", category: "Medication", source_table: "prescriptions" },
];
const meaning: Record<string, [number, number, number]> = {
  "Synthetic lactate": [1, 0, 0], "Synthetic lactate dehydrogenase": [0.8, 0.6, 0], "Synthetic platelet count": [0, 0, 1],
  "Synthetic raised pressure disorder": [0, 1, 0], "Synthetic lowered pressure disorder": [0, 0.96, 0.28],
  Alphalol: [0.6, 0.8, 0], Betalol: [0.6, 0.64, 0.48],
  lactic: [0.99, 0.141, 0], "raised pressure": [0, 1, 0], alphalol: [0.6, 0.8, 0], "synthetic lactate dehydrogenase activity": [0.79, 0.61, 0.05], 合成乳酸: [0.95, 0.3, 0],
};
const unit = (vector: number[]): Float32Array => { const norm = Math.hypot(...vector); return Float32Array.from(vector.map((value) => value / norm)); };
const index = (): DictionaryEmbeddingIndex => {
  const vectors = new Float32Array(entries.length * 3);
  entries.forEach((entry, position) => vectors.set(unit(meaning[entry.label]!), position * 3));
  return new DictionaryEmbeddingIndex("synthetic-embedder", 3, entries, vectors);
};
class FakeEmbedder implements TextEmbeddingClient {
  readonly model = "synthetic-embedder"; calls = 0; failNext = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    if (this.failNext > 0) { this.failNext -= 1; throw new Error("embedding service down"); }
    return texts.map((text) => unit(meaning[text] ?? [0.577, 0.577, 0.577]));
  }
}
const textOnly = (found: Record<string, MimicTerminologyMatch[]>): MimicTerminologySearchGateway => ({
  async search(term) { return structuredClone(found[term] ?? []); },
  async searchByCategory(term) { return structuredClone(found[term] ?? []); },
  async searchMedication(term) { return structuredClone((found[term] ?? []).filter(({ dictionary }) => dictionary === "prescriptions_drug")); },
});

test("finds the labels nearest in meaning within the requested dictionaries, most similar first", () => {
  const nearest = index().nearest(unit([1, 0.1, 0]), ["d_labitems"], 2);
  assert.deepEqual(nearest.map(({ entry }) => entry.identifier), ["910001", "910002"]);
  assert.ok(nearest[0]!.similarity > nearest[1]!.similarity);
  assert.equal(index().nearest(unit([1, 0, 0]), ["d_icd_procedures"], 5).length, 0, "a dictionary without entries contributes nothing");
  assert.throws(() => new DictionaryEmbeddingIndex("m", 3, entries, new Float32Array(3)), /do not match/u);
});

test("adds embedding neighbours after every text candidate, never removes or reorders one, and marks what it added", async () => {
  const textFound = [entries[1]!];
  const search = new EmbeddingAugmentedTerminologySearch(textOnly({ lactic: textFound }), index(), new FakeEmbedder(), { neighbours: 2 });
  const found = await search.searchByCategory!("lactic", "laboratory");
  assert.deepEqual(found.slice(0, 1), textFound, "text candidates come first and unchanged");
  assert.deepEqual(found.slice(1).map(({ identifier, retrieved_by }) => [identifier, retrieved_by]), [["910001", "embedding"]], "the text candidate is not repeated; only laboratory entries are added");
  assert.equal(found[0]!.retrieved_by, undefined);
  const medication = await search.searchMedication!("alphalol");
  assert.ok(medication.every(({ dictionary }) => dictionary === "prescriptions_drug"));
  assert.deepEqual(medication.map(({ identifier }) => identifier), ["Alphalol", "Betalol"]);
});

test("offers only the searches the text gateway offers and passes code-prefix search through unchanged", async () => {
  const plain: MimicTerminologySearchGateway = { async search() { return []; } };
  const search = new EmbeddingAugmentedTerminologySearch(plain, index(), new FakeEmbedder(), { neighbours: 1 });
  assert.equal(search.searchByCategory, undefined); assert.equal(search.searchMedication, undefined); assert.equal(search.searchCodePrefix, undefined);
  const prefix: MimicTerminologySearchGateway = { async search() { return []; }, async searchCodePrefix() { return [entries[3]!]; } };
  assert.deepEqual(await new EmbeddingAugmentedTerminologySearch(prefix, index(), new FakeEmbedder(), { neighbours: 5 }).searchCodePrefix!("Q99"), [entries[3]]);
});

test("an embedding failure leaves the text candidates alone and is retried on the next search", async () => {
  const embedder = new FakeEmbedder(); embedder.failNext = 1;
  const failures: unknown[] = [];
  const search = new EmbeddingAugmentedTerminologySearch(textOnly({ lactic: [entries[1]!] }), index(), embedder, { neighbours: 2, onUnavailable: (error) => failures.push(error) });
  assert.deepEqual(await search.searchByCategory!("lactic", "laboratory"), [entries[1]]);
  assert.equal(failures.length, 1);
  assert.equal((await search.searchByCategory!("lactic", "laboratory")).length, 2, "the failed query vector is not cached");
});

class MemoryMappings implements VariableMappingRepository {
  private readonly records = new Map<string, VariableMappingRecord>();
  async save(record: VariableMappingRecord): Promise<boolean> { this.records.set(record.mapping_id, structuredClone(record)); return true; }
  async findById(mappingId: string): Promise<VariableMappingRecord | undefined> { return this.records.get(mappingId); }
  async findByTerm(): Promise<VariableMappingRecord[]> { return []; }
  async listByStatus(statuses: VariableMappingStatus[]): Promise<VariableMappingRecord[]> { return [...this.records.values()].filter(({ status }) => statuses.includes(status)); }
}
const expander = (category: "laboratory" | "diagnosis" | "medication", label: string): ClinicalTermExpander => ({ async expand() { return { normalized_label_en: label, synonyms: [], category, ambiguities: [] }; } });
const entryIds = (mapping: VariableMappingRecord): string[] => (mapping.evidence.dictionary_entries ?? []).map(({ identifier }) => identifier);

test("an embedding neighbour that carries the request by the unchanged rules becomes a candidate the text search missed", async () => {
  // Text search needs every distinctive word ("activity" is missing from the label); the fidelity and coverage rules accept three of four.
  const term = "synthetic lactate dehydrogenase activity";
  const terminology = new EmbeddingAugmentedTerminologySearch(textOnly({}), index(), new FakeEmbedder(), { neighbours: 2 });
  const result = await new VariableMappingDiscoveryService({ mappings: new MemoryMappings(), terminology, termExpander: expander("laboratory", term), now: () => "2026-10-28T00:00:00.000Z" })
    .search({ term, role: "covariate", allow_live_search: true });
  assert.deepEqual(result.candidates.flatMap(({ mapping }) => entryIds(mapping)), ["910002"], "the nearer lactate item does not carry the request and is dropped");
  assert.equal(result.status, "needs_confirmation", "a discovered candidate still needs review");
  const textAlone = await new VariableMappingDiscoveryService({ mappings: new MemoryMappings(), terminology: textOnly({}), termExpander: expander("laboratory", term), now: () => "2026-10-28T00:00:00.000Z" })
    .search({ term, role: "covariate", allow_live_search: true });
  assert.equal(textAlone.status, "unmapped");
});

test("neighbours of one search term never push a text match of another term out of the item budget", async () => {
  // The Chinese term is searched first and text finds nothing for it; its neighbours carry the English label, so they pass every rule.
  const panel = Array.from({ length: 10 }, (_, position): MimicTerminologyMatch => ({ dictionary: "d_labitems", identifier: String(920001 + position), label: `Synthetic lactate panel ${position + 1}`, category: "Blood Gas" }));
  const terminology = new EmbeddingAugmentedTerminologySearch(textOnly({ "synthetic lactate": panel }), index(), new FakeEmbedder(), { neighbours: 2 });
  const result = await new VariableMappingDiscoveryService({ mappings: new MemoryMappings(), terminology, termExpander: expander("laboratory", "synthetic lactate"), now: () => "2026-10-28T00:00:00.000Z" })
    .search({ term: "合成乳酸", role: "covariate", allow_live_search: true });
  assert.deepEqual(result.candidates.flatMap(({ mapping }) => entryIds(mapping)).sort(), panel.map(({ identifier }) => identifier), "all ten text matches keep the ten item places");
});

test("a near-opposite neighbour that does not carry the request is dropped by the unchanged fidelity rule", async () => {
  const terminology = new EmbeddingAugmentedTerminologySearch(textOnly({ "raised pressure": [entries[3]!] }), index(), new FakeEmbedder(), { neighbours: 5 });
  const result = await new VariableMappingDiscoveryService({ mappings: new MemoryMappings(), terminology, termExpander: expander("diagnosis", "raised pressure"), now: () => "2026-10-28T00:00:00.000Z" })
    .search({ term: "raised pressure", role: "population", allow_live_search: true });
  const ids = result.candidates.flatMap(({ mapping }) => entryIds(mapping));
  assert.ok(ids.includes("Q9901"));
  assert.equal(ids.includes("Q9902"), false, "the lowered-pressure code is near in meaning but does not carry the request");
});

test("the drug-label exemption covers only labels text search found, not a neighbouring drug added by embedding", async () => {
  const terminology = new EmbeddingAugmentedTerminologySearch(textOnly({ alphalol: [entries[5]!] }), index(), new FakeEmbedder(), { neighbours: 5 });
  const result = await new VariableMappingDiscoveryService({ mappings: new MemoryMappings(), terminology, termExpander: expander("medication", "alphalol"), now: () => "2026-10-28T00:00:00.000Z" })
    .search({ term: "alphalol", role: "exposure", allow_live_search: true });
  const labels = result.candidates.flatMap(({ mapping }) => mapping.sources.flatMap((source) => source.value_filters?.flatMap(({ values }) => values) ?? []));
  assert.deepEqual([...new Set(labels)], ["Alphalol"], "Betalol is near in meaning but is another drug");
});

test("the drug-class and named-ingredient rules read only labels text search found", async () => {
  // "Proalphalol" contains "alphalol" but is another drug (as "arformoterol" contains "formoterol"); text search never offers it.
  const proalphalol: MimicTerminologyMatch = { dictionary: "prescriptions_drug", identifier: "Proalphalol", label: "Proalphalol", category: "Medication", source_table: "prescriptions" };
  const vectors = new Float32Array([...entries, proalphalol].length * 3);
  [...entries, proalphalol].forEach((entry, position) => vectors.set(unit(meaning[entry.label] ?? [0.6, 0.79, 0.1]), position * 3));
  const withNeighbour = new DictionaryEmbeddingIndex("synthetic-embedder", 3, [...entries, proalphalol], vectors);
  const terminology = new EmbeddingAugmentedTerminologySearch(textOnly({ alphalol: [entries[5]!] }), withNeighbour, new FakeEmbedder(), { neighbours: 5 });
  const drugClasses: DrugClassKnowledge = { schema_version: "1.0.0", knowledge_version: "synthetic-1", provenance: "synthetic test fixture", classes: [{ class_id: "synthetic_lols", atc: "X00", labels: { en: "Synthetic lols", zh: "合成洛尔类" }, synonyms: [], ingredients: ["alphalol"] }] };
  const labelsOf = (assessment: Awaited<ReturnType<VariableMappingDiscoveryService["search"]>>) => assessment.candidates.flatMap(({ mapping }) => mapping.sources.flatMap((source) => source.value_filters?.flatMap(({ values }) => values) ?? []));
  for (const term of ["Synthetic lols", "alphalol"]) {
    const result = await new VariableMappingDiscoveryService({ mappings: new MemoryMappings(), terminology, drugClasses, termExpander: expander("medication", term), now: () => "2026-10-28T00:00:00.000Z" })
      .search({ term, role: "exposure", allow_live_search: true });
    assert.deepEqual(labelsOf(result), ["Alphalol"], term);
  }
  // A drug the catalogue does not list follows the same rule (every label containing the name), so the same guard applies.
  const uncatalogued = await new VariableMappingDiscoveryService({ mappings: new MemoryMappings(), terminology, drugClasses: { ...drugClasses, classes: [] }, termExpander: expander("medication", "alphalol"), now: () => "2026-10-28T00:00:00.000Z" })
    .search({ term: "alphalol", role: "exposure", allow_live_search: true });
  assert.deepEqual(labelsOf(uncatalogued), ["Alphalol"], "uncatalogued ingredient");
});

test("stores and reloads an index, and refuses one built with another model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embedding-index-"));
  try {
    const repository = new FileDictionaryEmbeddingIndexRepository(directory);
    const vectors = new Float32Array(entries.length * 3); entries.forEach((entry, position) => vectors.set(unit(meaning[entry.label]!), position * 3));
    await repository.save({ model: "synthetic-embedder", dimensions: 3, built_at: "2026-10-28T00:00:00.000Z", source: { fixture: "synthetic" }, entries }, vectors);
    const loaded = await repository.load("synthetic-embedder");
    assert.equal(loaded.entries.length, entries.length);
    assert.deepEqual(loaded.nearest(unit([0, 0, 1]), ["d_labitems"], 1).map(({ entry }) => entry.identifier), ["910003"]);
    await assert.rejects(() => repository.load("another-model"), /rebuild/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the embedding client sends the texts, scales vectors to unit length, keeps their order and retries a dropped request", async () => {
  const requests: Array<{ url: string; body: { model: string; input: string[] } }> = []; let failures = 1;
  const fetchStub = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) as { model: string; input: string[] } });
    if (failures > 0) { failures -= 1; return new Response("{}", { status: 400 }); }
    const input = (JSON.parse(String(init.body)) as { input: string[] }).input;
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [3 * (index + 1), 4 * (index + 1)] })).reverse() }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new OpenAiCompatibleTextEmbeddingClient({ base_url: "http://embedder.test/v1/", model: "synthetic-embedder", timeout_ms: 1_000, batch_size: 2, retry_delay_ms: 1, fetch: fetchStub });
  const vectors = await client.embed(["a", "b", "c"]);
  assert.deepEqual(vectors.map((vector) => [...vector].map((value) => Number(value.toFixed(3)))), [[0.6, 0.8], [0.6, 0.8], [0.6, 0.8]]);
  assert.equal(requests[0]!.url, "http://embedder.test/v1/embeddings");
  assert.deepEqual(requests.map(({ body }) => body.input), [["a", "b"], ["a", "b"], ["c"]], "two batches, the first sent again after a dropped request");
  const broken = new OpenAiCompatibleTextEmbeddingClient({ base_url: "http://embedder.test/v1", model: "m", timeout_ms: 1_000, retries: 0, fetch: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch });
  await assert.rejects(() => broken.embed(["a"]), (error: unknown) => (error as { code?: string }).code === "MAPPING_SEARCH_UNAVAILABLE");
});
