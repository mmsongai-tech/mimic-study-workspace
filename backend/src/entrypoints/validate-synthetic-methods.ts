import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { RSyntheticMethodValidationService, type SyntheticValidationScenario } from "../synthetic-method-validation/index.js";

const scenarios: SyntheticValidationScenario[] = ["continuous_association", "count_association", "time_to_event_association", "repeated_measure_association", "competing_risk_association"];

export const validateSyntheticMethods = async (outputDirectory: string): Promise<void> => {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const service = new RSyntheticMethodValidationService({
    rscript_binary: "/usr/local/bin/Rscript",
    script_path: fileURLToPath(new URL("../synthetic-method-validation/runtimes/r/synthetic_method_validation.R", import.meta.url)),
    timeout_ms: 20_000,
  });
  for (const scenario of scenarios) {
    const result = await service.execute(scenario);
    await Promise.all([
      writeFile(resolve(outputDirectory, `${scenario}.json`), JSON.stringify(result, null, 2), { mode: 0o600 }),
      writeFile(resolve(outputDirectory, `${scenario}.md`), result.report_markdown, { mode: 0o600 }),
      writeFile(resolve(outputDirectory, `${scenario}.svg`), result.publication_outputs.figures[0]?.content ?? "", { mode: 0o600 }),
    ]);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.argv[2] ?? "/tmp/mimic-synthetic-method-validation";
  validateSyntheticMethods(output)
    .then(() => process.stdout.write(`Synthetic method validation artifacts written to ${output}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Synthetic method validation failed."}\n`);
      process.exitCode = 1;
    });
}
