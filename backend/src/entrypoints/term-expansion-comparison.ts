import { OpenAiCompatibleClinicalTermExpander } from "../variable-mapping/index.js";
import { createRepositoryProductPromptRegistry } from "../runtime/index.js";

// Compares local models on clinical term expansion for key items from the formal acceptance questions.
// Usage: node --import tsx backend/src/entrypoints/term-expansion-comparison.ts <model> [<model>...]
const terms: Array<[term: string, role: string]> = [
  ["高血压人群", "population"], ["全因死亡结局", "outcome"], ["住院期间全因死亡", "outcome"], ["降压疗效", "outcome"],
  ["美托洛尔", "exposure"], ["阿替洛尔", "exposure"], ["阿片类药物", "exposure"], ["镇痛疗效", "outcome"],
  ["ACEI", "exposure"], ["β受体阻滞剂", "exposure"], ["心肌梗死", "outcome"], ["中风", "outcome"],
  ["心血管死亡", "outcome"], ["性别", "covariate"],
];

const main = async (): Promise<void> => {
  const models = process.argv.slice(2);
  if (!models.length) throw new Error("Pass one or more model names.");
  const baseUrl = process.env.MIMIC_LOCAL_MODEL_BASE_URL || "http://127.0.0.1:11434/v1";
  const prompt = (await createRepositoryProductPromptRegistry().load({ id: "variable-mapping", version: "0.3.0" })).body;
  for (const model of models) {
    const expander = new OpenAiCompatibleClinicalTermExpander({ base_url: baseUrl, model, system_prompt: prompt, timeout_ms: 180_000, max_output_tokens: 500 });
    let valid = 0;
    const started = Date.now();
    for (const [term, role] of terms) {
      try {
        const expansion = await expander.expand({ term, role });
        valid += 1;
        process.stdout.write(`${model}\t${term}\t${expansion.normalized_label_en}\t${expansion.category}\t${(expansion.code_hints ?? []).join(",")}\n`);
      } catch (error) {
        process.stdout.write(`${model}\t${term}\tFAIL\t${error instanceof Error ? error.message : "unknown"}\n`);
      }
    }
    process.stdout.write(`## ${model}: ${valid}/${terms.length} schema-valid, ${Math.round((Date.now() - started) / 1000)} s\n`);
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Term expansion comparison failed."}\n`);
  process.exitCode = 1;
});
