import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  GeneratedAnalysisPlan,
  GeneratedAnalysisResult,
  GeneratedExecutionPolicy,
} from "../domain/generated-analysis.js";
import { GeneratedAnalysisError } from "../domain/generated-analysis.js";
import { GeneratedSourceReviewer } from "./generated-source-reviewer.js";
import { GeneratedAnalysisMonitor } from "./generated-analysis-monitor.js";

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "The controlled analysis input is not serializable.");
  }
};

const sandboxLiteral = (path: string): string => JSON.stringify(path);

const pathAncestors = (path: string): string[] => {
  const ancestors: string[] = [];
  let current = dirname(path);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
};

const resolveRuntime = async (configuredRuntime: string, language: GeneratedAnalysisPlan["language"]): Promise<string> => {
  const resolved = await realpath(configuredRuntime);
  if (language !== "python" || process.platform !== "darwin") return resolved;
  const frameworkExecutable = join(
    dirname(dirname(resolved)),
    "Resources",
    "Python.app",
    "Contents",
    "MacOS",
    "Python",
  );
  try {
    return await realpath(frameworkExecutable);
  } catch {
    return resolved;
  }
};

const sandboxProfile = (directory: string, runtime: string): string => {
  const metadataPaths = [...new Set([...pathAncestors(directory), ...pathAncestors(runtime)])]
    .map((path) => `  (literal ${sandboxLiteral(path)})`)
    .join("\n");
  return `(version 1)
(deny default)
(import "system.sb")
(allow process-info*)
(allow process-exec (literal ${sandboxLiteral(runtime)}))
(allow file-read-metadata
${metadataPaths})
(allow file-read*
  (subpath "/System")
  (subpath "/Library")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/usr/local")
  (subpath "/opt/homebrew")
  (subpath "/private/var/db/timezone"))
(allow file-read* (literal ${sandboxLiteral(runtime)}))
(allow file-read* (subpath ${sandboxLiteral(directory)}))
(allow file-write* (subpath ${sandboxLiteral(directory)}))
(deny network*)
(deny process-fork)
`;
};

const run = async (input: {
  workingDirectory: string;
  runtime: string;
  sourcePath: string;
  inputPath: string;
  outputPath: string;
  profilePath: string;
  policy: GeneratedExecutionPolicy;
}): Promise<{ durationMs: number }> => {
  const started = Date.now();
  const supervisor = new URL("../runtimes/resource_supervisor.py", import.meta.url);
  const arguments_ = [
    supervisor.pathname,
    String(input.policy.cpu_time_seconds),
    String(input.policy.memory_limit_mb),
    String(input.policy.max_output_bytes),
    "/usr/bin/sandbox-exec",
    "-f",
    input.profilePath,
    input.runtime,
    input.sourcePath,
    input.inputPath,
    input.outputPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.policy.python_binary, arguments_, {
      cwd: input.workingDirectory,
      stdio: ["ignore", "ignore", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin" },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.policy.wall_timeout_ms);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new GeneratedAnalysisError("GENERATED_RUNTIME_UNAVAILABLE", "The isolated analysis runtime could not start."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new GeneratedAnalysisError("GENERATED_EXECUTION_TIMEOUT", "The generated analysis exceeded its time limit."));
      } else if (code !== 0) {
        reject(new GeneratedAnalysisError("GENERATED_EXECUTION_FAILED", "The isolated generated analysis failed."));
      } else resolve();
    });
  });
  return { durationMs: Date.now() - started };
};

export class GeneratedAnalysisService {
  constructor(
    private readonly policy: GeneratedExecutionPolicy,
    private readonly reviewer = new GeneratedSourceReviewer(),
    private readonly monitor = new GeneratedAnalysisMonitor(),
  ) {}

  async execute(plan: GeneratedAnalysisPlan, controlledInput: unknown): Promise<GeneratedAnalysisResult> {
    this.monitor.recordAttempt();
    try {
      const result = await this.executeInternal(plan, controlledInput);
      this.monitor.recordCompleted();
      return result;
    } catch (error) {
      if (error instanceof GeneratedAnalysisError) this.monitor.recordFailure(error.code);
      throw error;
    }
  }

