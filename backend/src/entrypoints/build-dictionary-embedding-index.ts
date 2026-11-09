import { basename } from "node:path";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { resolveBackendRuntimeConfig } from "../runtime/index.js";
import { DictionaryIndex } from "../variable-definitions/index.js";
import { FileDictionaryEmbeddingIndexRepository, LocalArchiveMimicTerminologySearchClient, OpenAiCompatibleTextEmbeddingClient, type MimicTerminologyMatch } from "../variable-mapping/index.js";

// Builds the embedding index of the local MIMIC dictionary labels that embedding search reads (config variable_mapping.embedding_search).
// Usage: MIMIC_LOCAL_ARCHIVE=/path/mimic-iv-3.1.zip node --import tsx backend/src/entrypoints/build-dictionary-embedding-index.ts [--all]
// By default the ICD code dictionaries are limited to codes that occur in the data (the dictionary index, .local/dictionary-index.json,
// says which): a small part of all codes, and a code no admission carries can never be a useful candidate. The laboratory, ICU
// item and prescription dictionaries are small and embedded whole (the index does not cover every ICU event table). --all embeds
// every code as well.
// The output is MIMIC-derived: it is written under .local/ and must never be committed. Only aggregate counts are printed.

const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };

const main = async (): Promise<void> => {
  const archivePath = argument("--archive") ?? process.env.MIMIC_LOCAL_ARCHIVE;
  if (!archivePath) throw new Error("Set MIMIC_LOCAL_ARCHIVE or pass --archive.");
  const baseUrl = process.env.MIMIC_LOCAL_MODEL_BASE_URL || undefined;
  const config = resolveBackendRuntimeConfig(baseUrl ? { environment: { variable_mapping: { embedding_search: { base_url: baseUrl } } } } : {});
  const settings = config.variable_mapping.embedding_search;
  const everything = process.argv.includes("--all");
  const terminology = new LocalArchiveMimicTerminologySearchClient(archivePath, { cacheDirectory: join(config.clinical_database.local_evidence_cache_path, "terminology") });
  const index = everything ? undefined : await DictionaryIndex.load(config.variable_definitions.dictionary_index_path);
  const used = (entry: MimicTerminologyMatch): boolean => {
    if (!index || (entry.dictionary !== "d_icd_diagnoses" && entry.dictionary !== "d_icd_procedures")) return true;
    const kind = entry.dictionary === "d_icd_diagnoses" ? "diagnosis" : "procedure";
    return entry.code_version !== undefined && (index.code(kind, entry.identifier, entry.code_version)?.rows ?? 0) > 0;
  };
  const counts: Record<string, string | number> = { archive: basename(archivePath), selection: everything ? "all entries" : "ICD codes with at least one row (dictionary index); other dictionaries whole" };
  const entries: MimicTerminologyMatch[] = [];
  for (const dictionary of ["d_labitems", "d_items", "prescriptions_drug", "d_icd_diagnoses", "d_icd_procedures"] as const) {
    const all = await terminology.listEntries(dictionary);
    const kept = all.filter(used);
    counts[`${dictionary}_entries`] = all.length; counts[`${dictionary}_embedded`] = kept.length;
    entries.push(...kept);
  }
  const client = new OpenAiCompatibleTextEmbeddingClient({ base_url: settings.base_url, model: settings.model, timeout_ms: Math.max(settings.timeout_ms, 120_000), batch_size: 64, retries: 4 });
  const started = Date.now();
  let dimensions = 0; let vectors = new Float32Array(0);
  const batch = 512;
  for (let start = 0; start < entries.length; start += batch) {
    const embedded = await client.embed(entries.slice(start, start + batch).map(({ label }) => label));
    if (!dimensions) { dimensions = embedded[0]!.length; vectors = new Float32Array(entries.length * dimensions); }
    embedded.forEach((vector, offset) => {
      if (vector.length !== dimensions) throw new Error("The embedding model returned vectors of different lengths.");
      vectors.set(vector, (start + offset) * dimensions);
    });
    const done = Math.min(start + batch, entries.length); const seconds = (Date.now() - started) / 1000;
    if (done === entries.length || (start / batch) % 10 === 0) process.stdout.write(`${done}/${entries.length} labels, ${seconds.toFixed(0)} s, ${(done / Math.max(seconds, 0.001)).toFixed(1)} labels/s\n`);
  }
  const repository = new FileDictionaryEmbeddingIndexRepository(settings.index_directory);
  await repository.save({ model: settings.model, dimensions, built_at: new Date().toISOString(), source: { ...counts, build_seconds: Math.round((Date.now() - started) / 1000) }, entries }, vectors);
  const size = (await stat(join(settings.index_directory, "vectors.f32"))).size + (await stat(join(settings.index_directory, "manifest.json"))).size;
  process.stdout.write(`${JSON.stringify({ model: settings.model, dimensions, entries: entries.length, seconds: Math.round((Date.now() - started) / 1000), bytes: size, directory: settings.index_directory, ...counts }, null, 2)}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "The embedding index build failed."}\n`);
  process.exitCode = 1;
});
