import type { RunEvidenceBundle } from "../domain/run-artifact.js";

export interface RunEvidenceRepository {
  save(bundle: RunEvidenceBundle): Promise<boolean>;
  findByRunId(runId: string): Promise<RunEvidenceBundle | undefined>;
  findByStudyIntegrityId(studyIntegrityId: string): Promise<RunEvidenceBundle[]>;
}
