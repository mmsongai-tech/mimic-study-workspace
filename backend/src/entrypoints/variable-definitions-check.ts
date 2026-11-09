import { resolveBackendRuntimeConfig } from "../runtime/runtime-config.js";
import { DictionaryIndex, VariableDefinitionService, VariableDefinitionStore } from "../variable-definitions/index.js";

// Checks every shared and workspace variable definition against the dictionary index and prints what each check found.
//   node --import tsx backend/src/entrypoints/variable-definitions-check.ts
// Exit status 1 when any definition has an error. Build the index first: scripts/build-dictionary-index.py.
const main = async (): Promise<void> => {
  const config = resolveBackendRuntimeConfig();
  const service = new VariableDefinitionService({
    index: await DictionaryIndex.load(config.variable_definitions.dictionary_index_path),
    shared: new VariableDefinitionStore(config.variable_definitions.shared_directory), workspace: new VariableDefinitionStore(config.variable_definitions.workspace_directory),
    packFile: new URL("../../../config/mappings/mimic-iv-core.json", import.meta.url), drugClassFile: new URL("../../../config/drug-classes/drug-classes.json", import.meta.url),
  });
  const { shared, workspace } = await service.list(); let failed = 0;
  for (const [scope, definitions] of [["shared", shared], ["workspace", workspace]] as const) for (const definition of definitions) {
    const report = await service.check(definition, scope);
    if (!report.ok) failed += 1;
    process.stdout.write(`${report.ok ? "ok   " : "FAIL "} ${scope}/${definition.definition_id}: ${report.facts.admissions.toLocaleString("en-US")} admissions, ${report.facts.rows.toLocaleString("en-US")} rows\n`);
    for (const check of report.checks) if (check.level !== "ok") process.stdout.write(`       ${check.level} ${check.check}: ${check.message}\n`);
  }
  process.stdout.write(`${shared.length + workspace.length} definitions, ${failed} with errors\n`);
  if (failed) process.exitCode = 1;
};
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "The check failed."}\n`); process.exitCode = 1; });
