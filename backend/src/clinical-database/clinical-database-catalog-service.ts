import type { ClinicalDatabaseCatalog, ClinicalDatabaseCatalogSource } from "./database-catalog.js";

export class ClinicalDatabaseCatalogService {
  constructor(
    private readonly source: ClinicalDatabaseCatalogSource,
    private readonly settings: { service: string; now?: () => Date },
  ) {}

  async inspect(): Promise<ClinicalDatabaseCatalog> {
    const relations = await this.source.inspect();
    return {
      schema_version: "1.0.0",
      data_model: "MIMIC-IV",
      source_service: this.settings.service,
      relations,
      relation_count: relations.length,
      column_count: relations.reduce((total, relation) => total + relation.columns.length, 0),
      inspected_at: (this.settings.now ?? (() => new Date()))().toISOString(),
    };
  }
}
