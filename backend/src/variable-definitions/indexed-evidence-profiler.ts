import type { MappingDataProfile, MappingEvidenceProfiler, VariableMappingRecord } from "../variable-mapping/index.js";
import type { DictionaryIndex } from "./dictionary-index.js";

/**
 * The evidence profile of a mapping read from the dictionary index (counts per item, drug label and code) instead of a scan of
 * the archive. The large tables (labevents, chartevents) are over the scan budget, so a verified laboratory item used to stay
 * "unmapped" for want of evidence even though the index already holds its counts. A mapping the index cannot answer is left to
 * the scanning profiler.
 */
export class IndexedEvidenceProfiler implements MappingEvidenceProfiler {
  constructor(private readonly index: DictionaryIndex, private readonly fallback?: MappingEvidenceProfiler, private readonly now: () => string = () => new Date().toISOString()) {}

  private fromIndex(mapping: VariableMappingRecord): MappingDataProfile | undefined {
    const source = mapping.sources[0]; if (!source) return undefined;
    let rows = 0; let found = 0; let wanted = 0; const units = new Map<string, number>();
    if (source.item_ids?.length) {
      for (const id of source.item_ids) { wanted += 1; const item = this.index.item(source.table, id); if (!item) continue; found += 1; rows += item.rows; for (const [unit, count] of item.units ?? []) units.set(unit, (units.get(unit) ?? 0) + count); }
    } else if (source.codes?.length) {
      const kind = source.table === "procedures_icd" ? "procedure" : "diagnosis";
      for (const { code, version } of source.codes) { wanted += 1; const entry = this.index.code(kind, code, version); if (!entry) continue; found += 1; rows += entry.rows; }
    } else if (source.value_filters?.length === 1 && source.value_filters[0]!.column === "drug") {
      for (const label of source.value_filters[0]!.values) { wanted += 1; const drug = this.index.drug(label); if (!drug) continue; found += 1; rows += drug.rows; }
    } else return undefined;
    if (!wanted || found !== wanted) return undefined;
    return {
      source_id: `${source.schema}.${source.table}`, matched_record_count: rows, missing_value_count: 0, distinct_value_count: found,
      units: [...units.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count })), top_values: [], profiled_at: this.now(),
    };
  }

  async profile(mapping: VariableMappingRecord): Promise<MappingDataProfile> {
    return (await this.profileMany([mapping])).get(mapping.mapping_id)!;
  }

  async profileMany(mappings: VariableMappingRecord[]): Promise<Map<string, MappingDataProfile>> {
    const result = new Map<string, MappingDataProfile>(); const rest: VariableMappingRecord[] = [];
    for (const mapping of mappings) { const profile = this.fromIndex(mapping); if (profile) result.set(mapping.mapping_id, profile); else rest.push(mapping); }
    if (rest.length) {
      if (!this.fallback) throw new Error("The dictionary index has no evidence for this mapping and no scan is configured.");
      const scanned = this.fallback.profileMany ? await this.fallback.profileMany(rest) : new Map(await Promise.all(rest.map(async (mapping) => [mapping.mapping_id, await this.fallback!.profile(mapping)] as const)));
      for (const [id, profile] of scanned) result.set(id, profile);
    }
    return result;
  }
}
