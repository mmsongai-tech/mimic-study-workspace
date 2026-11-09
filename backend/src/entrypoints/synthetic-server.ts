import { pathToFileURL } from "node:url";
import { resolveBackendRuntimeConfig } from "../runtime/index.js";
import { createSyntheticResearchDesignModel } from "../synthetic/synthetic-research-design-model.js";
import { startWorkspaceApplication } from "./workspace-application.js";

const cliValue = (arguments_: string[], name: string): string | undefined => {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
};

export const startSyntheticServer = async (arguments_: string[] = []) => {
  const hostValue = cliValue(arguments_, "--host");
  const portValue = cliValue(arguments_, "--port");
  const databaseValue = cliValue(arguments_, "--database");
  const pythonValue = cliValue(arguments_, "--python") ?? cliValue(arguments_, "--python-binary");
  const config = resolveBackendRuntimeConfig({
    cli: {
      server: { ...(hostValue ? { host: hostValue } : {}), ...(portValue ? { port: Number(portValue) } : {}) },
      storage: { ...(databaseValue ? { database_path: databaseValue } : {}) },
      report_exports: { ...(pythonValue ? { python_binary: pythonValue } : {}) },
      research_design: { model: { profile: "synthetic" } },
    },
  });
  return startWorkspaceApplication({
    config,
    modelFactory(settings) {
      if (settings.profile !== "synthetic") throw new Error("The synthetic entry point requires the synthetic model profile.");
      return createSyntheticResearchDesignModel();
    },
  });
};

const main = async (): Promise<void> => {
  const runtime = await startSyntheticServer(process.argv.slice(2));
  process.stdout.write(`Synthetic backend listening at ${runtime.origin}\n`);
  const shutdown = async (): Promise<void> => { await runtime.close(); process.exitCode = 0; };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Synthetic backend failed to start."}\n`); process.exitCode = 1; });
}

