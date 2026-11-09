import type { GeneratedAnalysisErrorCode } from "../domain/generated-analysis.js";

export interface GeneratedAnalysisMetrics {
  attempts: number;
  completed: number;
  source_rejected: number;
  runtime_failed: number;
  timed_out: number;
  output_invalid: number;
  completion_rate: number;
}

export class GeneratedAnalysisMonitor {
  private attempts = 0;
  private completed = 0;
  private sourceRejected = 0;
  private runtimeFailed = 0;
  private timedOut = 0;
  private outputInvalid = 0;

  recordAttempt(): void { this.attempts += 1; }
  recordCompleted(): void { this.completed += 1; }
  recordFailure(code: GeneratedAnalysisErrorCode): void {
    if (code === "GENERATED_SOURCE_REJECTED") this.sourceRejected += 1;
    else if (code === "GENERATED_EXECUTION_TIMEOUT") this.timedOut += 1;
    else if (code === "GENERATED_OUTPUT_INVALID") this.outputInvalid += 1;
    else this.runtimeFailed += 1;
  }

  snapshot(): GeneratedAnalysisMetrics {
    return {
      attempts: this.attempts,
      completed: this.completed,
      source_rejected: this.sourceRejected,
      runtime_failed: this.runtimeFailed,
      timed_out: this.timedOut,
      output_invalid: this.outputInvalid,
      completion_rate: this.attempts ? this.completed / this.attempts : 0,
    };
  }
}

