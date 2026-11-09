import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVariableMappingRepository, VariableMappingPackService } from "../index.js";
import type { VariableMappingRecord } from "../index.js";

const baseMapping = (overrides: Partial<VariableMappingRecord> = {}): VariableMappingRecord => ({
  schema_version: "1.0.0", mapping_id: "mimic-iv.vasopressors.v1", concept_id: "vasopressors", mapping_version: "1.0.0",
  labels: { en: "Vasopressors" }, synonyms: ["vasopressor"], category: "medication", value_type: "binary",
  definition: {
    summary: "ICU infusion of any vasopressor.", temporal_rule: "Any recorded event in the study window relative to time zero.",
    value_rule: "Any record of items 221906, 221289.", missingness_rule: "No record means not given during the ICU stay.",
    aggregation: "any",
  },
  sources: [{ kind: "dictionary_item", schema: "mimiciv_icu", table: "inputevents", columns: ["subject_id", "itemid"], dictionary_table: "d_items", item_ids: [221906, 221289] }],
  status: "validated", provenance: "versioned_seed", evidence: {}, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** exactOptionalPropertyTypes forbids `aggregation: undefined`; this drops the key entirely instead. */
const withoutAggregation = (record: VariableMappingRecord): VariableMappingRecord => {
  const { aggregation: _aggregation, ...rest } = record.definition;
  return { ...record, definition: rest };
};

const fakeStore = (initial: VariableMappingRecord[]) => {
  const rows = new Map(initial.map((row) => [row.mapping_id, row]));
  return {
    saved: [] as VariableMappingRecord[],
    repository: {
      save: async (record: VariableMappingRecord) => { rows.set(record.mapping_id, record); return true; },
      findById: async (id: string) => rows.get(id),
      findByTerm: async () => [],
      listByStatus: async () => [...rows.values()],
    },
  };
};

test("re-seeds a stored row whose content drifted from the pack even though its version string didn't change", async () => {
  // Reproduces a real bug: the pack file gained `definition.aggregation` for vasopressors without bumping
  // mapping_version, so a store seeded before that change kept serving the aggregation-less row forever and
  // every plan using it as a covariate failed with "No aggregation rule is frozen for Vasopressors."
  const staleRow = withoutAggregation(baseMapping());
  const store = fakeStore([staleRow]);
  const service = new VariableMappingPackService({
    pack: { load: async () => ({ mappings: [baseMapping()] }) } as never,
    mappings: store.repository,
  });
  const written = await service.seed();
  assert.equal(written, 1);
  const updated = await store.repository.findById("mimic-iv.vasopressors.v1");
  assert.equal(updated?.definition.aggregation, "any");
});

test("does not rewrite a stored row that is truly identical to the pack", async () => {
  const store = fakeStore([baseMapping()]);
  let saveCalls = 0;
  const service = new VariableMappingPackService({
    pack: { load: async () => ({ mappings: [baseMapping()] }) } as never,
    mappings: { ...store.repository, save: async (record) => { saveCalls += 1; return store.repository.save(record); } },
  });
  const written = await service.seed();
  assert.equal(written, 0);
  assert.equal(saveCalls, 0);
});

test("never overwrites a clinician-reviewed row, even if its content differs from the pack", async () => {
  const reviewed = withoutAggregation(baseMapping({ provenance: "clinician_review" }));
  const store = fakeStore([reviewed]);
  const service = new VariableMappingPackService({
    pack: { load: async () => ({ mappings: [baseMapping()] }) } as never,
    mappings: store.repository,
  });
  const written = await service.seed();
  assert.equal(written, 0);
  const kept = await store.repository.findById("mimic-iv.vasopressors.v1");
  assert.equal(kept?.definition.aggregation, undefined);
  assert.equal(kept?.provenance, "clinician_review");
});

test("still writes a brand-new mapping id that isn't in the store yet", async () => {
  const store = fakeStore([]);
  const service = new VariableMappingPackService({
    pack: { load: async () => ({ mappings: [baseMapping()] }) } as never,
    mappings: store.repository,
  });
  const written = await service.seed();
  assert.equal(written, 1);
  assert.ok(await store.repository.findById("mimic-iv.vasopressors.v1"));
});

test("against the real SQLite repository: a version bump is required for a stale row to actually update, not just be detected", async () => {
  // The in-memory fakeStore above always accepts a save; the real repository additionally refuses to overwrite a
  // row whose mapping_version matches but whose content differs (SqliteVariableMappingRepository.save(), by
  // design, to catch exactly this kind of drift). seed() alone recognizing the drift isn't enough — reproduces
  // the real bug: content changed (aggregation added) with mapping_version left at "1.0.0" stuck forever, and
  // confirms it resolves once the pack's mapping_version is actually bumped.
  const directory = await mkdtemp(join(tmpdir(), "pack-seed-sqlite-"));
  try {
    const repository = new SqliteVariableMappingRepository(join(directory, "mappings.sqlite"));
    const stale = withoutAggregation(baseMapping());
    await repository.save(stale);

    const sameVersionFix = new VariableMappingPackService({ pack: { load: async () => ({ mappings: [baseMapping()] }) } as never, mappings: repository });
    await sameVersionFix.seed();
    const stillStale = await repository.findById("mimic-iv.vasopressors.v1");
    assert.equal(stillStale?.definition.aggregation, undefined, "same mapping_version with different content is refused by the repository, not silently written");

    const bumped = new VariableMappingPackService({ pack: { load: async () => ({ mappings: [baseMapping({ mapping_version: "1.1.0" })] }) } as never, mappings: repository });
    await bumped.seed();
    const fixed = await repository.findById("mimic-iv.vasopressors.v1");
    assert.equal(fixed?.definition.aggregation, "any");
    assert.equal(fixed?.mapping_version, "1.1.0");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
