import assert from "node:assert/strict";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { completeAssociationProposal } from "../../research-design/tests/model-fixtures.js";
import { RESEARCH_DESIGN_OUTPUT_SCHEMA, RESEARCH_DESIGN_OUTPUT_CONTRACT, RESEARCH_DESIGN_COMPACT_OUTPUT_SCHEMA } from "../research-design-output-contract.js";

test("compact schema preserves canonical acceptance for missing, changed and extra fields", () => {
  const ajv = new Ajv2020({ strict: false });
  const full = ajv.compile(RESEARCH_DESIGN_OUTPUT_SCHEMA);
  const compact = ajv.compile(RESEARCH_DESIGN_COMPACT_OUTPUT_SCHEMA);
  const valid = completeAssociationProposal();
  const paths: string[][] = [];
  const walk = (value: unknown, path: string[] = []) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) { paths.push([...path, key]); walk(child, [...path, key]); }
  };
  walk(valid);
  assert.equal(compact(valid), true);
  for (const path of paths) for (const replacement of [null, {}, [], false, 999, "invalid", undefined]) {
    const candidate = structuredClone(valid) as unknown as Record<string, unknown>;
    let parent = candidate;
    for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string, unknown>;
    if (replacement === undefined) delete parent[path.at(-1)!]; else parent[path.at(-1)!] = replacement;
    assert.equal(compact(candidate), full(candidate), `equivalence at ${path.join("/")}`);
  }
  assert.equal(compact({ ...valid, unexpected: true }), false);
  assert.ok(JSON.stringify(RESEARCH_DESIGN_COMPACT_OUTPUT_SCHEMA).length < JSON.stringify(RESEARCH_DESIGN_OUTPUT_SCHEMA).length);
});

test("bundled model contract resolves canonical references and validates the same proposal", () => {
  const validate = new Ajv2020({ strict: false }).compile(RESEARCH_DESIGN_OUTPUT_SCHEMA);
  const proposal = completeAssociationProposal();
  assert.equal(validate(proposal), true, JSON.stringify(validate.errors));
  const invalid = structuredClone(proposal);
  invalid.intent_assessment.confidence = "unsupported" as never;
  assert.equal(validate(invalid), false);
  assert.equal(validate({ ...proposal, candidate_spec: { schema_version: "1.0.0", intent_family: "association", population: "wrong shape" } }), false);
});

test("bundling preserves title/description property schemas and includes one copy of each document", () => {
  const definitions = RESEARCH_DESIGN_OUTPUT_SCHEMA.$defs as Record<string, any>;
  assert.deepEqual(Object.keys(definitions), ["proposal", "intent-assessment", "study-spec"]);
  assert.ok(definitions["study-spec"].properties.title);
  assert.ok(definitions["study-spec"].$defs.population.properties.description);
  assert.equal(definitions.proposal.properties.candidate_spec.$ref, "#/$defs/study-spec");
  assert.equal(definitions.proposal.$defs.suggestion.properties.candidate_spec.$ref, "#/$defs/study-spec");
  assert.ok(Buffer.byteLength(JSON.stringify(RESEARCH_DESIGN_OUTPUT_CONTRACT)) < 18000);
});
