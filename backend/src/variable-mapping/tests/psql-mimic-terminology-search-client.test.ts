import assert from "node:assert/strict";
import test from "node:test";
import { PsqlMimicTerminologySearchClient } from "../index.js";

test("searches only fixed MIMIC dictionaries through a read-only psql request", async () => {
  let captured: string[] = [];
  const client = new PsqlMimicTerminologySearchClient(
    { service: "mimic-iv", binary: "psql", connect_timeout_seconds: 5, statement_timeout_ms: 1000 },
    { async run(input) { captured = input.arguments_; return { exitCode: 0, stdout: '[{"dictionary":"d_labitems","identifier":"50813","label":"Lactate","category":"Blood Gas"}]\n' }; } },
  );
  const result = await client.search("lactate");
  assert.equal(result[0]?.identifier, "50813");
  assert.ok(captured.includes("search=lactate"));
  const sql = captured.at(-1) ?? "";
  assert.match(sql, /BEGIN READ ONLY/);
  assert.match(sql, /d_labitems/);
  assert.doesNotMatch(sql, /lactate/);
});
