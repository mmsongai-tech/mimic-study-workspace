import { createHash } from "node:crypto";
import type { ClinicalDatabaseCatalog, ClinicalDatabaseCatalogSnapshot, ClinicalDatabaseCatalogSnapshotRepository } from "./database-catalog.js";
import { ClinicalDatabaseError } from "./database-preflight.js";

const createIntegrityId = (catalog: ClinicalDatabaseCatalog): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(catalog)).digest("hex")}`;

export class ClinicalDatabaseCatalogSnapshotService {
  constructor(private readonly repository: ClinicalDatabaseCatalogSnapshotRepository) {}

  async store(catalog: ClinicalDatabaseCatalog): Promise<ClinicalDatabaseCatalogSnapshot> {
    const snapshot: ClinicalDatabaseCatalogSnapshot = {
      schema_version: "1.0.0",
      catalog,
      integrity_id: createIntegrityId(catalog),
    };
    await this.repository.save(snapshot);
    return snapshot;
  }

  async load(): Promise<ClinicalDatabaseCatalogSnapshot> {
    const snapshot = await this.repository.load();
    if (snapshot.integrity_id !== createIntegrityId(snapshot.catalog)) {
      throw new ClinicalDatabaseError("DATABASE_SNAPSHOT_INVALID", "The local MIMIC-IV catalog snapshot failed its integrity check.");
    }
    if (snapshot.catalog.relation_count !== snapshot.catalog.relations.length) {
      throw new ClinicalDatabaseError("DATABASE_SNAPSHOT_INVALID", "The local MIMIC-IV catalog snapshot has inconsistent relation counts.");
    }
    const columnCount = snapshot.catalog.relations.reduce((total, relation) => total + relation.columns.length, 0);
    if (snapshot.catalog.column_count !== columnCount) {
      throw new ClinicalDatabaseError("DATABASE_SNAPSHOT_INVALID", "The local MIMIC-IV catalog snapshot has inconsistent column counts.");
    }
    return snapshot;
  }
}
