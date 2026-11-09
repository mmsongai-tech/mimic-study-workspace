import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisCapabilityRegistry } from "../index.js";

const manifest = { intent_family: "association" as const, analysis_family: "association", outcome_structure: "binary" as const, required_data_concepts: [], required_diagnostics: [], field_manifest: [] };

test("registers and resolves a user-selectable capability", async () => {
  const registry = new AnalysisCapabilityRegistry();
  registry.register({ capability_id: "association.example.v1", label: "Example", manifest, async execute() { return { status: "completed" }; } });
  assert.equal(registry.has("association.example.v1"), true);
  assert.deepEqual(registry.list()[0]!.manifest.field_manifest, []);
  assert.deepEqual(await registry.get("association.example.v1")!.execute({}), { status: "completed" });
});

test("rejects duplicate capabilities and exposes unregistered choices", () => {
  const registry = new AnalysisCapabilityRegistry();
  registry.register({ capability_id: "method.v1", label: "Method", manifest, async execute() { return null; } });
  assert.throws(() => registry.register({ capability_id: "method.v1", label: "Duplicate", manifest, async execute() { return null; } }), /unique capability_id/u);
  assert.equal(registry.get("method.not-registered"), undefined);
});
