import { readFile } from "node:fs/promises";
import type { VariableMappingRecord } from "./variable-mapping.js";
import { VariableMappingError } from "./variable-mapping.js";

export interface VariableMappingPack {
  schema_version: "1.0.0";
  pack_id: string;
  pack_version: string;
  license: string;
  provenance: string;
  mappings: Array<Omit<VariableMappingRecord, "provenance" | "evidence" | "created_at" | "updated_at">>;
}

export class FileVariableMappingPackRepository {
  constructor(private readonly source: URL) {}

  async load(): Promise<VariableMappingPack> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.source, "utf8")); }
    catch { throw new VariableMappingError("MAPPING_STORAGE_FAILURE", "The versioned variable mapping pack could not be loaded."); }
    const pack = parsed as Partial<VariableMappingPack>;
    if (pack.schema_version !== "1.0.0" || !pack.pack_id || !pack.pack_version || !Array.isArray(pack.mappings)) {
      throw new VariableMappingError("MAPPING_INVALID", "The versioned variable mapping pack is invalid.");
    }
    return structuredClone(pack as VariableMappingPack);
  }
}
