# Dynamic local execution

**Responsibility:** Compile a complete study and evidence-backed variable mappings into an executable manifest v2, run that graph against a local MIMIC-IV archive, dispatch a generic method for association, prediction, or treatment effect, and produce one immutable aggregate-only terminal report.

**Non-responsibilities:** It does not invent clinical definitions, approve mappings, accept SQL, expose patient rows, select unsupported methods, or establish clinical or causal validity.

**Public inputs:** `StudySpec`, `StudyVariableMappingReview`, inspected MIMIC catalog, local archive adapter, non-secret source provenance, and an explicit engineering-validation policy.

**Public outputs:** A `completed` or `blocked` report bundle with manifest identity, cohort reconciliation, statistical method, diagnostics, sensitivity result, reproducibility identity, and artifact integrity.

**State and failures:** Mapping state remains owned by Variable Mapping. Execution retains patient-level projected rows only in process memory and removes statistical temporary files. Research-design, manifest, data, and statistical failures retain distinct blocker stages.

**Security boundary:** Archive members, relations, columns, joins, identifiers, item IDs, and codes must come from inspected evidence. Dynamic dictionary identifiers are executable only after clinician/team review or a runtime-authorized automated review that freezes a supplied evidence subset and records `clinical_confirmation: false`. Local execution accepts no query text. Reports contain aggregates and identities only.

**Verification:** Contract tests cover full-candidate StudySpec handling, exact time-unit normalization, fail-closed mapping, deterministic graph identity, archive streaming and joins, three generic R method families, sensitivity outputs, completed reports, and blocked reports that do not read data.

**Rollback:** Remove `backend/src/execution-manifest/`, the dynamic workflow/runner/generic R executor, random-sweep connection, and this decision. The existing synthetic capabilities and browser workspace remain unchanged.
