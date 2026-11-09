import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { resolveBackendRuntimeConfig } from "../runtime/runtime-config.js";
import { DictionaryIndex, VariableDefinitionService, VariableDefinitionStore } from "../variable-definitions/index.js";
import { archiveProblem, createQuestionWorkspaceServer, portInUseProblem, QuestionRunJobService, SubprocessQuestionRunLauncher, workspaceStartedMessage } from "../question-workspace/index.js";

// MIMIC Study Workspace (the question workspace web app). Usage:
//   MIMIC_LOCAL_ARCHIVE=/path/mimic-iv-3.1.zip node --import tsx backend/src/entrypoints/question-workspace-server.ts
// Listens on 127.0.0.1:9000 unless QUESTION_WORKSPACE_PORT / QUESTION_WORKSPACE_HOST are set.
// QUESTION_WORKSPACE_STATIC_ROOT serves another build of the page (for example frontend/question-workspace/dist-next) next to the default one.
//
// For a separate instance shared with outside testers (e.g. behind a tunnel), set:
//   QUESTION_WORKSPACE_INVITE_CODE — requires this code before the workspace is usable; each browser session then
//     only ever sees the runs it started itself, never another session's or the default instance's history.
//   QUESTION_WORKSPACE_RUNS_DIR — a separate, empty run-history directory for that instance, so it never exposes
//     runs from the default (unguarded) instance's .local/question-workspace/runs.

const main = async (): Promise<void> => {
  // There is no synthetic fallback: an unset, missing or unzipped archive stops here with the fix, in both languages.
  const problem = await archiveProblem(process.env.MIMIC_LOCAL_ARCHIVE);
  if (problem) throw new Error(`${problem.zh}\n${problem.en}`);
  const cwd = process.cwd();
  const runsDir = process.env.QUESTION_WORKSPACE_RUNS_DIR ?? join(cwd, ".local", "question-workspace", "runs");
  const cliRunsDir = process.env.QUESTION_WORKSPACE_RUNS_DIR ? join(process.env.QUESTION_WORKSPACE_RUNS_DIR, "cli") : join(cwd, ".local", "question-runs");
  const jobs = new QuestionRunJobService({
    root: runsDir,
    command_line_root: cliRunsDir,
    launcher: new SubprocessQuestionRunLauncher({ entrypoint: fileURLToPath(new URL("./question-report-run.ts", import.meta.url)), environment: process.env, cwd }),
  });
  await jobs.recover();
  const port = Number(process.env.QUESTION_WORKSPACE_PORT ?? "9000");
  const host = process.env.QUESTION_WORKSPACE_HOST ?? "127.0.0.1";
  const inviteCode = process.env.QUESTION_WORKSPACE_INVITE_CODE;
  // Variable definitions need the dictionary index (scripts/build-dictionary-index.py); without it the routes answer 503.
  const config = resolveBackendRuntimeConfig();
  const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
  const variables = await exists(config.variable_definitions.dictionary_index_path)
    ? new VariableDefinitionService({
      index: await DictionaryIndex.load(config.variable_definitions.dictionary_index_path),
      shared: new VariableDefinitionStore(config.variable_definitions.shared_directory), workspace: new VariableDefinitionStore(config.variable_definitions.workspace_directory),
      packFile: new URL("../../../config/mappings/mimic-iv-core.json", import.meta.url), drugClassFile: new URL("../../../config/drug-classes/drug-classes.json", import.meta.url),
    }) : undefined;
  const server = createQuestionWorkspaceServer({ jobs, ...(variables ? { variables } : {}), static_root: process.env.QUESTION_WORKSPACE_STATIC_ROOT ?? fileURLToPath(new URL("../../../frontend/question-workspace/dist", import.meta.url)), ...(inviteCode ? { invite_code: inviteCode } : {}) });
  // A port that is taken (usually a workspace already running) stops with the fix in both languages, not a Node stack.
  server.on("error", (error: NodeJS.ErrnoException) => {
    const problem = error.code === "EADDRINUSE" ? portInUseProblem(port) : undefined;
    process.stderr.write(problem ? `\n[停止] ${problem.zh}\n[Stopped] ${problem.en}\n\n` : `${error.message}\n`);
    process.exit(1);
  });
  // Once it listens: a short address line, then the started line in Chinese and in English, with the port it really listens on.
  server.listen(port, host, () => {
    const address = server.address();
    const listening = address !== null && typeof address === "object" ? address.port : port;
    const started = workspaceStartedMessage(listening);
    process.stdout.write(`MIMIC 研究工作台 / MIMIC Study Workspace: http://${host}:${listening}${inviteCode ? " (invite-code gate on)" : ""}\n${started.zh}\n${started.en}\n`);
  });
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "MIMIC 研究工作台没有启动成功。/ The MIMIC Study Workspace failed to start."}\n`);
  process.exitCode = 1;
});
