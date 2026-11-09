import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteVariableMappingRepository, VariableMappingDiscoveryService, VariableMappingPackService } from "../../variable-mapping/index.js";
import { DefinitionPackRepository, DictionaryIndex, VariableDefinitionStore, checkAgainst, compileDefinition, evaluateFormula, parseFormula, type VariableDefinition } from "../index.js";

const index = new DictionaryIndex({ schema_version: "1.0.0", sections: {
  lab: [
    { id: 50868, label: "Anion Gap", table: "labevents", fluid: "Blood", rows: 900_000, admissions: 400_000, median: 14, p01: 7, p99: 28, units: [["mEq/L", 890_000]] },
    { id: 50889, label: "C-Reactive Protein", table: "labevents", rows: 60_000, admissions: 30_000, median: 20, p01: 0.5, p99: 300, units: [["mg/L", 59_000], ["mg/dL", 20_000]] },
    { id: 50999, label: "Unused item", table: "labevents", rows: 0, admissions: 0 },
  ],
  item: [{ id: 225150, label: "Dexmedetomidine (Precedex)", table: "inputevents", rows: 120_000, admissions: 30_000 }],
  drug: [{ label: "Dexmedetomidine", rows: 4000, admissions: 3000 }, { label: "Cholecalciferol", rows: 9000, admissions: 7000 }],
  diagnosis: [
    { code: "I21A1", version: 10, label: "Myocardial infarction type 2", rows: 8000, admissions: 8000, table: "diagnoses_icd" },
    { code: "I21A9", version: 10, label: "Other myocardial infarction type", rows: 100, admissions: 100, table: "diagnoses_icd" },
    { code: "4280", version: 9, label: "Congestive heart failure, unspecified", rows: 50_000, admissions: 50_000, table: "diagnoses_icd" },
  ],
  procedure: [],
} });
const base = { schema_version: "1.0.0" as const, version: "1.0.0", status: "researcher_defined" as const, synonyms: [] as string[] };
const anionGap: VariableDefinition = { ...base, definition_id: "anion_gap", kind: "lab_or_chart", labels: { en: "Anion gap" }, synonyms: ["AG"], meaning: "Serum sodium minus chloride and bicarbonate.", items: { table: "labevents", item_ids: [50868], unit: "mEq/L", valid_range: { min: 0, max: 60 }, aggregation: "maximum" } };
const others = [{ concept_id: "creatinine", labels: { en: "Creatinine" }, synonyms: ["serum creatinine"] }, { concept_id: "albumin", labels: { en: "Albumin" }, synonyms: [] }];

test("a complete definition passes every check and reports the counts it will show the researcher", () => {
  const report = checkAgainst(anionGap, { index, others });
  assert.equal(report.ok, true);
  assert.equal(report.facts.admissions, 400_000); assert.equal(report.facts.median, 14);
  assert.ok(report.checks.every((check) => check.level !== "error"));
});

test("an item that does not exist, an item with no rows and a name already taken are errors", () => {
  assert.match(checkAgainst({ ...anionGap, items: { table: "labevents", item_ids: [1] } }, { index, others }).checks.find((c) => c.check === "items_exist")!.message, /labevents item 1/u);
  assert.equal(checkAgainst({ ...anionGap, items: { table: "labevents", item_ids: [50999] } }, { index, others }).ok, false);
  const taken = checkAgainst({ ...anionGap, definition_id: "scr", labels: { en: "Serum creatinine" } }, { index, others });
  assert.equal(taken.ok, false); assert.match(taken.checks.find((c) => c.check === "name_collision")!.message, /creatinine/u);
});

