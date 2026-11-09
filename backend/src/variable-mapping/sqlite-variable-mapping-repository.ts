import { DatabaseSync } from "node:sqlite";
import type { VariableMappingRecord, VariableMappingStatus } from "./variable-mapping.js";
import type { VariableMappingRepository } from "./variable-mapping-repository.js";
import { normalizeClinicalConcept } from "./concept-normalization.js";

interface JsonRow { json: string }
const normalize = (value: string): string => normalizeClinicalConcept(value).normalized;
const immutableDefinition = ({ status: _status, provenance: _provenance, evidence: _evidence, created_at: _created, updated_at: _updated, ...definition }: VariableMappingRecord) => definition;
const lifecycleRank: Record<VariableMappingStatus, number> = {
  discovered: 0,
  database_verified: 1,
  model_reviewed: 2,
  clinician_confirmed: 3,
  validated: 4,
  deprecated: 5,
};

export class SqliteVariableMappingRepository implements VariableMappingRepository {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS variable_mapping (
        mapping_id TEXT PRIMARY KEY,
        concept_id TEXT NOT NULL,
        status TEXT NOT NULL,
        searchable_text TEXT NOT NULL,
        json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS variable_mapping_concept_idx ON variable_mapping(concept_id);
      CREATE INDEX IF NOT EXISTS variable_mapping_status_idx ON variable_mapping(status);
    `);
  }

  close(): void { this.database.close(); }

  /**
   * Mappings found by a live search (not from a pack, not reviewed by a clinician) are only as good as the rules that found them.
   * When the rules change (`version` differs from the one stored), they are dropped and found again under the new rules.
   * Returns the number of mappings dropped.
   */
  /**
   * Removes the stored mappings of variable definitions that no longer exist (a definition deleted from its folder), so a deleted
   * variable stops resolving. Returns the number removed.
   */
  dropVariableDefinitionsExcept(keepIds: readonly string[]): number {
    const keep = new Set(keepIds);
    const stored = this.database.prepare("SELECT mapping_id FROM variable_mapping WHERE mapping_id LIKE 'variable-definition.%'").all() as Array<{ mapping_id: string }>;
    const remove = this.database.prepare("DELETE FROM variable_mapping WHERE mapping_id = ?");
    let removed = 0;
    for (const { mapping_id } of stored) if (!keep.has(mapping_id)) { remove.run(mapping_id); removed += 1; }
    return removed;
  }

  invalidateDiscoveries(version: string): number {
    this.database.exec("CREATE TABLE IF NOT EXISTS repository_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
    const stored = this.database.prepare("SELECT value FROM repository_meta WHERE key = 'discovery_rules_version'").get() as { value: string } | undefined;
    if (stored?.value === version) return 0;
    const dropped = this.database.prepare("DELETE FROM variable_mapping WHERE json_extract(json, '$.provenance') IN ('realtime_discovery', 'automated_model_review') AND status IN ('discovered', 'database_verified', 'model_reviewed')").run().changes;
    this.database.prepare("INSERT INTO repository_meta (key, value) VALUES ('discovery_rules_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(version);
    return Number(dropped);
  }

  async save(record: VariableMappingRecord): Promise<boolean> {
    const existing = this.database.prepare("SELECT json FROM variable_mapping WHERE mapping_id = ?").get(record.mapping_id) as JsonRow | undefined;
    let storedRecord = record;
    if (existing) {
      const previous = JSON.parse(existing.json) as VariableMappingRecord;
      if (previous.mapping_version === record.mapping_version && JSON.stringify(immutableDefinition(previous)) !== JSON.stringify(immutableDefinition(record))) return false;
      const preserveLifecycle = lifecycleRank[previous.status] > lifecycleRank[record.status];
      storedRecord = {
        ...record,
        ...(preserveLifecycle ? { status: previous.status, provenance: previous.provenance } : {}),
        evidence: { ...previous.evidence, ...record.evidence, ...(record.evidence.data_profile ?? previous.evidence.data_profile ? { data_profile: record.evidence.data_profile ?? previous.evidence.data_profile } : {}) },
        created_at: previous.created_at,
      };
    }
    const searchable = normalize([storedRecord.labels.en, storedRecord.labels.zh, ...storedRecord.synonyms].filter(Boolean).join(" "));
    this.database.prepare(`
      INSERT INTO variable_mapping (mapping_id, concept_id, status, searchable_text, json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mapping_id) DO UPDATE SET status = excluded.status, searchable_text = excluded.searchable_text, json = excluded.json
    `).run(storedRecord.mapping_id, storedRecord.concept_id, storedRecord.status, searchable, JSON.stringify(storedRecord));
    return true;
  }

  async findById(mappingId: string): Promise<VariableMappingRecord | undefined> {
    const row = this.database.prepare("SELECT json FROM variable_mapping WHERE mapping_id = ?").get(mappingId) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as VariableMappingRecord : undefined;
  }

  async findByTerm(term: string): Promise<VariableMappingRecord[]> {
    const normalized = normalize(term);
    const rows = this.database.prepare("SELECT json FROM variable_mapping WHERE searchable_text LIKE ? ORDER BY status DESC, mapping_id LIMIT 25")
      .all(`%${normalized}%`) as unknown as JsonRow[];
    // LIKE is only a prefilter: a Latin term must match whole words ("age" must not find "blocking agent").
    const han = /\p{Script=Han}/u.test(normalized);
    const words = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return rows.map(({ json }) => JSON.parse(json) as VariableMappingRecord).filter((record) => han || [record.labels.en, record.labels.zh, ...record.synonyms, record.concept_id]
      .filter((value): value is string => Boolean(value)).some((alias) => {
        const aliasWords = normalize(alias).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        for (let start = 0; start + words.length <= aliasWords.length; start += 1) if (words.every((word, offset) => aliasWords[start + offset] === word)) return true;
        return false;
      }));
  }

  async listByStatus(statuses: VariableMappingStatus[]): Promise<VariableMappingRecord[]> {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.database.prepare(`SELECT json FROM variable_mapping WHERE status IN (${placeholders}) ORDER BY mapping_id`)
      .all(...statuses) as unknown as JsonRow[];
    return rows.map(({ json }) => JSON.parse(json) as VariableMappingRecord);
  }
}
