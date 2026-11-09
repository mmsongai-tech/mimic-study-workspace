import type { VariableMappingRecord, VariableMappingStatus } from "./variable-mapping.js";

export interface VariableMappingRepository {
  save(record: VariableMappingRecord): Promise<boolean>;
  findById(mappingId: string): Promise<VariableMappingRecord | undefined>;
  findByTerm(term: string): Promise<VariableMappingRecord[]>;
  listByStatus(statuses: VariableMappingStatus[]): Promise<VariableMappingRecord[]>;
}
