import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { nodeHttp1Fetch } from "../runtime/node-http1-fetch.js";
import { VariableMappingError } from "./variable-mapping.js";
import { parseModelJsonObject } from "../model-output/index.js";
import type { ClinicalTermExpander, ClinicalTermExpansion } from "./terminology-gateway.js";

/** Version of the deterministic clean-up applied to model expansions; part of any cache key over expansions. */
export const TERM_EXPANSION_RULES_VERSION = "2";

const schema = JSON.parse(readFileSync(new URL("../../../contracts/variable-mapping/term-expansion.schema.json", import.meta.url), "utf8")) as object;
const CODE_HINT = /^(?=.*[0-9])[A-Za-z0-9.]{2,12}$/u;
const ICD_SYSTEM_PREFIX = /^icd[-\s]?(?:9|10)(?:[-\s]?cm)?[.:\s]*/iu;
const text = (value: unknown, max: number): string | undefined => typeof value === "string" && value.trim().length >= 2 ? value.trim().slice(0, max) : undefined;
const CODED_CATEGORIES = new Set(["diagnosis", "intervention"]);
// Salt and formulation words name a product, not the drug; dictionary search uses the ingredient name.
const DRUG_FORM_WORDS = /\b(?:tartrate|succinate|hydrochloride|hcl|sodium|potassium|calcium|magnesium|sulfate|sulphate|phosphate|acetate|citrate|maleate|mesylate|besylate|fumarate|bromide|chloride|extended[- ]release|sustained[- ]release|er|xl|sr|cr|la|oral|injection|tablets?|capsules?)\b/giu;
export const drugIngredientName = (label: string): string => {
  // The first word is the drug or class name ("Calcium channel blocker", "Potassium chloride"); only later words can
  // be salt or formulation words.
  const [first = "", ...rest] = label.trim().split(/\s+/u);
  const stripped = [first, rest.join(" ").replace(DRUG_FORM_WORDS, " ")].join(" ").replace(/\s+/gu, " ").trim();
  return stripped.length >= 3 ? stripped : label;
};
// Study-role words describe how a concept is used in a study, not the concept a dictionary label names.
const ROLE_WORDS = /\b(?:population|patients?|cohort|group|outcomes?|effect|efficacy|use of|usage|exposure)\b/giu;
const stripRoleWords = (label: string): string => {
  const stripped = label.replace(ROLE_WORDS, " ").replace(/\s+/gu, " ").trim();
  return stripped.length >= 2 ? stripped : label;
};

/**
 * Code hints and descriptive lists are optional search aids: small models often emit other coding systems
 * (SNOMED, ATC) or over-long lists that grammar-constrained decoding cannot prevent. Drop what is unusable
 * instead of rejecting the whole expansion; the label and category are still validated strictly afterwards.
 */
export const sanitizeTermExpansion = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const list = (field: unknown): unknown[] => Array.isArray(field) ? field : [];
  const coded = typeof record.category === "string" && CODED_CATEGORIES.has(record.category);
  const codeHints = !coded ? [] : [...new Set(list(record.code_hints)
    .map((hint) => typeof hint === "string" ? hint.trim().replace(ICD_SYSTEM_PREFIX, "") : "")
    .filter((hint) => CODE_HINT.test(hint)))].slice(0, 20);
  const synonyms = [...new Set(list(record.synonyms).map((synonym) => text(synonym, 120)).filter((synonym): synonym is string => Boolean(synonym)))].slice(0, 8);
  const ambiguities = list(record.ambiguities).flatMap((item) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const label = text(entry.label, 120); const explanation = text(entry.explanation, 300);
    return label && explanation ? [{ label, explanation }] : [];
  }).slice(0, 5);
  const base = typeof record.normalized_label_en === "string" ? stripRoleWords(record.normalized_label_en.trim()) : record.normalized_label_en;
  const label = typeof base === "string" && record.category === "medication" ? drugIngredientName(base) : base;
  return { ...record, normalized_label_en: label, synonyms, code_hints: codeHints, ambiguities };
};

export class OpenAiCompatibleClinicalTermExpander implements ClinicalTermExpander {
  private readonly validate: ValidateFunction<ClinicalTermExpansion>;
  constructor(private readonly options: { base_url: string; api_key?: string; model: string; system_prompt: string; timeout_ms: number; max_output_tokens: number; fetch?: typeof fetch; temperature?: number; max_repairs?: number }) {
    this.validate = new Ajv2020({ strict: true, allErrors: true }).compile<ClinicalTermExpansion>(schema);
  }

  async expand(input: { term: string; role: string }): Promise<ClinicalTermExpansion> {
    const request = async (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, responseFormat: Record<string, unknown>): Promise<Response> => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.options.timeout_ms);
      try {
        return await (this.options.fetch ?? nodeHttp1Fetch)(`${this.options.base_url.replace(/\/$/u, "")}/chat/completions`, {
          method: "POST", signal: controller.signal,
          headers: { ...(this.options.api_key ? { authorization: `Bearer ${this.options.api_key}` } : {}), "content-type": "application/json" },
          body: JSON.stringify({
            model: this.options.model, ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}), max_tokens: Math.min(this.options.max_output_tokens, 500), response_format: responseFormat,
            messages,
          }),
        });
      } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "Clinical term normalization request failed before a response was received."); }
      finally { clearTimeout(timer); }
    };
    const complete = async (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<string> => {
      let response = await request(messages, { type: "json_schema", json_schema: { name: "clinical_term_expansion", strict: true, schema } });
      if ([400, 404, 415, 422].includes(response.status)) response = await request(messages, { type: "json_object" });
      if (!response.ok) throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", `Clinical term normalization was rejected with HTTP ${response.status}.`);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "Clinical term normalization returned invalid JSON."); }
      const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "Clinical term normalization returned no result.");
      return content;
    };

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: this.options.system_prompt },
      { role: "user", content: JSON.stringify({ ...input, output_schema: schema }) },
    ];
    const maxRepairs = this.options.max_repairs ?? 1;
    for (let attempt = 0; ; attempt += 1) {
      const content = await complete(messages);
      const parsed = parseModelJsonObject(content);
      const problems: string[] = [];
      let result: unknown;
      if (parsed === undefined) problems.push("The reply was not one JSON object.");
      else {
        result = sanitizeTermExpansion(parsed);
        if (!this.validate(result)) problems.push(...(this.validate.errors ?? []).slice(0, 8).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`));
      }
      if (!problems.length) return result as ClinicalTermExpansion;
      if (attempt >= maxRepairs) {
        throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", parsed === undefined ? "Clinical term normalization returned malformed content." : "Clinical term normalization failed its output contract.");
      }
      messages.push({ role: "assistant", content }, { role: "user", content: `Your JSON broke these rules:\n- ${problems.join("\n- ")}\nReturn the corrected JSON object only.` });
    }
  }
}
