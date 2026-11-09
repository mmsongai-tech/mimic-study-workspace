export type AuditCheckState = "pass" | "fail" | "not_run";

export interface SafeModelAuditRecord {
  stage: string;
  provider: string;
  model: string;
  prompt: { id: string; version: string; integrity_id: string };
  schema: { id: string; version: string; integrity_id: string };
  attempts?: Array<{
    provider: string;
    model: string;
    order: number;
    latency_ms: number;
    outcome: "failed" | "succeeded";
    failure_class?: string;
  }>;
  json_parse: AuditCheckState;
  schema_validation: AuditCheckState;
  business_validation: AuditCheckState;
  repair_attempts: number;
  latency_ms: number;
  failure_class?: string;
  output_integrity_id?: string;
  structured_output_mode?: "json_schema" | "json_object" | "prompt_contract";
  study_spec_integrity_id?: string;
  manifest_integrity_id?: string;
  method_integrity_id?: string;
  report_integrity_id?: string;
}

export interface ModelAuditReader { list(limit: number): Promise<unknown[]> | unknown[] }
export interface ModelAuditWriter { append(records: unknown[]): Promise<void> | void }

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const check = (value: unknown): AuditCheckState => value === "pass" || value === "fail" ? value : "not_run";
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const sanitizeAttempts = (value: unknown): SafeModelAuditRecord["attempts"] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const mapped = value.map((entry) => {
    const attempt = object(entry);
    return {
      provider: text(attempt.provider),
      model: text(attempt.model),
      order: num(attempt.order),
      latency_ms: num(attempt.latency_ms),
      outcome: attempt.outcome === "succeeded" ? "succeeded" : "failed",
      ...(typeof attempt.failure_class === "string" && attempt.failure_class.length > 0 ? { failure_class: text(attempt.failure_class) } : {}),
    };
  }).filter((attempt) => attempt.provider && attempt.model && attempt.order > 0);
  return mapped.length ? mapped as NonNullable<SafeModelAuditRecord["attempts"]> : undefined;
};

/** Projects an untrusted internal event onto the metadata-only public contract. */
export const toSafeModelAuditRecord = (value: unknown): SafeModelAuditRecord => {
  const source = object(value);
  const prompt = object(source.prompt);
  const schema = object(source.schema ?? source.output_schema);
  const result: SafeModelAuditRecord = {
    stage: text(source.stage),
    provider: text(source.provider),
    model: text(source.model),
    prompt: {
      id: text(prompt.id ?? source.prompt_id),
      version: text(prompt.version ?? source.prompt_version),
      integrity_id: text(prompt.integrity_id ?? prompt.sha256 ?? source.prompt_integrity_id),
    },
    schema: {
      id: text(schema.id ?? source.schema_id ?? source.output_schema_id),
      version: text(schema.version ?? source.schema_version ?? source.output_schema_version),
      integrity_id: text(schema.integrity_id ?? schema.sha256 ?? source.schema_integrity_id),
    },
    json_parse: check(source.json_parse),
    schema_validation: check(source.schema_validation),
    business_validation: check(source.business_validation),
    repair_attempts: num(source.repair_attempts),
    latency_ms: num(source.latency_ms),
  };

  for (const key of ["failure_class", "output_integrity_id", "study_spec_integrity_id", "manifest_integrity_id", "method_integrity_id", "report_integrity_id"] as const) {
    if (typeof source[key] === "string" && source[key].length > 0) result[key] = source[key];
  }

  const safeAttempts = sanitizeAttempts(source.attempts);
  if (safeAttempts !== undefined) result.attempts = safeAttempts;

  if (["json_schema", "json_object", "prompt_contract"].includes(String(source.structured_output_mode))) {
    result.structured_output_mode = source.structured_output_mode as NonNullable<SafeModelAuditRecord["structured_output_mode"]>;
  }

  return result;
};

export class ModelAuditQueryService {
  constructor(private readonly reader: ModelAuditReader) {}
  async list(limit = 50): Promise<{ schema_version: "1.0.0"; records: SafeModelAuditRecord[] }> {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    return { schema_version: "1.0.0", records: (await this.reader.list(bounded)).slice(0, bounded).map(toSafeModelAuditRecord) };
  }
}
