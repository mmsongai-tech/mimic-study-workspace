import { nameKey } from "./definition-checks.js";
import type { VariableDefinition } from "./variable-definition.js";

export interface CatalogFormula { label_en: string; expression: string; parts: Array<{ name: string; label_en: string }>; unit?: string }

/**
 * The ratio and formula definitions as the study framing needs them: a name in a question ("estimated plasma volume status")
 * finds the expression and the labelled parts. The first part is read as the exposure, the others as helper variables.
 */
export class FormulaCatalog {
  private readonly byName = new Map<string, CatalogFormula>();
  /** Names as space-separated lower-case words, for whole-word containment. */
  private readonly names = new Map<string, CatalogFormula>();

  constructor(definitions: ReadonlyArray<VariableDefinition>, labelOf: (variableId: string) => string | undefined) {
    for (const definition of definitions) {
      const variables = definition.kind === "ratio" && definition.ratio ? { numerator: definition.ratio.numerator, denominator: definition.ratio.denominator }
        : definition.kind === "formula" && definition.formula ? definition.formula.variables : undefined;
      if (!variables) continue;
      const expression = definition.kind === "ratio" ? "numerator / denominator" : definition.formula!.expression;
      const parts = Object.entries(variables).map(([name, id]) => ({ name, label_en: labelOf(id) ?? id }));
      const entry: CatalogFormula = { label_en: definition.labels.en, expression, parts, ...(definition.formula?.unit ? { unit: definition.formula.unit } : {}) };
      for (const name of [definition.labels.en, definition.labels.zh, ...definition.synonyms]) if (name) { this.byName.set(nameKey(name), entry); this.names.set(name.normalize("NFKC").toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" "), entry); }
    }
  }

  /** A defined name equal to the text, or, failing that, the longest defined name (three words or more) that the text contains as whole words. */
  find(text: string): CatalogFormula | undefined {
    const exact = this.byName.get(nameKey(text)); if (exact) return exact;
    const have = ` ${text.normalize("NFKC").toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ")} `;
    let best: { length: number; entry: CatalogFormula } | undefined;
    for (const [name, entry] of this.names) if (name.split(" ").length >= 3 && have.includes(` ${name} `) && (!best || name.length > best.length)) best = { length: name.length, entry };
    return best?.entry;
  }
}
