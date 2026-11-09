import type { ClinicalDatabaseMetadata, ClinicalDatabasePreflightReport } from "./database-preflight.js";

export interface ClinicalDatabaseMetadataClient {
  inspect(): Promise<ClinicalDatabaseMetadata>;
}

const requiredSchemas = ["mimiciv_hosp", "mimiciv_icu"];

export class ClinicalDatabasePreflightService {
  constructor(private readonly client: ClinicalDatabaseMetadataClient) {}

  async inspect(): Promise<ClinicalDatabasePreflightReport> {
    const metadata = await this.client.inspect();
    const missingRequiredSchemas = requiredSchemas.filter((schema) => !metadata.available_schemas.includes(schema));
    const blockingReasons = [
      ...(!metadata.transaction_read_only ? ["The inspection transaction was not read-only."] : []),
      ...(metadata.writable_mimic_table_privilege_count > 0 ? ["The configured role has write privileges on MIMIC tables."] : []),
      ...(metadata.can_create_in_database ? ["The configured role can create objects in the database."] : []),
      ...(metadata.can_create_in_mimic_schemas ? ["The configured role can create objects in a MIMIC schema."] : []),
      ...missingRequiredSchemas.map((schema) => `Required schema ${schema} is missing.`),
    ];
    return {
      schema_version: "1.0.0",
      data_model: "MIMIC-IV",
      ...metadata,
      missing_required_schemas: missingRequiredSchemas,
      status: blockingReasons.length ? "blocked" : "ready",
      blocking_reasons: blockingReasons,
    };
  }
}
