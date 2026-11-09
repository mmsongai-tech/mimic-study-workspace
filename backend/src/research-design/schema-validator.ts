import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { StudySpec } from "./study-spec.js";
import type { ConfirmedStudySpec } from "./design-session.js";
import type { ResearchDesignProposal } from "./model-proposal.js";
import type { ConfirmDesignRequest, ContinueDesignRequest, StartDesignRequest } from "./requests.js";
import { assessAnalysisObjectiveContract } from "./analysis-objectives.js";

const contractUrl = (name: string) =>
  new URL(`../../../contracts/research-design/${name}.schema.json`, import.meta.url);

const readSchema = (name: string): object =>
  JSON.parse(readFileSync(contractUrl(name), "utf8")) as object;

const formatErrors = (errors: ErrorObject[] | null | undefined): string[] =>
  (errors ?? []).map(({ instancePath, keyword, message, params }) => {
    const field = keyword === "additionalProperties" && typeof params.additionalProperty === "string"
      ? ` '${params.additionalProperty}'`
      : "";
    return `${instancePath || "/"} ${message ?? "is invalid"}${field}`;
  });

export interface ResearchDesignValidation {
  checkStartRequest(value: unknown): string[];
  checkContinueRequest(value: unknown): string[];
  checkConfirmRequest(value: unknown): string[];
  checkProposal(value: unknown): string[];
  checkStudySpec(value: unknown): string[];
  isConfirmedExecutableStudy(value: unknown): boolean;
  checkConfirmedStudySpec(value: unknown): string[];
}

export class JsonSchemaResearchDesignValidator implements ResearchDesignValidation {
  private readonly startRequest: ValidateFunction<StartDesignRequest>;
  private readonly continueRequest: ValidateFunction<ContinueDesignRequest>;
  private readonly confirmRequest: ValidateFunction<ConfirmDesignRequest>;
  private readonly proposal: ValidateFunction<ResearchDesignProposal>;
  private readonly studySpec: ValidateFunction<StudySpec>;
  private readonly confirmedExecutableStudy: ValidateFunction<StudySpec>;
  private readonly confirmedStudySpec: ValidateFunction<ConfirmedStudySpec>;

  constructor() {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    ajv.addFormat("date-time", {
      type: "string",
      validate: (value: string) => {
        const parsed = new Date(value);
        return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
      },
    });
    [
      "intent-assessment",
      "study-spec",
      "requests",
      "proposal",
      "confirmed-association-study-spec",
      "responses",
    ].forEach((name) => ajv.addSchema(readSchema(name)));

    this.startRequest = this.requireSchema(
      ajv,
      "urn:mimic-research-agent-platform:contracts:research-design:requests:1.0.0#/$defs/startDesignRequest",
    );
    this.continueRequest = this.requireSchema(
      ajv,
      "urn:mimic-research-agent-platform:contracts:research-design:requests:1.0.0#/$defs/continueDesignRequest",
    );
    this.confirmRequest = this.requireSchema(
      ajv,
      "urn:mimic-research-agent-platform:contracts:research-design:requests:1.0.0#/$defs/confirmDesignRequest",
    );
    this.proposal = this.requireSchema(
      ajv,
      "urn:mimic-research-agent-platform:contracts:research-design:proposal:1.0.0",
    );
    this.studySpec = this.requireSchema(
      ajv,
      "urn:mimic-research-agent-platform:contracts:research-design:study-spec:1.0.0",
    );
    this.confirmedExecutableStudy = this.requireSchema(
      ajv,
      "urn:mimic-research-agent-platform:contracts:research-design:confirmed-association-study-spec:1.0.0",
    );
    this.confirmedStudySpec = this.requireSchema(
      ajv,
      "urn:mimic-research-agent-platform:contracts:research-design:responses:1.0.0#/$defs/confirmedStudySpec",
    );
  }

  checkStartRequest(value: unknown): string[] {
    return this.startRequest(value) ? [] : formatErrors(this.startRequest.errors);
  }

  checkContinueRequest(value: unknown): string[] {
    return this.continueRequest(value) ? [] : formatErrors(this.continueRequest.errors);
  }

  checkConfirmRequest(value: unknown): string[] {
    return this.confirmRequest(value) ? [] : formatErrors(this.confirmRequest.errors);
  }

  checkProposal(value: unknown): string[] {
    return this.proposal(value) ? [] : formatErrors(this.proposal.errors);
  }

  checkStudySpec(value: unknown): string[] {
    return this.studySpec(value) ? [] : formatErrors(this.studySpec.errors);
  }

  isConfirmedExecutableStudy(value: unknown): boolean {
    return this.confirmedExecutableStudy(value) && assessAnalysisObjectiveContract(value as StudySpec).length === 0;
  }

  checkConfirmedStudySpec(value: unknown): string[] {
    return this.confirmedStudySpec(value) ? assessAnalysisObjectiveContract((value as ConfirmedStudySpec).spec).map(({ code, field_path }) => `${code}: ${field_path}`) : formatErrors(this.confirmedStudySpec.errors);
  }

  private requireSchema<T>(ajv: Ajv2020, id: string): ValidateFunction<T> {
    const validator = ajv.getSchema<T>(id);
    if (!validator) throw new Error(`Missing schema: ${id}`);
    return validator;
  }
}
