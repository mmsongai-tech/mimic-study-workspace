import assert from "node:assert/strict";
import test from "node:test";
import { JsonSchemaResearchDesignValidator } from "../schema-validator.js";
import { baseProposal } from "./model-fixtures.js";

test("identifies an unexpected model field without exposing its value", () => {
  const validator = new JsonSchemaResearchDesignValidator();
  const proposal = baseProposal() as unknown as Record<string, unknown>;
  proposal.unexpected_model_field = "private model content";

  const errors = validator.checkProposal(proposal);

  assert.ok(errors.some((error) => error.includes("'unexpected_model_field'")));
  assert.ok(errors.every((error) => !error.includes("private model content")));
});
