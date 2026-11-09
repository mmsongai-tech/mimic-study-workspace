import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResearchDesignProposal, validateResearchDesignProposal } from "../../research-design/index.js";
import { completeAssociationProposal } from "../../research-design/tests/model-fixtures.js";
import { runRouterSyntheticSmoke } from "../router-smoke.js";

test("validates one fixed synthetic Router proposal without clinical data", async () => {
  let captured: unknown;
  const result = await runRouterSyntheticSmoke({
    provider: {
      async generateProposal(input) {
        captured = input.model_input;
        return completeAssociationProposal();
      },
    },
    systemPrompt: "test prompt",
    model: "aws/gpt-5.4-mini",
    timeoutMs: 30_000,
  });
  assert.deepEqual(result, {
    status: "passed",
    model: "aws/gpt-5.4-mini",
    recommended_intent: "association",
    readiness: "candidate_ready",
  });
  assert.match(JSON.stringify(captured), /synthetic data/u);
  assert.doesNotMatch(JSON.stringify(captured), /patient_id|subject_id|hadm_id/u);
});

test("normalizes fractional time windows in root and suggested candidates", () => {
  const normalized = normalizeResearchDesignProposal({
    candidate_spec: { time_windows: [{ purpose: "follow_up", start_offset: 0, end_offset: 0.5, unit: "day" }] },
    suggestions: [{ candidate_spec: { time_windows: [{ purpose: "follow_up", start_offset: 0, end_offset: 0.5, unit: "day" }] } }],
  }) as { candidate_spec: { time_windows: unknown[] }; suggestions: Array<{ candidate_spec: { time_windows: unknown[] } }> };
  const expected = [{ purpose: "outcome", start_offset: 0, end_offset: 12, unit: "hour" }];
  assert.deepEqual(normalized.candidate_spec.time_windows, expected);
  assert.deepEqual(normalized.suggestions[0]?.candidate_spec.time_windows, expected);
});

test("unwraps an exact data envelope only when its payload is a valid proposal", () => {
  const proposal = completeAssociationProposal();
  const normalized = normalizeResearchDesignProposal({ data: proposal });

  assert.deepEqual(normalized, proposal);
  assert.deepEqual(validateResearchDesignProposal(normalized), []);
});

test("does not unwrap invalid or ambiguous data envelopes", () => {
  const invalid = normalizeResearchDesignProposal({ data: { assistant_message: "incomplete" } });
  const ambiguous = normalizeResearchDesignProposal({ data: completeAssociationProposal(), metadata: {} });

  assert.notDeepEqual(validateResearchDesignProposal(invalid), []);
  assert.notDeepEqual(validateResearchDesignProposal(ambiguous), []);
  assert.deepEqual(Object.keys(ambiguous as Record<string, unknown>).sort(), ["data", "metadata"]);
});
