import type { StatisticalMethodProfile } from "./analysis-plan.js";

export interface AnalysisMethodOption { method_id: string; label: string; primary: boolean; available: boolean; unavailable_reason?: string; required_conditions: string[]; required_diagnostics: string[]; }

export const buildMethodOptions = (input: { method: StatisticalMethodProfile; primary_available: boolean; available_method_ids?: readonly string[] }): AnalysisMethodOption[] => {
  const available = new Set(input.available_method_ids ?? []);
  return [input.method.primary_method, ...input.method.alternative_methods].map((label, index) => {
    const method_id = `${input.method.method_id}.${index === 0 ? "primary" : `alternative-${index}`}`;
    const isAvailable = index === 0 ? input.primary_available : available.has(method_id);
    return { method_id, label, primary: index === 0, available: isAvailable, ...(isAvailable ? {} : { unavailable_reason: "No verified executor is registered for this method in the current runtime." }), required_conditions: [...input.method.required_conditions], required_diagnostics: [...input.method.required_diagnostics] };
  });
};
