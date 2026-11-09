# Backend validation standard before data integration

## Acceptance layers

1. **Research protocol:** The question remains within association, prediction, or treatment effect; required definitions are explicit and versioned; unsupported or incomplete questions are preserved and blocked rather than substituted.
2. **Clinical concepts:** Every analysis variable resolves to a registered source-independent concept. Units, timing, aggregation, missingness, plausibility, and source requirements are reviewable. Source mappings remain a separate verification step.
3. **Statistical method:** The declared purpose and outcome structure select a versioned method profile with rationale, alternatives, assumptions, diagnostics, sensitivity analyses, and reporting requirements.
4. **Diagnostic decision:** Missing or failed critical diagnostics block interpretation. Non-critical problems remain visible warnings and require sensitivity analysis.
5. **Execution safety:** External runtimes are isolated, bounded, aggregate-only, and fail closed. A dependency failure does not erase design state or make static workspace assets unavailable.
6. **Reproducibility:** Inputs, versions, method identity, diagnostics, aggregate results, warnings, and integrity identifiers are persisted without secrets or patient-level data.

## Gold-set requirements

- Maintain 30–50 distinct representative clinical research questions.
- Cover all 18 combinations of three purposes and six outcome structures.
- Include bilingual concept aliases, unknown concepts, incomplete definitions, and ambiguous questions.
- Validate known method selection, concept requirements, diagnostic blocking, and safe failure behavior deterministically.
- Keep model-provider smoke tests separate from deterministic acceptance because provider availability and cost do not establish correctness.

## Evidence threshold

Passing the deterministic suite is L3 functional evidence for design and planning. Synthetic executor output remains L2–L3 depending on the exercised runtime. L4 requires approved real input, denominators, failures, and limitations. L5 additionally requires end-to-end user acceptance, operating instructions, independent clinical/statistical review, and rollback evidence.