  metrics() {
    return this.monitor.snapshot();
  }

  private async executeInternal(plan: GeneratedAnalysisPlan, controlledInput: unknown): Promise<GeneratedAnalysisResult> {
    if (plan.schema_version !== "1.0.0" || !plan.method.trim() || !plan.source_code.trim()) {
      throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "The generated analysis plan is incomplete.");
    }
    const review = this.reviewer.review(plan, this.policy);
    if (review.status === "rejected") {
      throw new GeneratedAnalysisError(
        "GENERATED_SOURCE_REJECTED",
        "The generated source did not pass the execution policy.",
        review.violations.map(({ code }) => code),
      );
    }
    const inputJson = safeJson(controlledInput);
    if (Buffer.byteLength(inputJson, "utf8") > this.policy.max_input_bytes) {
      throw new GeneratedAnalysisError("GENERATED_PLAN_INVALID", "The controlled analysis input exceeds the configured size limit.");
    }
    const createdDirectory = await mkdtemp(join(tmpdir(), "mimic-generated-analysis-"));
    const directory = await realpath(createdDirectory);
    const extension = plan.language === "python" ? "py" : "R";
    const sourcePath = join(directory, `analysis.${extension}`);
    const inputPath = join(directory, "input.json");
    const outputPath = join(directory, "output.json");
    const profilePath = join(directory, "sandbox.sb");
    const configuredRuntime = plan.language === "python" ? this.policy.python_binary : this.policy.rscript_binary;
    try {
      let runtime: string;
      try {
        runtime = await resolveRuntime(configuredRuntime, plan.language);
      } catch {
        throw new GeneratedAnalysisError("GENERATED_RUNTIME_UNAVAILABLE", "The isolated analysis runtime is unavailable.");
      }
      await Promise.all([
        writeFile(sourcePath, plan.source_code, { encoding: "utf8", mode: 0o400 }),
        writeFile(inputPath, inputJson, { encoding: "utf8", mode: 0o400 }),
        writeFile(profilePath, sandboxProfile(directory, runtime), { encoding: "utf8", mode: 0o400 }),
      ]);
      const { durationMs } = await run({
        workingDirectory: directory,
        runtime,
        sourcePath,
        inputPath,
        outputPath,
        profilePath,
        policy: this.policy,
      });
      let raw: string;
      try {
        raw = await readFile(outputPath, "utf8");
      } catch {
        throw new GeneratedAnalysisError("GENERATED_OUTPUT_INVALID", "The generated analysis did not create its required output.");
      }
      if (Buffer.byteLength(raw, "utf8") > this.policy.max_output_bytes) {
        throw new GeneratedAnalysisError("GENERATED_OUTPUT_INVALID", "The generated analysis output exceeds the configured size limit.");
      }
      let aggregateResult: unknown;
      try {
        aggregateResult = JSON.parse(raw);
      } catch {
        throw new GeneratedAnalysisError("GENERATED_OUTPUT_INVALID", "The generated analysis output is not valid JSON.");
      }
      if (!aggregateResult || typeof aggregateResult !== "object" || Array.isArray(aggregateResult)) {
        throw new GeneratedAnalysisError("GENERATED_OUTPUT_INVALID", "The generated analysis output must be an aggregate object.");
      }
      const missing = plan.required_result_keys.filter((key) => !(key in aggregateResult));
      if (missing.length) {
        throw new GeneratedAnalysisError("GENERATED_OUTPUT_INVALID", "The generated analysis output is missing required aggregate fields.", missing);
      }
      return {
        status: "completed",
        language: plan.language,
        study_family: plan.study_family,
        method: plan.method,
        aggregate_result: aggregateResult as Record<string, unknown>,
        source_sha256: review.source_sha256,
        duration_ms: durationMs,
        sandbox: "macos_sandbox",
        warnings: ["Generated execution is experimental and does not establish clinical validity."],
      };
    } finally {
      await rm(createdDirectory, { recursive: true, force: true });
    }
  }
}
