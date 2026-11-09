import { createSqliteDesignSessionRepository } from "../research-design/index.js";
import type { BackendRuntimeConfig } from "../runtime/index.js";
import { createLocalArchiveRunRuntime } from "./local-archive-run-runtime.js";

interface WorkerInput { config: BackendRuntimeConfig; archivePath: string; sessionId: string }

const send = (message: unknown): void => { if (process.send) process.send(message); };

process.once("message", async (input: WorkerInput) => {
  let runtime: Awaited<ReturnType<typeof createLocalArchiveRunRuntime>> | undefined;
  let designs: ReturnType<typeof createSqliteDesignSessionRepository> | undefined;
  try {
    send({ type: "phase", phase: "initializing" });
    runtime = await createLocalArchiveRunRuntime({ config: input.config, archivePath: input.archivePath });
    designs = createSqliteDesignSessionRepository(input.config.storage.database_path);
    const session = await designs.findById(input.sessionId);
    if (!session?.confirmation) throw Object.assign(new Error("The confirmed study is unavailable to the local run worker."), { code: "LOCAL_RUN_DESIGN_UNAVAILABLE", retryable: false });
    send({ type: "phase", phase: "mapping_and_execution" });
    const bundle = await runtime.localRuns.execute(session.confirmation.result);
    send({ type: "phase", phase: "finalizing" });
    const resultId = "report_id" in bundle.artifact ? bundle.artifact.report_id : bundle.artifact.run_id;
    send({ type: "completed", result_id: resultId });
  } catch (error) {
    const candidate = error as { code?: string; message?: string; retryable?: boolean };
    send({ type: "failed", code: candidate.code ?? "LOCAL_RUN_FAILED", message: candidate.message ?? "The local research run did not complete.", retryable: candidate.retryable !== false });
  } finally {
    designs?.close();
    runtime?.close();
    process.disconnect();
  }
});
