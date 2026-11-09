import type { RunEvidenceBundle } from "../domain/run-artifact.js";
import type { RunEvidenceRepository } from "./run-evidence-repository.js";

export class InMemoryRunEvidenceRepository implements RunEvidenceRepository {
  private readonly bundles = new Map<string, RunEvidenceBundle>();
  private readonly integrityIds = new Set<string>();

  async save(bundle: RunEvidenceBundle): Promise<boolean> {
    if (
      this.bundles.has(bundle.artifact.run_id) ||
      this.integrityIds.has(bundle.artifact.integrity_id)
    ) return false;
    this.bundles.set(bundle.artifact.run_id, structuredClone(bundle));
    this.integrityIds.add(bundle.artifact.integrity_id);
    return true;
  }

  async findByRunId(runId: string): Promise<RunEvidenceBundle | undefined> {
    const bundle = this.bundles.get(runId);
    return bundle ? structuredClone(bundle) : undefined;
  }

  async findByStudyIntegrityId(studyIntegrityId: string): Promise<RunEvidenceBundle[]> {
    return [...this.bundles.values()]
      .filter(({ artifact }) => artifact.study.integrity_id === studyIntegrityId)
      .map((bundle) => structuredClone(bundle));
  }
}