test("a unit mix is a warning, a missing ratio part is an error", () => {
  const crp: VariableDefinition = { ...anionGap, definition_id: "crp", labels: { en: "C-reactive protein" }, synonyms: ["CRP"], items: { table: "labevents", item_ids: [50889] } };
  const mix = checkAgainst(crp, { index, others });
  assert.equal(mix.ok, true); assert.equal(mix.checks.find((c) => c.check === "distribution")!.level, "warning");
  const ratio: VariableDefinition = { ...base, definition_id: "crp_albumin", kind: "ratio", labels: { en: "CRP to albumin ratio" }, meaning: "CRP divided by albumin.", ratio: { numerator: "crp", denominator: "albumin" } };
  assert.equal(checkAgainst(ratio, { index, others }).ok, false);
  assert.equal(checkAgainst(ratio, { index, others: [...others, { concept_id: "crp", labels: { en: "C-reactive protein" }, synonyms: [] }] }).ok, true);
});

test("definitions compile to pack entries the resolver reads", () => {
  const lab = compileDefinition(anionGap, index);
  assert.equal(lab.category, "laboratory"); assert.deepEqual(lab.sources[0]!.item_ids, [50868]); assert.equal(lab.status, "database_verified"); assert.match(lab.definition.summary, /not reviewed/u);
  const drug = compileDefinition({ ...base, definition_id: "dexmedetomidine", kind: "drug", labels: { en: "Dexmedetomidine" }, meaning: "Alpha-2 agonist sedative.", drug: { prescription_labels: ["Dexmedetomidine"] } }, index);
  assert.deepEqual(drug.sources[0]!.value_filters, [{ column: "drug", values: ["Dexmedetomidine"] }]);
  assert.throws(() => compileDefinition({ ...base, definition_id: "dex_both", kind: "drug", labels: { en: "x" }, meaning: "x", drug: { prescription_labels: ["Dexmedetomidine"], input_item_ids: [225150] } }, index), /not both/u);
  const mi = compileDefinition({ ...base, definition_id: "type2_mi", kind: "diagnosis", labels: { en: "Type 2 myocardial infarction" }, meaning: "MI due to supply-demand mismatch.", diagnosis: { codes: [{ code: "I21A*", version: 10 }] } }, index);
  assert.deepEqual(mi.sources[0]!.codes!.map(({ code }) => code), ["I21A1", "I21A9"]);
  const ratio = compileDefinition({ ...base, definition_id: "crp_albumin", kind: "ratio", labels: { en: "CRP to albumin ratio" }, meaning: "m", ratio: { numerator: "crp", denominator: "albumin" } }, index);
  assert.deepEqual(ratio.definition.formula, { expression: "numerator / denominator", variables: { numerator: "crp", denominator: "albumin" } });
});

test("a formula runs arithmetic only", () => {
  const { tree, names } = parseFormula("(100 - hct) / hb");
  assert.deepEqual(names.sort(), ["hb", "hct"]);
  assert.equal(evaluateFormula(tree, { hct: 40, hb: 12 }), 5);
  assert.ok(Number.isNaN(evaluateFormula(tree, { hct: 40 })));
  assert.ok(Number.isNaN(evaluateFormula(parseFormula("a / b").tree, { a: 1, b: 0 })));
  assert.equal(evaluateFormula(parseFormula("glucose / (1.59 * a1c - 2.59)").tree, { glucose: 180, a1c: 7 }), 180 / (1.59 * 7 - 2.59));
  assert.throws(() => parseFormula("process.exit()"), /not allowed/u);
  assert.throws(() => parseFormula("a ^ b"), /not allowed/u);
});

test("a folder of definitions becomes a pack", async () => {
  const store = new VariableDefinitionStore(await mkdtemp(join(tmpdir(), "definitions-")));
  await store.save(anionGap);
  const pack = await new DefinitionPackRepository({ stores: [store], index, packId: "test" }).load();
  assert.deepEqual(pack.mappings.map((entry) => entry.concept_id), ["anion_gap"]);
});

