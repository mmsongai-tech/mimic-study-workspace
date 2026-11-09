import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { VariableMappingPack } from "../variable-mapping/file-variable-mapping-pack-repository.js";
import { compileDefinition } from "./definition-compiler.js";
import { checkDefinition, nameKey, type DefinitionReport } from "./definition-checks.js";
import type { DictionaryIndex } from "./dictionary-index.js";
import { FormulaCatalog } from "./formula-catalog.js";
import type { VariableDefinition } from "./variable-definition.js";

/** A folder of definition files (one JSON file per variable). The shared folder is reviewed; a workspace folder is private. */
export class VariableDefinitionStore {
  constructor(private readonly directory: string) {}

  async list(): Promise<VariableDefinition[]> {
    let names: string[];
    try { names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort(); } catch { return []; }
    const definitions: VariableDefinition[] = [];
    for (const name of names) definitions.push(JSON.parse(await readFile(join(this.directory, name), "utf8")) as VariableDefinition);
    return definitions;
  }
  async save(definition: VariableDefinition): Promise<void> { await mkdir(this.directory, { recursive: true }); await writeFile(join(this.directory, `${definition.definition_id}.json`), `${JSON.stringify(definition, null, 2)}\n`); }
  async remove(id: string): Promise<void> { await rm(join(this.directory, `${id}.json`), { force: true }); }
}

/** Every name (label and synonyms) of a set of pack entries, to detect two variables sharing a name. */
export const takenNames = (entries: ReadonlyArray<{ concept_id: string; labels: { en: string; zh?: string }; synonyms: string[] }>, except?: string): Map<string, string> => {
  const taken = new Map<string, string>();
  for (const entry of entries) if (entry.concept_id !== except) for (const name of [entry.labels.en, entry.labels.zh, ...entry.synonyms]) if (name) taken.set(nameKey(name), entry.concept_id);
  return taken;
};

/** Checks one definition against the names of the shared pack and of the other definitions. */
export const checkAgainst = (definition: VariableDefinition, input: { index: DictionaryIndex; others: ReadonlyArray<{ concept_id: string; labels: { en: string; zh?: string }; synonyms: string[] }> }): DefinitionReport =>
  checkDefinition(definition, { index: input.index, taken: takenNames(input.others, definition.definition_id), known: new Set(input.others.map((entry) => entry.concept_id)) });

/** The definitions of one or more stores as a pack that the existing seeding service can load. */
export class DefinitionPackRepository {
  constructor(private readonly dependencies: { stores: VariableDefinitionStore[]; index?: DictionaryIndex; packId: string; skip?: (definition: VariableDefinition) => boolean }) {}
  async load(): Promise<VariableMappingPack> {
    const mappings = [];
    // Ratio and formula definitions have no data source of their own: the study framing reads them (FormulaCatalog) and the run computes them from their parts, so they are not variables the resolver can pick.
    for (const store of this.dependencies.stores) for (const definition of await store.list()) if (definition.kind !== "ratio" && definition.kind !== "formula" && !this.dependencies.skip?.(definition)) mappings.push(compileDefinition(definition, this.dependencies.index));
    return { schema_version: "1.0.0", pack_id: this.dependencies.packId, pack_version: "1.0.0", license: "MIT", provenance: "Variable definitions (docs/decisions/0009-variable-definition-standard.md).", mappings };
  }
}

/** The ratio and formula definitions of the given stores, with part labels taken from the definitions and the shared pack. */
export const loadFormulaCatalog = async (input: { stores: VariableDefinitionStore[]; packFile: URL }): Promise<FormulaCatalog> => {
  const definitions = (await Promise.all(input.stores.map((store) => store.list()))).flat();
  const pack = JSON.parse(await readFile(input.packFile, "utf8")) as { mappings: Array<{ concept_id: string; labels: { en: string } }> };
  const labels = new Map<string, string>([...pack.mappings.map((entry) => [entry.concept_id, entry.labels.en] as const), ...definitions.map((definition) => [definition.definition_id, definition.labels.en] as const)]);
  return new FormulaCatalog(definitions, (id) => labels.get(id));
};
