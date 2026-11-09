export interface CapabilityManifest {
  intent_family: "association" | "prediction" | "treatment_effect";
  analysis_family: string;
  outcome_structure: "binary" | "continuous" | "count" | "time_to_event" | "repeated_measure" | "competing_risk";
  required_data_concepts: string[];
  required_diagnostics: string[];
  field_manifest: Array<{ name: string; role: string; type: "number" | "integer" | "boolean" | "category" }>;
}

export interface AnalysisCapability<TRequest = unknown, TResult = unknown> {
  capability_id: string;
  label: string;
  manifest: CapabilityManifest;
  execute(request: TRequest): Promise<TResult>;
}

export class AnalysisCapabilityRegistry {
  private readonly capabilities = new Map<string, AnalysisCapability>();

  register<TRequest, TResult>(capability: AnalysisCapability<TRequest, TResult>): void {
    if (!capability.capability_id.trim() || this.capabilities.has(capability.capability_id)) throw new Error("A unique capability_id is required.");
    this.capabilities.set(capability.capability_id, capability as AnalysisCapability);
  }

  get(capabilityId: string): AnalysisCapability | undefined { return this.capabilities.get(capabilityId); }
  list(): AnalysisCapability[] { return [...this.capabilities.values()]; }
  has(capabilityId: string): boolean { return this.capabilities.has(capabilityId); }
}
