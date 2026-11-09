import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isClinicalDatabaseRelation, type ClinicalDatabaseCatalogSnapshot, type ClinicalDatabaseCatalogSnapshotRepository } from "./database-catalog.js";
import { ClinicalDatabaseError } from "./database-preflight.js";

const isSnapshot = (value: unknown): value is ClinicalDatabaseCatalogSnapshot => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const catalog = snapshot.catalog as Record<string, unknown> | undefined;
  return snapshot.schema_version === "1.0.0"
    && typeof snapshot.integrity_id === "string"
    && /^sha256:[a-f0-9]{64}$/u.test(snapshot.integrity_id)
    && Boolean(catalog)
    && catalog?.schema_version === "1.0.0"
    && catalog.data_model === "MIMIC-IV"
    && typeof catalog.source_service === "string"
    && Array.isArray(catalog.relations)
    && catalog.relations.every(isClinicalDatabaseRelation)
    && typeof catalog.relation_count === "number"
    && typeof catalog.column_count === "number"
    && typeof catalog.inspected_at === "string";
};

export class FileClinicalDatabaseCatalogSnapshotRepository implements ClinicalDatabaseCatalogSnapshotRepository {
  constructor(private readonly filename: string) {}

  async load(): Promise<ClinicalDatabaseCatalogSnapshot> {
    let text: string;
    try {
      text = await readFile(this.filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ClinicalDatabaseError("DATABASE_SNAPSHOT_NOT_FOUND", "The local MIMIC-IV catalog snapshot does not exist. Refresh it explicitly before offline use.");
      }
      throw new ClinicalDatabaseError("DATABASE_SNAPSHOT_INVALID", "The local MIMIC-IV catalog snapshot could not be read.");
    }
    try {
      const value: unknown = JSON.parse(text);
      if (!isSnapshot(value)) throw new Error("invalid snapshot");
      return value;
    } catch {
      throw new ClinicalDatabaseError("DATABASE_SNAPSHOT_INVALID", "The local MIMIC-IV catalog snapshot did not match its contract.");
    }
  }

  async save(snapshot: ClinicalDatabaseCatalogSnapshot): Promise<void> {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filename), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filename);
    } catch {
      throw new ClinicalDatabaseError("DATABASE_SNAPSHOT_WRITE_FAILED", "The local MIMIC-IV catalog snapshot could not be saved.");
    }
  }
}
