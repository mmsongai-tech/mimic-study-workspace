import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepositoryProductPromptRegistry,
  ProductPromptRegistryError,
} from "../index.js";

test("loads the explicitly registered Research Design product prompt", async () => {
  const registry = createRepositoryProductPromptRegistry();

  const prompt = await registry.load({ id: "research-design", version: "0.8.8" });

  assert.equal(prompt.status, "testing");
  assert.match(prompt.body, /# Purpose/u);
  assert.match(prompt.body, /# Expected output/u);
  assert.match(prompt.body, /output_language/u);
  assert.match(prompt.body, /Do not mix English prose into a Chinese response/u);
  assert.match(prompt.body, /Missing definitions stay missing/u);
  assert.match(prompt.body, /Independent outcomes belong in `analysis_objectives`/u);
  assert.match(prompt.body, /Keep `suggestions` empty unless/u);
});

test("loads the generated-analysis prompt only through the product registry", async () => {
  const prompt = await createRepositoryProductPromptRegistry().load({ id: "generated-analysis", version: "0.1.0" });
  assert.equal(prompt.status, "testing");
  assert.match(prompt.body, /verified MIMIC-IV field manifest/u);
  assert.match(prompt.body, /aggregate JSON object/u);
});

test("loads the bounded variable-mapping terminology prompt", async () => {
  const prompt = await createRepositoryProductPromptRegistry().load({ id: "variable-mapping", version: "0.3.0" });
  assert.equal(prompt.status, "testing");
  assert.match(prompt.body, /do not invent/iu);
  assert.match(prompt.body, /clinical abbreviations/iu);
  assert.match(prompt.body, /code_hints/u);
  assert.match(prompt.body, /complete local dictionary/u);
});

test("loads the automated dictionary-evidence review prompt with its authority boundary", async () => {
  const prompt = await createRepositoryProductPromptRegistry().load({ id: "mapping-evidence-review", version: "1.1.1" });
  assert.equal(prompt.status, "testing");
  assert.match(prompt.body, /smallest sufficient subset/iu);
  assert.match(prompt.body, /not clinician confirmation/iu);
  assert.match(prompt.body, /time window and aggregation/iu);
  assert.match(prompt.body, /derived outcome measure/iu);
});

test("loads objective extraction and independent coverage prompts", async () => {
  const registry = createRepositoryProductPromptRegistry();
  const extraction = await registry.load({ id: "research-objectives", version: "1.1.0" });
  const coverage = await registry.load({ id: "research-objective-coverage", version: "1.0.0" });
  const compiler = await registry.load({ id: "research-objective-study-spec", version: "1.1.0" });
  assert.match(extraction.body, /Do not silently omit/u);
  assert.match(coverage.body, /omitted claim/u);
  assert.match(compiler.body, /complete StudySpec/u);
});

test("rejects unknown, governance, and mismatched product prompts", async () => {
  const registry = createRepositoryProductPromptRegistry();

  await assert.rejects(
    () => registry.load({ id: "project-intake", version: "0.1.0" }),
    (error: unknown) => error instanceof ProductPromptRegistryError,
  );
  await assert.rejects(
    () => registry.load({ id: "research-design", version: "9.9.9" }),
    (error: unknown) => error instanceof ProductPromptRegistryError,
  );
});
