export type GeneratedAnalysisLanguage = "python" | "r";

export type GeneratedStudyFamily =
  | "association"
  | "prediction"
  | "treatment_effect";

export interface GeneratedAnalysisPlan {
  schema_version: "1.0.0";
  study_family: GeneratedStudyFamily;
  language: GeneratedAnalysisLanguage;
  method: string;
  method_rationale: string;
  required_conditions: string[];
  packages: string[];
  source_code: string;
  required_result_keys: string[];
}

export interface GeneratedExecutionPolicy {
  enabled: boolean;
  sandbox: "macos_sandbox";
  python_binary: string;
  rscript_binary: string;
  wall_timeout_ms: number;
  cpu_time_seconds: number;
  memory_limit_mb: number;
  max_source_bytes: number;
  max_input_bytes: number;
  max_output_bytes: number;
  allowed_python_packages: string[];
  allowed_r_packages: string[];
}

export interface GeneratedSourceReview {
  status: "approved" | "rejected";
  violations: Array<{ code: string; message: string }>;
  source_sha256: string;
}

export interface GeneratedAnalysisResult {
  status: "completed";
  language: GeneratedAnalysisLanguage;
  study_family: GeneratedStudyFamily;
  method: string;
  aggregate_result: Record<string, unknown>;
  source_sha256: string;
  duration_ms: number;
  sandbox: "macos_sandbox";
  warnings: string[];
}

export type GeneratedAnalysisErrorCode =
  | "GENERATED_PLAN_INVALID"
  | "GENERATED_SOURCE_REJECTED"
  | "GENERATED_RUNTIME_UNAVAILABLE"
  | "GENERATED_EXECUTION_FAILED"
  | "GENERATED_EXECUTION_TIMEOUT"
  | "GENERATED_OUTPUT_INVALID";

export class GeneratedAnalysisError extends Error {
  constructor(
    public readonly code: GeneratedAnalysisErrorCode,
    message: string,
    public readonly safe_details: string[] = [],
  ) {
    super(message);
    this.name = "GeneratedAnalysisError";
  }
}
