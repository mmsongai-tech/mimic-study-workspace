import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { ObjectiveCoverageReview, ResearchObjectiveList } from "./research-objective-list.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const load = (name: string): object => JSON.parse(readFileSync(new URL(`../../../contracts/research-objectives/${name}.schema.json`, import.meta.url), "utf8")) as object;
const objectiveValidator = ajv.compile<ResearchObjectiveList>(load("objective-list"));
const coverageValidator = ajv.compile<ObjectiveCoverageReview>(load("coverage-review"));
const errors = (validator: ValidateFunction<unknown>): string[] => (validator.errors ?? []).map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`);

export const validateResearchObjectiveList = (value: unknown): string[] => objectiveValidator(value) ? [] : errors(objectiveValidator);
export const validateObjectiveCoverageReview = (value: unknown): string[] => coverageValidator(value) ? [] : errors(coverageValidator);
