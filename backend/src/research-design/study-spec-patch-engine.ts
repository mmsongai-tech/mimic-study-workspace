import jsonPatch from "fast-json-patch";
import { DesignError } from "./design-error.js";
import type { StudySpecChange } from "./study-spec.js";
import type { StudySpec } from "./study-spec.js";

export interface StudySpecStructureValidation {
  checkStudySpec(value: unknown): string[];
}

export interface StudySpecPatchEngine {
  apply(current: StudySpec, patch: StudySpecChange[]): StudySpec;
}

export class ValidatedStudySpecPatchEngine implements StudySpecPatchEngine {
  constructor(private readonly validation: StudySpecStructureValidation) {}

  apply(current: StudySpec, patch: StudySpecChange[]): StudySpec {
    let next: StudySpec;
    try {
      const prepared = structuredClone(current) as unknown as Record<string, unknown>;
      const normalizedPatch = patch.map((operation) => {
        const segments = operation.path.split("/").slice(1).map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
        let cursor: Record<string, unknown> = prepared;
        for (const segment of segments.slice(0, -1)) {
          const existing = cursor[segment];
          if (!existing || typeof existing !== "object" || Array.isArray(existing)) cursor[segment] = {};
          cursor = cursor[segment] as Record<string, unknown>;
        }
        const leaf = segments.at(-1);
        const normalized = { ...operation } as StudySpecChange;
        if ("value" in normalized) {
          if (segments.at(-1) === "population" && typeof normalized.value === "string") normalized.value = { description: normalized.value };
          if (segments.at(-1) === "index_time" && typeof normalized.value === "string") normalized.value = { event: normalized.value, selection_rule: "As stated in the research question." };
          if (segments.at(-1) === "outcome" && typeof normalized.value === "string") normalized.value = { name: normalized.value, role: "outcome", operational_definition: normalized.value };
          if (segments.at(-1) === "exposure_or_predictors") {
            const values = Array.isArray(normalized.value) ? normalized.value : [normalized.value];
            normalized.value = values.filter((value) => typeof value === "string" || (value && typeof value === "object"))
              .map((value) => typeof value === "string" ? { name: value, role: "exposure", operational_definition: value } : value);
          }
          if (segments.at(-1) === "assumptions") normalized.value = Array.isArray(normalized.value) ? normalized.value : [normalized.value];
          if (segments.at(-1) === "analysis_family" && typeof normalized.value === "string") {
            const value = normalized.value.toLowerCase();
            const timeToEvent = value.includes("time") || value.includes("survival") || value.includes("cox");
            normalized.value = timeToEvent ? value.includes("prediction") ? "time_to_event_prediction" : value.includes("treatment") || value.includes("causal") ? "time_to_event_treatment_effect" : "time_to_event_association" : value.includes("prediction") ? "binary_prediction" : value.includes("treatment") || value.includes("causal") ? "propensity_weighted_treatment_effect" : "association";
          }
          if (segments.at(-1) === "time_windows") {
            const values = Array.isArray(normalized.value) ? normalized.value : [normalized.value];
            normalized.value = values.map((value) => {
              if (value && typeof value === "object") return value;
              const text = String(value ?? "");
              const match = /(\d+(?:\.\d+)?)\s*(minute|分钟|hour|小时|day|天|week|周)/iu.exec(text);
              const end = match ? Number(match[1]) : 0;
              const unit = match?.[2]?.toLocaleLowerCase().startsWith("minute") || match?.[2] === "分钟" ? "minute" : match?.[2]?.toLocaleLowerCase().startsWith("day") || match?.[2] === "天" ? "day" : "hour";
              return { purpose: "outcome", anchor: "index_time", start_offset: 0, end_offset: end, unit, };
            });
          }
        }
        if (leaf && operation.op === "replace" && !(leaf in cursor)) normalized.op = "add";
        return normalized;
      });
      next = jsonPatch.applyPatch(prepared, normalizedPatch, true, false, true)
        .newDocument as unknown as StudySpec;
    } catch {
      throw new DesignError("DESIGN_PROPOSAL_INVALID", "The proposed study changes could not be applied.");
    }

    const errors = this.validation.checkStudySpec(next);
    if (errors.length) {
      throw new DesignError("DESIGN_PROPOSAL_INVALID", "The proposed study design is invalid.", errors);
    }
    return next;
  }
}
