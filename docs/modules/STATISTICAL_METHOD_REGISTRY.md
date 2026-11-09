# Statistical method registry

## Module card

**Problem and user value:** A research purpose alone is not a statistical method. Researchers need a reviewable recommendation that explains the method, assumptions, diagnostics, alternatives, sensitivity analyses, and the conditions that prevent interpretation.

**Primary responsibility:** Select a versioned statistical method profile from the fixed three research purposes and the declared outcome structure. Assess completed diagnostic observations against method-specific blocking rules.

**Non-responsibilities:** The registry does not infer clinical concepts, inspect data, fit models, generate conclusions, or override researcher confirmation.

**Public inputs:** A classified `StudySpec`; after execution, typed diagnostic observations.

**Public outputs:** A versioned method profile and a diagnostic decision of reportable, reportable with warnings, or blocked.

**Failure ownership:** An undetermined research purpose is a planning failure. Missing or failed critical diagnostics produce a blocked domain result. Non-critical failures remain explicit warnings.

**State and side effects:** The registry is deterministic, stateless, and has no I/O.

**Dependencies:** It depends only on the public research-design types. Executors and report generators may consume its public profile; the registry does not depend on them.

**Independent tests:** All 18 combinations of three research purposes and six outcome structures, plus blocking, warning, and missing-diagnostic policies.

**Completion evidence:** Every supported combination selects a distinct reviewable profile with at least two alternatives, explicit conditions, diagnostics, sensitivity analyses, and report sections.

**Rollback boundary:** Revert the enriched method profile and diagnostic policy. Existing registered executors remain independent.