test("a formula catalog finds a defined name and labels its parts", async () => {
  const { FormulaCatalog } = await import("../index.js");
  const epvs: VariableDefinition = { ...base, definition_id: "epvs", kind: "formula", labels: { en: "Estimated plasma volume status", zh: "估计血浆容量状态" }, synonyms: ["ePVS"], meaning: "Duarte estimate of plasma volume.", formula: { expression: "(100 - hct) / hb", variables: { hct: "hematocrit", hb: "hemoglobin" } } };
  const ratio: VariableDefinition = { ...base, definition_id: "crp_albumin", kind: "ratio", labels: { en: "CRP to albumin ratio" }, synonyms: [], meaning: "m", ratio: { numerator: "crp", denominator: "albumin" } };
  const catalog = new FormulaCatalog([epvs, ratio], (id) => ({ hematocrit: "Hematocrit", hemoglobin: "Hemoglobin", crp: "C-reactive protein", albumin: "Albumin" })[id]);
  assert.deepEqual(catalog.find("estimated plasma volume status")!.parts, [{ name: "hct", label_en: "Hematocrit" }, { name: "hb", label_en: "Hemoglobin" }]);
  assert.equal(catalog.find("ePVS")!.expression, "(100 - hct) / hb");
  assert.deepEqual(catalog.find("CRP to albumin ratio")!.parts.map((part) => part.label_en), ["C-reactive protein", "Albumin"]);
  assert.equal(catalog.find("anion gap"), undefined);
  assert.equal(catalog.find("higher estimated plasma volume status at ICU admission")!.label_en, "Estimated plasma volume status");
  assert.equal(catalog.find("the ePVS value"), undefined, "a one-word name is matched only when it is the whole text");
});

test("a researcher cannot save over or alongside a shared definition, and saves only as researcher_defined", async () => {
  const { VariableDefinitionService, VariableDefinitionError } = await import("../index.js");
  const root = await mkdtemp(join(tmpdir(), "service-"));
  const shared = new VariableDefinitionStore(join(root, "shared")); const workspace = new VariableDefinitionStore(join(root, "workspace"));
  await shared.save({ ...anionGap, status: "team_reviewed" });
  const pack = join(root, "pack.json"); await (await import("node:fs/promises")).writeFile(pack, JSON.stringify({ mappings: others }));
  const service = new VariableDefinitionService({ index, shared, workspace, packFile: new URL(`file://${pack}`) });
  await assert.rejects(service.save({ ...anionGap, status: "validated" }), (error: unknown) => error instanceof VariableDefinitionError && /already a name/u.test(JSON.stringify(error.report)));
  const crp: VariableDefinition = { ...base, definition_id: "crp", kind: "lab_or_chart", labels: { en: "C-reactive protein" }, synonyms: ["CRP"], meaning: "Inflammation marker.", items: { table: "labevents", item_ids: [50889] }, status: "validated" };
  const { definition } = await service.save(crp);
  assert.equal(definition.status, "researcher_defined", "a researcher cannot grant a higher status");
  assert.equal((await service.check(definition)).ok, true, "re-checking its own saved copy is not a name clash");
  await assert.rejects(service.remove("anion_gap"), /shared definition cannot be removed/u);
});

test("a definition a researcher saved resolves at once, and its status stays visible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "definitions-resolve-"));
  const store = new VariableDefinitionStore(directory);
  await store.save({ ...base, definition_id: "fungal_infection", labels: { en: "Fungal infection" }, meaning: "Test definition.", kind: "diagnosis", diagnosis: { codes: [{ code: "4280", version: 9 }] } });
  const mappings = new SqliteVariableMappingRepository(join(directory, "mappings.sqlite"));
  await new VariableMappingPackService({ pack: new DefinitionPackRepository({ stores: [store], index, packId: "test" }), mappings }).seed();
  const result = await new VariableMappingDiscoveryService({ mappings }).search({ term: "Fungal infection", role: "exposure", expected_value_type: "binary" });
  assert.equal(result.status, "resolved");
  assert.equal(result.candidates[0]!.mapping.status, "database_verified");
  assert.equal(result.candidates[0]!.requires_clinician_confirmation, false);
});

