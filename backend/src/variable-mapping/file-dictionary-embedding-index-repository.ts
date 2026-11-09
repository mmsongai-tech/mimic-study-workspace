import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DictionaryEmbeddingIndex } from "./dictionary-embedding-search.js";
import type { MimicTerminologyMatch } from "./terminology-gateway.js";

const DICTIONARIES = new Set<MimicTerminologyMatch["dictionary"]>(["d_labitems", "d_items", "d_icd_diagnoses", "d_icd_procedures", "prescriptions_drug"]);

export interface DictionaryEmbeddingIndexManifest {
  schema_version: "1.0.0";
  model: string;
  dimensions: number;
  count: number;
  built_at: string;
  /** What the entries were taken from (file names and counts only). */
  source: Record<string, string | number>;
  entries: MimicTerminologyMatch[];
}

/**
 * Stores an embedding index as a directory with `manifest.json` (model, dimension, the dictionary entries) and `vectors.f32`
 * (little-endian float32 rows in entry order). The index is derived from the MIMIC dictionaries, so it belongs under `.local/`.
 */
export class FileDictionaryEmbeddingIndexRepository {
  constructor(private readonly directory: string) {}

  async load(expectedModel: string): Promise<DictionaryEmbeddingIndex> {
    const manifest = JSON.parse(await readFile(join(this.directory, "manifest.json"), "utf8")) as DictionaryEmbeddingIndexManifest;
    if (manifest.schema_version !== "1.0.0" || !Array.isArray(manifest.entries) || manifest.entries.length !== manifest.count) throw new Error("The dictionary embedding index has an unsupported format.");
    if (manifest.model !== expectedModel) throw new Error(`The dictionary embedding index was built with ${manifest.model}, not ${expectedModel}; rebuild it.`);
    if (!manifest.entries.every((entry) => DICTIONARIES.has(entry.dictionary) && typeof entry.identifier === "string" && typeof entry.label === "string")) throw new Error("The dictionary embedding index has an invalid entry.");
    const bytes = await readFile(join(this.directory, "vectors.f32"));
    if (bytes.byteLength !== manifest.count * manifest.dimensions * 4) throw new Error("The dictionary embedding index vectors are incomplete.");
    const vectors = new Float32Array(manifest.count * manifest.dimensions);
    new Uint8Array(vectors.buffer).set(bytes);
    return new DictionaryEmbeddingIndex(manifest.model, manifest.dimensions, manifest.entries, vectors);
  }

  async save(manifest: Omit<DictionaryEmbeddingIndexManifest, "schema_version" | "count">, vectors: Float32Array): Promise<void> {
    if (vectors.length !== manifest.entries.length * manifest.dimensions) throw new Error("The vectors do not match the entries.");
    await mkdir(this.directory, { recursive: true });
    const write = async (name: string, content: string | Uint8Array): Promise<void> => {
      const target = join(this.directory, name); const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, target);
    };
    await write("vectors.f32", new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength));
    await write("manifest.json", `${JSON.stringify({ schema_version: "1.0.0", ...manifest, count: manifest.entries.length })}\n`);
  }
}
