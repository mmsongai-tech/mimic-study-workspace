import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const api = readFileSync(new URL("./api.js", import.meta.url), "utf8");
const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("fallback authorization is an explicit request-scoped page action", () => {
  assert.doesNotMatch(app, /window\.confirm/u);
  assert.match(app, /DESIGN_MODEL_FALLBACK_AUTHORIZATION_REQUIRED/u);
  assert.match(api, /allow_openai_fallback/u);
  assert.match(app, /pending\.question/u);
  assert.match(app, /state\.busy/u);
  assert.match(app, /fallback-cancel-button/u);
  assert.match(page, /fallback-authorization-card/u);
  assert.match(page, /fallback-authorize-button/u);
});

test("question Enter submission keeps IME, blank, busy, and Shift+Enter guards", () => {
  assert.match(app, /event\.isComposing/u);
  assert.match(app, /isQuestionComposing/u);
  assert.match(app, /event\.shiftKey/u);
  assert.match(app, /!questionElement\(\)\.value\.trim\(\)/u);
  assert.match(app, /if \(state\.busy\) return/u);
  assert.match(app, /requestSubmit\(\)/u);
});

test("confirmation is rendered before dynamic mapping and planning complete", () => {
  assert.match(app, /state\.confirmed = await researchApi\.confirm[\s\S]*state\.mappingSearchStatus = "mappingSearching";[\s\S]*renderDesign\(\);[\s\S]*state\.plan = await researchApi\.analysisPlan/u);
  assert.match(app, /await loadVariableMappings\(true\)/u);
  assert.match(app, /state\.mappings = await researchApi\.variableMappings\(sessionId, false\)/u);
});

test("restoring a confirmed session reuses saved mappings without a live model search", () => {
  assert.match(app, /const initialize = async[\s\S]*state\.mappings = await researchApi\.variableMappings\(sessionId, false\);[\s\S]*renderVariableMappings\(\);[\s\S]*state\.plan = state\.confirmed \? await researchApi\.analysisPlan/u);
  assert.doesNotMatch(app, /variableMappings\(sessionId, Boolean\(state\.confirmed\)\)/u);
});

test("an exact saved StudySpec remains visibly reviewable before reconfirmation", () => {
  assert.match(app, /reused-design-review/u);
  assert.match(app, /state\.design\.reused_design_review/u);
  assert.match(app, /savedReview\.decisions/u);
  assert.match(app, /!savedReview \|\| Boolean\(state\.confirmed\)/u);
  assert.match(app, /Review saved research choices/u);
  assert.match(app, /reviewedReusedDecisions/u);
  assert.match(app, /decision\.options/u);
  assert.match(app, /I reviewed this choice/u);
  assert.match(app, /reusedReviewComplete/u);
  assert.match(app, /section\.hidden = !state\.design \|\| !state\.confirmed/u);
});

test("mapping review presents every safe candidate before statistical results", () => {
  assert.match(app, /variable\.candidates\.filter/u);
  assert.match(app, /for \(const candidate of visibleCandidates\)/u);
  assert.match(app, /confirmVariableMapping\(candidate\.mapping\.mapping_id/u);
  // The automated dictionary-evidence review outcome is per VARIABLE (it covers every candidate
  // for a term together), so the gate must read `variable.candidate_review`, not a per-candidate
  // field — checking `candidate.candidate_review` would always be vacuously true and never hide a
  // rejected term (this was a real bug, fixed alongside this test).
  assert.match(app, /!variable\.candidate_review \|\| variable\.candidate_review\.decision === "approved"/u);
  assert.doesNotMatch(app, /candidate\.candidate_review/u);
  assert.match(app, /variable\.status === "needs_confirmation" && automatedReviewApproved \? variable\.candidates\.filter/u);
  assert.ok(page.indexOf('id="variable-mapping-review"') < page.indexOf('class="result-panel panel"'));
});

test("multi-objective reports use a persistent report id and preserve objective terminal states", () => {
  assert.match(app, /"objective_counts" in artifact/u);
  assert.match(app, /artifact\.objectives\.map/u);
  assert.match(app, /artifact\.report_id/u);
  assert.match(app, /run\?\.artifact\?\.run_id \?\? run\?\.artifact\?\.report_id/u);
});

test("long local jobs expose persisted phase and elapsed time instead of a silent spinner", () => {
  assert.match(app, /job\.elapsed_ms/u);
  assert.match(app, /job\.phase/u);
  assert.match(app, /mapping_and_execution/u);
  assert.match(app, /LOCAL_RUN_FAILED/u);
});

test("clarification choices allow explicit supplementary definitions without adding fake answer identifiers", () => {
  assert.match(app, /clarificationNotesLabel\.append\(clarificationNotes\)/u);
  assert.match(app, /answers, clarificationNotes\.value\.trim\(\)/u);
  assert.match(api, /\.\.\.\(message \? \{ message \} : \{\}\)/u);
  assert.doesNotMatch(app, /clarificationNotes\.name\s*=/u);
});