test("a laboratory item over the scan budget is profiled from the dictionary index, and an unknown item falls back to the scan", async () => {
  const { IndexedEvidenceProfiler } = await import("../index.js");
  const compiled = compileDefinition(anionGap, index);
  const record = { ...compiled, evidence: {}, created_at: "x", updated_at: "x" } as unknown as Parameters<InstanceType<typeof IndexedEvidenceProfiler>["profile"]>[0];
  const fromIndex = await new IndexedEvidenceProfiler(index).profile(record);
  assert.equal(fromIndex.matched_record_count, 900_000); assert.equal(fromIndex.source_id, "mimiciv_hosp.labevents"); assert.equal(fromIndex.units[0]!.value, "mEq/L");
  const unknown = { ...record, mapping_id: "other", sources: [{ ...record.sources[0]!, item_ids: [1] }] };
  await assert.rejects(new IndexedEvidenceProfiler(index).profile(unknown), /no scan is configured/u);
  const scanned = await new IndexedEvidenceProfiler(index, { profile: async () => ({ ...fromIndex, matched_record_count: 7 }) }).profile(unknown);
  assert.equal(scanned.matched_record_count, 7);
});

test("a definition deleted from its folder stops resolving after the next seeding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "definitions-delete-"));
  const store = new VariableDefinitionStore(directory);
  await store.save({ ...base, definition_id: "fungal_infection", labels: { en: "Fungal infection" }, meaning: "Test definition.", kind: "diagnosis", diagnosis: { codes: [{ code: "4280", version: 9 }] } });
  const mappings = new SqliteVariableMappingRepository(join(directory, "mappings.sqlite"));
  const seed = async () => { const pack = new DefinitionPackRepository({ stores: [store], index, packId: "test" }); await new VariableMappingPackService({ pack, mappings }).seed(); return (await pack.load()).mappings.map(({ mapping_id }) => mapping_id); };
  assert.equal(mappings.dropVariableDefinitionsExcept(await seed()), 0);
  assert.equal((await mappings.findByTerm("Fungal infection")).length, 1);
  await store.remove("fungal_infection");
  assert.equal(mappings.dropVariableDefinitionsExcept(await seed()), 1);
  assert.equal((await mappings.findByTerm("Fungal infection")).length, 0);
});

test("a measurement named only by its words is drafted from blood laboratory items; urine and other specimens are never taken", async () => {
  const { proposeItemDefinition, proposeDrugDefinition } = await import("../index.js");
  const withFluids = new DictionaryIndex({ schema_version: "1.0.0", sections: {
    lab: [
      { id: 50902, label: "Chloride", table: "labevents", fluid: "Blood", rows: 900_000, admissions: 300_000, units: [["mEq/L", 890_000]] },
      { id: 50806, label: "Chloride, Whole Blood", table: "labevents", fluid: "Blood", rows: 50_000, admissions: 20_000, units: [["mEq/L", 50_000]] },
      { id: 51078, label: "Chloride, Urine", table: "labevents", fluid: "Urine", rows: 100_000, admissions: 40_000, units: [["mEq/L", 100_000]] },
    ],
    item: [], drug: [{ label: "Thiamine", rows: 5000, admissions: 3000 }, { label: "Vitamin C", rows: 900, admissions: 800 }], diagnosis: [], procedure: [],
  } });
  const chloride = proposeItemDefinition(withFluids, "Serum Chloride")!;
  assert.deepEqual(chloride.definition.items!.item_ids, [50902, 50806]); assert.equal(chloride.definition.items!.unit, "mEq/L");
  assert.equal(proposeItemDefinition(withFluids, "Serum Bicarbonate"), undefined);
  assert.equal(proposeDrugDefinition(withFluids, "Thiamine Supplementation")!.definition.drug!.prescription_labels![0], "Thiamine");
  assert.deepEqual(proposeDrugDefinition(withFluids, "Intravenous Vitamin C")!.definition.drug!.prescription_labels, ["Vitamin C"]);
});

