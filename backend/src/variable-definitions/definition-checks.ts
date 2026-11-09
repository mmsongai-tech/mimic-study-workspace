import type { DictionaryIndex } from "./dictionary-index.js";
import { DEFINITION_ID, type VariableDefinition } from "./variable-definition.js";
import { parseFormula } from "./formula-expression.js";

export interface DefinitionFacts { rows: number; admissions: number; median?: number; p01?: number; p99?: number; units?: Array<[string, number]>; item_labels: string[] }
export interface DefinitionCheck { check: "structure" | "items_exist" | "counts" | "distribution" | "name_collision" | "parts"; level: "error" | "warning" | "ok"; message: string }
export interface DefinitionReport { ok: boolean; checks: DefinitionCheck[]; facts: DefinitionFacts }
/** Names already taken: normalized name → the variable that owns it. */
export type TakenNames = ReadonlyMap<string, string>;
/** Variables a ratio or formula may use: id or concept id → whether it exists. */
export type KnownVariables = ReadonlySet<string>;

export const nameKey = (name: string): string => name.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/[^\p{L}\p{N}]+/gu, "");

const emptyFacts: DefinitionFacts = { rows: 0, admissions: 0, item_labels: [] };

/** The checks a definition must pass before anyone can use it. Errors block; warnings are shown. */
export const checkDefinition = (definition: VariableDefinition, input: { index: DictionaryIndex; taken: TakenNames; known: KnownVariables }): DefinitionReport => {
  const checks: DefinitionCheck[] = []; const add = (check: DefinitionCheck["check"], level: DefinitionCheck["level"], message: string): void => { checks.push({ check, level, message }); };
  const facts: DefinitionFacts = { ...emptyFacts, item_labels: [] };
  const { index } = input;

  // 1 structure
  const problems: string[] = [];
  if (!DEFINITION_ID.test(definition.definition_id)) problems.push("The id must be lower-case letters, digits and underscores, starting with a letter (3–64 characters).");
  if (!definition.labels.en?.trim()) problems.push("An English label is required.");
  if (!definition.meaning?.trim()) problems.push("A one-line clinical meaning is required.");
  const body = { lab_or_chart: definition.items, drug: definition.drug, diagnosis: definition.diagnosis, procedure_or_event: definition.items, ratio: definition.ratio, formula: definition.formula }[definition.kind];
  if (!body) problems.push(`A ${definition.kind} definition needs its ${definition.kind === "lab_or_chart" || definition.kind === "procedure_or_event" ? "items" : definition.kind} section.`);
  if (definition.kind === "formula" && definition.formula) {
    try { const { names } = parseFormula(definition.formula.expression); const unbound = names.filter((name) => !definition.formula!.variables[name]); if (unbound.length) problems.push(`The formula uses ${unbound.join(", ")} but no variable is named for ${unbound.length > 1 ? "them" : "it"}.`); }
    catch (error) { problems.push(error instanceof Error ? error.message : "The formula could not be read."); }
  }
  add("structure", problems.length ? "error" : "ok", problems.length ? problems.join(" ") : "The definition is complete.");

  // 2 the items exist, 3 counts, 4 distribution
  const itemHits: Array<{ rows: number; admissions: number; label: string; median?: number; p01?: number; p99?: number; units?: Array<[string, number]> }> = [];
  const missing: string[] = [];
  if (definition.items && (definition.kind === "lab_or_chart" || definition.kind === "procedure_or_event")) for (const id of definition.items.item_ids) {
    const hit = index.item(definition.items.table, id); if (hit) itemHits.push({ rows: hit.rows, admissions: hit.admissions ?? 0, label: hit.label, ...(hit.median !== undefined ? { median: hit.median, p01: hit.p01!, p99: hit.p99! } : {}), ...(hit.units ? { units: hit.units } : {}) }); else missing.push(`${definition.items.table} item ${id}`);
  }
  if (definition.drug) {
    for (const label of definition.drug.prescription_labels ?? []) { const hit = index.drug(label); if (hit) itemHits.push({ rows: hit.rows, admissions: hit.admissions, label }); else missing.push(`prescription label “${label}”`); }
    for (const id of definition.drug.input_item_ids ?? []) { const hit = index.item("inputevents", id); if (hit) itemHits.push({ rows: hit.rows, admissions: hit.admissions ?? 0, label: hit.label }); else missing.push(`input item ${id}`); }
  }
  if (definition.diagnosis) for (const { code, version } of definition.diagnosis.codes) {
    if (code.endsWith("*")) { const found = index.codesWithPrefix("diagnosis", code.slice(0, -1), version); if (!found.length) missing.push(`ICD-${version} codes starting ${code.slice(0, -1)}`); for (const entry of found) itemHits.push({ rows: entry.rows, admissions: entry.admissions, label: `${entry.code} ${entry.label}` }); }
    else { const hit = index.code("diagnosis", code, version); if (hit) itemHits.push({ rows: hit.rows, admissions: hit.admissions, label: `${hit.code} ${hit.label}` }); else missing.push(`ICD-${version} code ${code}`); }
  }
  const hasSources = Boolean(definition.items || definition.drug || definition.diagnosis);
  if (hasSources) {
    add("items_exist", missing.length ? "error" : "ok", missing.length ? `Not found in the archive, or never recorded in it: ${missing.join("; ")}.` : `All ${itemHits.length} items exist in the dictionaries.`);
    facts.rows = itemHits.reduce((sum, hit) => sum + hit.rows, 0); facts.admissions = Math.max(0, ...itemHits.map((hit) => hit.admissions)); facts.item_labels = itemHits.map((hit) => hit.label).slice(0, 12);
    add("counts", facts.rows === 0 ? "error" : "ok", facts.rows === 0 ? "No row in the archive carries these items." : `At least ${facts.admissions.toLocaleString("en-US")} admissions and ${facts.rows.toLocaleString("en-US")} rows carry them.`);
    const main = [...itemHits].sort((a, b) => b.rows - a.rows)[0];
    if (main?.median !== undefined) {
      Object.assign(facts, { median: main.median, p01: main.p01, p99: main.p99, units: main.units });
      const range = definition.items?.valid_range; const notes: string[] = [];
      if (main.units && main.units.length > 1 && main.units[1]![1] / (main.units[0]![1] + main.units[1]![1]) > 0.1) notes.push(`more than one unit is in use (${main.units.slice(0, 3).map(([unit, count]) => `${unit} ${count}`).join(", ")}); values in different units cannot be mixed`);
      if (range?.min !== undefined && main.p01! < range.min || range?.max !== undefined && main.p99! > range.max) notes.push("the 1st–99th percentile range reaches outside the valid range you gave");
      add("distribution", notes.length ? "warning" : "ok", `Median ${main.median}, 1st–99th percentile ${main.p01}–${main.p99}${notes.length ? `; ${notes.join("; ")}` : ""}.`);
    } else add("distribution", "ok", "No numeric distribution applies to this variable.");
  }

  // 5 names
  const own = nameKey(definition.definition_id); const collisions: string[] = [];
  for (const name of [definition.labels.en, definition.labels.zh, ...definition.synonyms].filter((value): value is string => Boolean(value))) {
    const owner = input.taken.get(nameKey(name)); if (owner && owner !== own) collisions.push(`“${name}” is already a name of ${owner}`);
  }
  add("name_collision", collisions.length ? "error" : "ok", collisions.length ? `${collisions.join("; ")}. Two variables must not share a name.` : "None of its names belongs to another variable.");

  // 6 parts
  if (definition.kind === "ratio" || definition.kind === "formula") {
    const parts = definition.kind === "ratio" ? [definition.ratio?.numerator, definition.ratio?.denominator] : Object.values(definition.formula?.variables ?? {});
    const unknown = parts.filter((part): part is string => Boolean(part) && !input.known.has(part as string));
    add("parts", unknown.length ? "error" : "ok", unknown.length ? `These parts are not defined variables: ${unknown.join(", ")}.` : "Every part is a defined variable.");
  }
  return { ok: checks.every((check) => check.level !== "error"), checks, facts };
};
