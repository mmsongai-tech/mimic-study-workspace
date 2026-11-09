import { readFile } from "node:fs/promises";
import { checkDefinition } from "./definition-checks.js";
import { takenNames } from "./variable-definition-store.js";
import type { VariableDefinitionStore } from "./variable-definition-store.js";
import type { DefinitionReport } from "./definition-checks.js";
import type { DictionaryIndex, SearchHit, SearchKind } from "./dictionary-index.js";
import { DEFINITION_ID, type VariableDefinition } from "./variable-definition.js";

type NamedEntry = { concept_id: string; labels: { en: string; zh?: string }; synonyms: string[] };
export class VariableDefinitionError extends Error { constructor(message: string, readonly report?: DefinitionReport) { super(message); this.name = "VariableDefinitionError"; } }

/**
 * What the interface needs: search the dictionaries, check a definition, save it to the workspace, list and remove.
 * A saved definition is read by the next run (each run seeds the shared and workspace folders when it starts).
 */
export class VariableDefinitionService {
  constructor(private readonly dependencies: { index: DictionaryIndex; shared: VariableDefinitionStore; workspace: VariableDefinitionStore; packFile: URL; drugClassFile?: URL }) {}

  search(kind: SearchKind, query: string): SearchHit[] { return this.dependencies.index.search(kind, query); }

  /** Every taken name; an earlier version of the definition being checked, in the workspace, does not count against itself. */
  private async names(except?: { scope: "shared" | "workspace"; id: string }): Promise<NamedEntry[]> {
    const pack = JSON.parse(await readFile(this.dependencies.packFile, "utf8")) as { mappings: NamedEntry[] };
    const entries: NamedEntry[] = [...pack.mappings];
    if (this.dependencies.drugClassFile) {
      // A drug class or ingredient is resolved from the drug catalogue before anything else, so its names are taken too.
      const catalogue = JSON.parse(await readFile(this.dependencies.drugClassFile, "utf8")) as { classes: Array<{ class_id: string; labels: { en: string; zh: string }; synonyms: string[]; ingredients: string[] }> };
      for (const drugClass of catalogue.classes) {
        entries.push({ concept_id: `drug_class_${drugClass.class_id}`, labels: drugClass.labels, synonyms: drugClass.synonyms });
        for (const ingredient of drugClass.ingredients) entries.push({ concept_id: `drug_${ingredient}`, labels: { en: ingredient }, synonyms: [] });
      }
    }
    for (const definition of await this.dependencies.shared.list()) if (!(except?.scope === "shared" && definition.definition_id === except.id)) entries.push({ concept_id: definition.definition_id, labels: definition.labels, synonyms: definition.synonyms });
    for (const definition of await this.dependencies.workspace.list()) if (!(except?.scope === "workspace" && definition.definition_id === except.id)) entries.push({ concept_id: definition.definition_id, labels: definition.labels, synonyms: definition.synonyms });
    return entries;
  }

  /** `scope` is the folder the definition lives in: its own earlier copy there does not count as a name clash. */
  async check(definition: VariableDefinition, scope: "shared" | "workspace" = "workspace"): Promise<DefinitionReport> {
    const others = await this.names({ scope, id: definition.definition_id });
    return checkDefinition(definition, { index: this.dependencies.index, taken: takenNames(others), known: new Set(others.map((entry) => entry.concept_id)) });
  }

  async list(): Promise<{ shared: VariableDefinition[]; workspace: VariableDefinition[] }> {
    return { shared: await this.dependencies.shared.list(), workspace: await this.dependencies.workspace.list() };
  }

  /** Saves to the workspace only; a researcher cannot write the shared folder or set a status above "researcher_defined". */
  async save(definition: VariableDefinition, author?: string): Promise<{ definition: VariableDefinition; report: DefinitionReport }> {
    const clean: VariableDefinition = { ...definition, schema_version: "1.0.0", status: "researcher_defined", ...(author ? { author } : {}) };
    const report = await this.check(clean);
    if (!report.ok) throw new VariableDefinitionError("The definition did not pass the checks.", report);
    await this.dependencies.workspace.save(clean);
    return { definition: clean, report };
  }

  async remove(id: string): Promise<void> {
    if (!DEFINITION_ID.test(id)) throw new VariableDefinitionError("Not a valid definition id.");
    if ((await this.dependencies.shared.list()).some((definition) => definition.definition_id === id)) throw new VariableDefinitionError("A reviewed shared definition cannot be removed here.");
    await this.dependencies.workspace.remove(id);
  }
}
