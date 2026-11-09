export interface ClinicalDatabasePreflightReport {
  schema_version: "1.0.0";
  data_model: "MIMIC-IV";
  database: string;
  database_user: string;
  server_version: string;
  transaction_read_only: boolean;
  available_schemas: string[];
  missing_required_schemas: string[];
  writable_mimic_table_privilege_count: number;
  can_create_in_database: boolean;
  can_create_in_mimic_schemas: boolean;
  status: "ready" | "blocked";
  blocking_reasons: string[];
}

export interface ClinicalDatabaseMetadata {
  database: string;
  database_user: string;
  server_version: string;
  transaction_read_only: boolean;
  available_schemas: string[];
  writable_mimic_table_privilege_count: number;
  can_create_in_database: boolean;
  can_create_in_mimic_schemas: boolean;
}

export class ClinicalDatabaseError extends Error {
  constructor(
    public readonly code: "DATABASE_CONFIG_INVALID" | "DATABASE_CLIENT_UNAVAILABLE" | "DATABASE_CONNECTION_FAILED" | "DATABASE_RESPONSE_INVALID" | "DATABASE_SNAPSHOT_NOT_FOUND" | "DATABASE_SNAPSHOT_INVALID" | "DATABASE_SNAPSHOT_WRITE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "ClinicalDatabaseError";
  }
}