test("an acronym or clinical equivalent is tried when the written words match no dictionary title; a definition few admissions carry is not offered", async () => {
  const { alternativeForms, proposeDiagnosisDefinition } = await import("../index.js");
  const synonyms = { phrases: { copd: ["chronic obstructive pulmonary disease"], "prostate cancer": ["malignant neoplasm of prostate"], cancer: ["malignant neoplasm"] } };
  assert.deepEqual(alternativeForms("Acute exacerbation of COPD", synonyms), ["Acute exacerbation of COPD", "acute exacerbation of chronic obstructive pulmonary disease"]);
  assert.deepEqual(alternativeForms("prostate cancer", synonyms).slice(0, 2), ["prostate cancer", "malignant neoplasm of prostate"]);
  assert.deepEqual(alternativeForms("scopd syndrome", synonyms), ["scopd syndrome"]);
  const withCodes = new DictionaryIndex({ schema_version: "1.0.0", sections: { lab: [], item: [], drug: [], procedure: [], diagnosis: [
    { code: "J441", version: 10, label: "Chronic obstructive pulmonary disease with (acute) exacerbation", rows: 9000, admissions: 9000, table: "diagnoses_icd" },
    { code: "J440", version: 10, label: "Chronic obstructive pulmonary disease with (acute) lower respiratory infection", rows: 100, admissions: 100, table: "diagnoses_icd" },
    { code: "C61", version: 10, label: "Malignant neoplasm of prostate", rows: 3000, admissions: 3000, table: "diagnoses_icd" },
    { code: "R000", version: 10, label: "Weight rare thing", rows: 3, admissions: 3, table: "diagnoses_icd" },
  ] } });
  assert.deepEqual(proposeDiagnosisDefinition(withCodes, "Acute exacerbation of COPD", synonyms)!.definition.diagnosis!.codes, [{ code: "J441", version: 10 }]);
  assert.equal(proposeDiagnosisDefinition(withCodes, "COPD exacerbation"), undefined);
  assert.equal(proposeDiagnosisDefinition(withCodes, "Prostate Cancer", synonyms)!.facts.admissions, 3000);
  assert.equal(proposeDiagnosisDefinition(withCodes, "weight rare thing"), undefined, "three admissions are too few to be the right definition");
});

test("a drafted definition is dropped once the pack names the same thing, and a drug draft needs labels that start with the drug", async () => {
  const { DRAFT_AUTHOR, proposeDrugDefinition } = await import("../index.js");
  const directory = await mkdtemp(join(tmpdir(), "definitions-draft-"));
  const store = new VariableDefinitionStore(directory);
  await store.save({ ...base, definition_id: "prolonged_icu_stay", labels: { en: "Prolonged ICU stay" }, meaning: "drafted", kind: "diagnosis", author: DRAFT_AUTHOR, diagnosis: { codes: [{ code: "4280", version: 9 }] } });
  await store.save({ ...base, definition_id: "fungal_infection", labels: { en: "Fungal infection" }, meaning: "written by a person", kind: "diagnosis", diagnosis: { codes: [{ code: "4280", version: 9 }] } });
  const packNames = new Set(["prolonged icu stay"]);
  const pack = await new DefinitionPackRepository({ stores: [store], index, packId: "w", skip: (definition) => definition.author === DRAFT_AUTHOR && packNames.has(definition.labels.en.toLowerCase()) }).load();
  assert.deepEqual(pack.mappings.map(({ concept_id }) => concept_id), ["fungal_infection"]);
  const drugs = new DictionaryIndex({ schema_version: "1.0.0", sections: { lab: [], item: [], diagnosis: [], procedure: [], drug: [{ label: "Enoxaparin (Low Molecular Weight)", rows: 9000, admissions: 9000 }, { label: "Magnesium Sulfate", rows: 9000, admissions: 9000 }] } });
  assert.equal(proposeDrugDefinition(drugs, "Weight"), undefined);
  assert.equal(proposeDrugDefinition(drugs, "intravenous magnesium sulfate")!.definition.author, DRAFT_AUTHOR);
});
