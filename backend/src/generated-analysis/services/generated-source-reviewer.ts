import { createHash } from "node:crypto";
import type {
  GeneratedAnalysisPlan,
  GeneratedExecutionPolicy,
  GeneratedSourceReview,
} from "../domain/generated-analysis.js";

const blockedPatterns: Array<{ code: string; pattern: RegExp; message: string }> = [
  { code: "NETWORK_ACCESS", pattern: /https?:|socket|requests\b|urllib|curl\b|download\.file|url\s*\(/iu, message: "Network access is not allowed." },
  { code: "PROCESS_ACCESS", pattern: /subprocess|child_process|popen|system\s*\(|shell\s*=|fork\s*\(|spawn\s*\(/iu, message: "Shell and child-process access are not allowed." },
  { code: "DYNAMIC_EVALUATION", pattern: /\beval\s*\(|\bexec\s*\(|__import__|compile\s*\(|parse\s*\(\s*text|source\s*\(/iu, message: "Dynamic evaluation is not allowed." },
  { code: "PACKAGE_INSTALL", pattern: /install\.packages|pip\s+install|conda\s+install|renv::install|pak::/iu, message: "Package installation is not allowed." },
  { code: "ENVIRONMENT_ACCESS", pattern: /os\.environ|os\.getenv|Sys\.getenv|process\.env/iu, message: "Environment access is not allowed." },
  { code: "NATIVE_CODE", pattern: /ctypes|cffi|dyn\.load|library\.dynam|\.Call\s*\(|\.C\s*\(/u, message: "Native-code loading is not allowed." },
  { code: "ABSOLUTE_PATH", pattern: /["']\/(?!\/)[^"']+["']/u, message: "Absolute paths are not allowed in generated source." },
];

const pythonImports = (source: string): string[] => [...source.matchAll(/^\s*(?:from|import)\s+([A-Za-z0-9_.]+)/gmu)]
  .map((match) => match[1]!.split(".")[0]!);

const rImports = (source: string): string[] => [...source.matchAll(/(?:library|require)\s*\(\s*["']?([A-Za-z0-9.]+)["']?/gmu)]
  .map((match) => match[1]!);

const unique = <T>(values: T[]): T[] => [...new Set(values)];

export class GeneratedSourceReviewer {
  review(plan: GeneratedAnalysisPlan, policy: GeneratedExecutionPolicy): GeneratedSourceReview {
    const digest = createHash("sha256").update(plan.source_code).digest("hex");
    const violations: GeneratedSourceReview["violations"] = [];
    if (!policy.enabled) violations.push({ code: "EXECUTION_DISABLED", message: "Generated execution is disabled." });
    if (Buffer.byteLength(plan.source_code, "utf8") > policy.max_source_bytes) {
      violations.push({ code: "SOURCE_TOO_LARGE", message: "Generated source exceeds the configured size limit." });
    }
    for (const blocked of blockedPatterns) {
      if (blocked.pattern.test(plan.source_code)) violations.push({ code: blocked.code, message: blocked.message });
    }
    const declared = unique(plan.packages.map((value) => value.trim()).filter(Boolean));
    const imported = unique(plan.language === "python" ? pythonImports(plan.source_code) : rImports(plan.source_code));
    const allowed = new Set((plan.language === "python" ? policy.allowed_python_packages : policy.allowed_r_packages)
      .map((value) => value.toLowerCase()));
    for (const packageName of unique([...declared, ...imported])) {
      if (!allowed.has(packageName.toLowerCase())) {
        violations.push({ code: "PACKAGE_NOT_ALLOWED", message: `Package is not allowlisted: ${packageName}` });
      }
    }
    if (!plan.required_result_keys.length) {
      violations.push({ code: "OUTPUT_CONTRACT_MISSING", message: "At least one aggregate result key is required." });
    }
    return { status: violations.length ? "rejected" : "approved", violations, source_sha256: `sha256:${digest}` };
  }
}

