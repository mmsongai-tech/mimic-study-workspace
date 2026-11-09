import type { VariableMappingRecord, VariableMappingStatus } from "./variable-mapping.js";
import { VariableMappingError } from "./variable-mapping.js";
import type { VariableMappingRepository } from "./variable-mapping-repository.js";

const nextStates: Record<VariableMappingStatus, VariableMappingStatus[]> = {
  discovered: ["database_verified", "deprecated"],
  database_verified: ["model_reviewed", "clinician_confirmed", "deprecated"],
  model_reviewed: ["clinician_confirmed", "validated", "deprecated"],
  clinician_confirmed: ["validated", "deprecated"],
  validated: ["deprecated"],
  deprecated: [],
};

export class VariableMappingLifecycleService {
  constructor(private readonly repository: VariableMappingRepository, private readonly now = () => new Date().toISOString()) {}

  async register(record: VariableMappingRecord): Promise<VariableMappingRecord> {
    if (!record.mapping_id || !record.concept_id || !record.sources.length) throw new VariableMappingError("MAPPING_INVALID", "The mapping record is incomplete.");
    const saved = await this.repository.save(record);
    if (!saved) throw new VariableMappingError("MAPPING_STORAGE_FAILURE", "The mapping version conflicts with an existing record.");
    return structuredClone(record);
  }

  async transition(mappingId: string, status: VariableMappingStatus, evidence: VariableMappingRecord["evidence"] = {}): Promise<VariableMappingRecord> {
    const current = await this.repository.findById(mappingId);
    if (!current) throw new VariableMappingError("MAPPING_NOT_FOUND", "The variable mapping was not found.");
    if (!nextStates[current.status].includes(status)) throw new VariableMappingError("MAPPING_TRANSITION_INVALID", `The mapping cannot move from ${current.status} to ${status}.`);
    const updated: VariableMappingRecord = {
      ...current, status, provenance: status === "validated" ? "team_validation" : status === "clinician_confirmed" ? "clinician_review" : status === "model_reviewed" ? "automated_model_review" : current.provenance,
      evidence: { ...current.evidence, ...evidence }, updated_at: this.now(),
    };
    if (!await this.repository.save(updated)) throw new VariableMappingError("MAPPING_STORAGE_FAILURE", "The mapping transition could not be saved.");
    return updated;
  }
}
