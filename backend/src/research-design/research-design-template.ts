import type { ResearchIntent } from "./study-spec.js";

export interface ResearchDesignTemplate {
  template_id: string;
  version: "1.0.0";
  intent_family: ResearchIntent;
  purpose: string;
  required_slots: string[];
  constraints: string[];
}

export interface ResearchDesignTemplateContext {
  selected_template_id?: string;
  templates: ResearchDesignTemplate[];
}

export interface ResearchDesignTemplateRegistry {
  list(): ResearchDesignTemplate[];
  get(templateId: string): ResearchDesignTemplate | undefined;
  forIntent(intent: ResearchIntent): ResearchDesignTemplate;
}

const templates: ResearchDesignTemplate[] = [
  {
    template_id: "association.v1",
    version: "1.0.0",
    intent_family: "association",
    purpose: "Estimate a relationship between an exposure or characteristic and an outcome without making an individual prediction or causal treatment claim.",
    required_slots: ["population", "index_time", "exposure", "exposure_window", "aggregation", "contrast", "outcome", "outcome_window", "covariates", "estimand"],
    constraints: [
      "Preserve association language unless the researcher explicitly asks for prediction or a causal treatment effect.",
      "Define exposure timing before the outcome and keep the summary measure non-causal.",
    ],
  },
  {
    template_id: "prediction.v1",
    version: "1.0.0",
    intent_family: "prediction",
    purpose: "Estimate a future individual or group outcome from predictors available at a defined prediction time.",
    required_slots: ["population", "index_time", "prediction_time", "predictors", "predictor_windows", "outcome", "outcome_window", "validation_strategy", "performance_measures", "estimand"],
    constraints: [
      "Every predictor must be available at or before prediction time.",
      "Keep development, validation, discrimination, and calibration requirements explicit.",
    ],
  },
  {
    template_id: "treatment-effect.v1",
    version: "1.0.0",
    intent_family: "treatment_effect",
    purpose: "Estimate what would happen under one intervention strategy compared with another.",
    required_slots: ["population", "index_time", "treatment", "comparator", "treatment_window", "outcome", "outcome_window", "baseline_confounders", "estimand", "identification_assumptions"],
    constraints: [
      "Align eligibility, treatment assignment, and follow-up at the same time zero.",
      "Define an explicit comparator and keep confounders before treatment assignment.",
    ],
  },
];

export class RegisteredResearchDesignTemplateRegistry implements ResearchDesignTemplateRegistry {
  private readonly byId = new Map(templates.map((template) => [template.template_id, template]));

  list(): ResearchDesignTemplate[] {
    return structuredClone(templates);
  }

  get(templateId: string): ResearchDesignTemplate | undefined {
    const template = this.byId.get(templateId);
    return template ? structuredClone(template) : undefined;
  }

  forIntent(intent: ResearchIntent): ResearchDesignTemplate {
    const template = templates.find((candidate) => candidate.intent_family === intent);
    if (!template) throw new Error(`No research design template is registered for ${intent}.`);
    return structuredClone(template);
  }
}

export const createResearchDesignTemplateRegistry = (): ResearchDesignTemplateRegistry =>
  new RegisteredResearchDesignTemplateRegistry();
