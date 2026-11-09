import { readFileSync } from "node:fs";

type Schema = Record<string, unknown>;
const names = ["proposal", "intent-assessment", "study-spec"] as const;
const documents = Object.fromEntries(names.map((name) => [name, JSON.parse(readFileSync(
  new URL(`../../../contracts/research-design/${name}.schema.json`, import.meta.url), "utf8",
)) as Schema])) as Record<(typeof names)[number], Schema>;
const documentIds = new Map(names.map((name) => [String(documents[name].$id), name]));

/** Bundle each canonical document once, preserving every constraint and property name. */
const bundle = (value: unknown, scope: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => bundle(item, scope));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$id" && key !== "$schema").map(([key, item]) => {
    if (key !== "$ref" || typeof item !== "string") return [key, bundle(item, scope)];
    if (item.startsWith("#/")) return [key, `#/$defs/${scope}${item.slice(1)}`];
    const [id = "", fragment] = item.split("#");
    const target = documentIds.get(id);
    if (!target) throw new Error("The research-design output contract has an unknown schema reference.");
    return [key, `#/$defs/${target}${fragment ?? ""}`];
  }));
};

export const RESEARCH_DESIGN_OUTPUT_SCHEMA = {
  $ref: "#/$defs/proposal",
  $defs: Object.fromEntries(names.map((name) => [name, bundle(documents[name], name)])),
};

// Visit schema positions only: properties named "title" or "description" are data,
// and enum/const objects must never be rewritten as schemas.
const mapSchema = (value: unknown, transform: (schema: Schema) => Schema): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const maps = ["properties", "patternProperties", "$defs", "dependentSchemas"];
  const lists = ["allOf", "anyOf", "oneOf", "prefixItems"];
  const singles = ["items", "contains", "not", "if", "then", "else", "additionalProperties", "unevaluatedProperties", "propertyNames"];
  return transform(Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (maps.includes(key) && child && typeof child === "object" && !Array.isArray(child)) {
      return [key, Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, mapSchema(schema, transform)]))];
    }
    if (lists.includes(key) && Array.isArray(child)) return [key, child.map((schema) => mapSchema(schema, transform))];
    return [key, singles.includes(key) ? mapSchema(child, transform) : child];
  })));
};

/** Factor identical schemas into shared references without dropping constraints. */
const compactSchema = (): Schema => {
  const counts = new Map<string, number>();
  mapSchema(RESEARCH_DESIGN_OUTPUT_SCHEMA, (schema) => {
    const key = JSON.stringify(schema);
    if (!("$defs" in schema) && key.length > 45) counts.set(key, (counts.get(key) ?? 0) + 1);
    return schema;
  });
  const aliases = new Map([...counts].filter(([, count]) => count > 1).map(([key], index) => [key, `shared${index}`]));
  const shared = Object.fromEntries([...aliases].map(([key, alias]) => [alias, JSON.parse(key) as Schema]));
  // Match before rewriting descendants so the fingerprint remains canonical.
  const replace = (value: unknown): unknown => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const alias = aliases.get(JSON.stringify(value));
    if (alias) return { $ref: `#/$defs/${alias}` };
    const maps = ["properties", "patternProperties", "$defs", "dependentSchemas"];
    const lists = ["allOf", "anyOf", "oneOf", "prefixItems"];
    const singles = ["items", "contains", "not", "if", "then", "else", "additionalProperties", "unevaluatedProperties", "propertyNames"];
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (maps.includes(key) && child && typeof child === "object" && !Array.isArray(child)) return [key, Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, replace(schema)]))];
      if (lists.includes(key) && Array.isArray(child)) return [key, child.map(replace)];
      return [key, singles.includes(key) ? replace(child) : child];
    }));
  };
  const compact = replace(RESEARCH_DESIGN_OUTPUT_SCHEMA) as Schema;
  compact.$defs = { ...(compact.$defs as Schema), ...shared };
  return JSON.stringify(compact).length < JSON.stringify(RESEARCH_DESIGN_OUTPUT_SCHEMA).length ? compact : RESEARCH_DESIGN_OUTPUT_SCHEMA;
};

export const RESEARCH_DESIGN_COMPACT_OUTPUT_SCHEMA = compactSchema();

export const RESEARCH_DESIGN_OUTPUT_CONTRACT = {
  id: "research-design-proposal",
  transport_version: "1.3.0",
  schema: RESEARCH_DESIGN_OUTPUT_SCHEMA,
  objective_contract: "When request.study_spec_contract is objectives-v1 or current_spec.analysis_objectives exists, preserve analysis_objectives.original_question exactly. First extract all independent requested objectives with stable IDs and source_text, outcome_structure and requires_derivation when known. Keep this inventory across turns. Each requested ID must have its own objective with outcome, outcome_structure, time_windows, estimand, analysis_family and status before candidate_ready. An unsupported target is blocked with a reason, never omitted. all/any defines ONE composite event within an objective, never a list of analyses. Do not invent a numeric threshold to represent a continuous measurement. A difference requires explicit outcome.derivation (source_concept, baseline and follow_up windows, aggregation, direction). Shared baseline/exposure windows stay at root; each objective owns outcome/follow_up windows. Use concept/present to identify a continuous source measurement, not numeric_comparison. Root outcome fields are only a compatibility summary; the objective list is authoritative. Only ask humans about scientific choices, not database counts or field availability, which local evidence must determine.",
  instruction: "Return one JSON object matching this schema. Every continuation must include all required proposal root fields, not just a patch. Use candidate_ready only for a complete research design with defined population, index time, variables, outcome structure, time windows, covariates, estimand and analysis family. Otherwise ask at most three blocking clarification questions. Do not invent clinical definitions or data availability. Do not repeat the schema in the answer.",
} as const;

export const RESEARCH_DESIGN_COMPACT_OUTPUT_CONTRACT = {
  ...RESEARCH_DESIGN_OUTPUT_CONTRACT,
  schema: RESEARCH_DESIGN_COMPACT_OUTPUT_SCHEMA,
} as const;
