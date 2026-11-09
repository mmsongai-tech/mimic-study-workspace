import type { VariableMappingRecord } from "./variable-mapping.js";
import type { VariableMappingRepository } from "./variable-mapping-repository.js";
import type { VariableMappingPack } from "./file-variable-mapping-pack-repository.js";

/**
 * The fields a pack file actually controls, compared to decide whether a stored seed row is still current.
 * `mapping_version` is meant to be bumped whenever these change, but nothing enforces that — a pack edit that
 * forgets to bump it must still not be silently ignored forever by a store that already has the old row.
 */
const seedContent = (mapping: Pick<VariableMappingRecord, "labels" | "synonyms" | "category" | "value_type" | "definition" | "sources" | "status">): string =>
  JSON.stringify({ status: mapping.status, labels: mapping.labels, synonyms: mapping.synonyms, category: mapping.category, value_type: mapping.value_type, definition: mapping.definition, sources: mapping.sources });

export class VariableMappingPackService {
  constructor(private readonly dependencies: { pack: { load(): Promise<VariableMappingPack> }; mappings: VariableMappingRepository; now?: () => string }) {}

  /** Entries the store refused in the last seed (same version, different content): raise the version of the entry. */
  rejected: string[] = [];

  async seed(): Promise<number> {
    this.rejected = [];
    const pack = await this.dependencies.pack.load();
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    let written = 0;
    for (const mapping of pack.mappings) {
      const existing = await this.dependencies.mappings.findById(mapping.mapping_id);
      const unchanged = existing?.provenance === "versioned_seed" && existing.mapping_version === mapping.mapping_version && seedContent(existing) === seedContent(mapping);
      if (existing && (existing.provenance !== "versioned_seed" || unchanged)) continue;
      if (await this.dependencies.mappings.save({ ...mapping, provenance: "versioned_seed", evidence: {}, created_at: now, updated_at: now })) written += 1; else this.rejected.push(mapping.mapping_id);
    }
    return written;
  }
}
