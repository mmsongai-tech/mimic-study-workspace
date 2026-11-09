import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { DictionaryIndex, VariableDefinitionService, VariableDefinitionStore } from "../index.js";

const indexPath = new URL("../../../../.local/dictionary-index.json", import.meta.url);
const available = await access(indexPath).then(() => true, () => false);

// The reviewed definitions of config/variables must keep passing every check against the archive's dictionary index
// (scripts/build-dictionary-index.py builds it locally; the test is skipped on a machine without the archive).
test("every shared variable definition passes the checks", { skip: !available && "no .local/dictionary-index.json" }, async () => {
  const service = new VariableDefinitionService({
    index: await DictionaryIndex.load(indexPath), shared: new VariableDefinitionStore(new URL("../../../../config/variables", import.meta.url).pathname), workspace: new VariableDefinitionStore("/nonexistent/workspace"),
    packFile: new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url), drugClassFile: new URL("../../../../config/drug-classes/drug-classes.json", import.meta.url),
  });
  const { shared } = await service.list();
  assert.ok(shared.length >= 13);
  for (const definition of shared) {
    const report = await service.check(definition, "shared");
    assert.ok(report.ok, `${definition.definition_id}: ${report.checks.filter((check) => check.level === "error").map((check) => check.message).join(" ")}`);
  }
});
