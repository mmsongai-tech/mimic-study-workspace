import { terminologyDictionariesForCategory } from "./mimic-data-domain-catalog.js";
import type { ClinicalTermExpansion, MimicTerminologyMatch, MimicTerminologySearchGateway } from "./terminology-gateway.js";

/** Provider boundary for a text-embedding model: one unit-length vector per text, in order. */
export interface TextEmbeddingClient {
  readonly model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

type Dictionary = MimicTerminologyMatch["dictionary"];
const ALL_DICTIONARIES: Dictionary[] = ["d_labitems", "d_items", "d_icd_diagnoses", "d_icd_procedures", "prescriptions_drug"];
const entryKey = (match: MimicTerminologyMatch): string => `${match.dictionary}\u0000${match.code_version ?? "item"}\u0000${match.identifier}`;

/**
 * The embedded dictionary labels, held in memory: one row of `dimensions` floats per entry, unit length.
 * Nearest labels are found by exact cosine similarity (a dot product of unit vectors) within the requested dictionaries.
 */
export class DictionaryEmbeddingIndex {
  private readonly ranges = new Map<Dictionary, Array<[number, number]>>();

  constructor(readonly model: string, readonly dimensions: number, readonly entries: ReadonlyArray<MimicTerminologyMatch>, private readonly vectors: Float32Array) {
    if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error("The embedding index has an invalid dimension.");
    if (vectors.length !== entries.length * dimensions) throw new Error("The embedding index vectors do not match its entries.");
    entries.forEach((entry, index) => {
      const ranges = this.ranges.get(entry.dictionary) ?? [];
      const last = ranges.at(-1);
      if (last && last[1] === index) last[1] = index + 1; else ranges.push([index, index + 1]);
      this.ranges.set(entry.dictionary, ranges);
    });
  }

  /** The `limit` entries of the given dictionaries whose labels are most similar to `query`, most similar first. */
  nearest(query: Float32Array, dictionaries: ReadonlyArray<Dictionary>, limit: number): Array<{ entry: MimicTerminologyMatch; similarity: number }> {
    if (query.length !== this.dimensions) throw new Error("The query vector has the wrong dimension.");
    const best: Array<{ index: number; similarity: number }> = [];
    const dimensions = this.dimensions; const vectors = this.vectors;
    for (const dictionary of new Set(dictionaries)) for (const [start, end] of this.ranges.get(dictionary) ?? []) {
      for (let index = start; index < end; index += 1) {
        let similarity = 0; const offset = index * dimensions;
        for (let d = 0; d < dimensions; d += 1) similarity += query[d]! * vectors[offset + d]!;
        if (best.length < limit) { best.push({ index, similarity }); best.sort((a, b) => b.similarity - a.similarity); }
        else if (similarity > best[best.length - 1]!.similarity) { best[best.length - 1] = { index, similarity }; best.sort((a, b) => b.similarity - a.similarity); }
      }
    }
    return best.map(({ index, similarity }) => ({ entry: this.entries[index]!, similarity }));
  }
}

export interface EmbeddingSearchOptions {
  /** Nearest labels added per search and dictionary. */
  neighbours: number;
  /** Called once per failed embedding request; the search then returns the text candidates alone. */
  onUnavailable?: (error: unknown) => void;
}

/**
 * Text search with embedding retrieval added: every text candidate is returned first and in its own order, then the labels of the
 * same dictionaries nearest to the term's meaning that text search did not find, marked `retrieved_by: "embedding"`. Nothing is
 * removed or reordered, so every rule applied after the search sees at least what it saw before; an embedding failure leaves the
 * text candidates alone. Code-prefix search is exact and passes through unchanged.
 */
export class EmbeddingAugmentedTerminologySearch implements MimicTerminologySearchGateway {
  private readonly queryVectors = new Map<string, Promise<Float32Array | undefined>>();
  // Only the searches the text gateway offers are offered, so the caller chooses the same search with or without embeddings.
  readonly searchCodePrefix?: (prefix: string) => Promise<MimicTerminologyMatch[]>;
  readonly searchByCategory?: (term: string, category: ClinicalTermExpansion["category"]) => Promise<MimicTerminologyMatch[]>;
  readonly searchMedication?: (term: string) => Promise<MimicTerminologyMatch[]>;
  readonly searchNonMedication?: (term: string) => Promise<MimicTerminologyMatch[]>;

  constructor(private readonly text: MimicTerminologySearchGateway, private readonly index: DictionaryEmbeddingIndex, private readonly embedding: TextEmbeddingClient, private readonly options: EmbeddingSearchOptions) {
    if (text.searchCodePrefix) this.searchCodePrefix = (prefix) => text.searchCodePrefix!(prefix);
    if (text.searchByCategory) this.searchByCategory = async (term, category) => this.augment(term, terminologyDictionariesForCategory(category), await text.searchByCategory!(term, category));
    if (text.searchMedication) this.searchMedication = async (term) => this.augment(term, ["prescriptions_drug"], await text.searchMedication!(term));
    if (text.searchNonMedication) this.searchNonMedication = async (term) => this.augment(term, ALL_DICTIONARIES.filter((dictionary) => dictionary !== "prescriptions_drug"), await text.searchNonMedication!(term));
  }

  private queryVector(term: string): Promise<Float32Array | undefined> {
    const key = term.normalize("NFKC").trim().toLocaleLowerCase();
    let vector = this.queryVectors.get(key);
    if (!vector) {
      vector = this.embedding.embed([term.trim()]).then(([value]) => value, (error: unknown) => { this.queryVectors.delete(key); this.options.onUnavailable?.(error); return undefined; });
      this.queryVectors.set(key, vector);
    }
    return vector;
  }

  /** The embedding neighbours of `term` in `dictionaries` that `found` does not already hold, nearest first per dictionary. */
  async neighbours(term: string, dictionaries: ReadonlyArray<Dictionary>, found: ReadonlyArray<MimicTerminologyMatch> = []): Promise<MimicTerminologyMatch[]> {
    if (!dictionaries.length || this.options.neighbours < 1) return [];
    const vector = await this.queryVector(term);
    if (!vector) return [];
    const known = new Set(found.map(entryKey));
    const added: MimicTerminologyMatch[] = [];
    for (const dictionary of new Set(dictionaries)) {
      for (const { entry } of this.index.nearest(vector, [dictionary], this.options.neighbours)) {
        if (known.has(entryKey(entry))) continue;
        known.add(entryKey(entry));
        added.push({ ...structuredClone(entry), retrieved_by: "embedding" });
      }
    }
    return added;
  }

  private async augment(term: string, dictionaries: ReadonlyArray<Dictionary>, found: MimicTerminologyMatch[]): Promise<MimicTerminologyMatch[]> {
    return [...found, ...await this.neighbours(term, dictionaries, found)];
  }

  async search(term: string): Promise<MimicTerminologyMatch[]> {
    return this.augment(term, ALL_DICTIONARIES, await this.text.search(term));
  }
}
