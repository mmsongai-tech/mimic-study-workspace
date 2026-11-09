# Dynamic variable mapping

## Module card

**Problem and user value:** Researchers should be able to ask about new clinical terms without requiring one hard-coded branch per variable, while the platform must never let a language model invent MIMIC-IV fields, item identifiers, codes, or SQL.

**Primary responsibility:** Resolve a study variable through reusable local mappings, read-only MIMIC-IV schema/dictionary discovery, and an explicit review path. Dynamic dictionary candidates may be frozen by runtime-authorized automated semantic review or by clinician confirmation; the two evidence states remain distinct.

**Non-responsibilities:** The module does not define the research purpose, choose a statistical method, build a patient cohort, execute arbitrary SQL, export patient-level rows, or decide that a clinical definition is correct without review.

**Public interfaces:** `StudyVariableMappingService.assess` returns resolved, review-required, or unmapped variables and optional automated review evidence. `confirm` verifies source fields against the inspected catalog and records a clinician review note. The HTTP adapter exposes session assessment and mapping confirmation endpoints.

**State owner:** `SqliteVariableMappingRepository` owns runtime mapping state. `config/mappings/mimic-iv-core.json` is the versioned, redistributable seed pack. Restart seeding never downgrades reviewed state.

**Failure owner:** External model and database clients normalize failures to stable mapping errors. An unavailable Router falls back to the original term. An unavailable database prevents live discovery but does not make the workspace unavailable. Unknown or unverifiable terms remain explicitly unmapped.

**Dependency direction:** The use-case services depend on mapping repositories, terminology and term-expansion interfaces, and a read-only catalog value. The Router and `psql` implementations are replaceable clients. Analysis planning receives only a public mutable catalog of clinician-confirmed or validated mappings.

**Model boundary and cost:** Models are optional and called only during explicit live search. Term expansion cannot provide identifiers. The separate evidence reviewer receives only catalog-verified candidates and supplied code/item labels, uses a strict JSON Schema (with a validated JSON-object compatibility fallback), and may only select a supplied evidence-key subset. Deterministic guards reject invented identifiers and block an unrefined broad set or any selection over 100 entries.

**Embedding retrieval (evaluation switch, off by default):** `variable_mapping.embedding_search` in the typed configuration (`MIMIC_EMBEDDING_SEARCH=1` for a question run) appends the dictionary labels nearest to a term's meaning (BGE-M3 through Ollama; index built by `npm run variables:embedding-index` into `.local/`, never committed) after the text-search candidates. It removes or reorders nothing, a neighbour never takes an item place of a text match, and every check after the search applies to it unchanged; the drug-label exemption does not cover a label found only by embedding. Measured on 2026-10-28 (internal progress log): no term newly resolved in the 39-question regression and new wrong candidates at candidate level, so it stays off.

**Safety:** Dictionary search is limited to fixed MIMIC-IV dictionary tables in a read-only transaction. Credentials are not placed in process arguments. Only aggregate match metadata and mapping definitions are stored; patient rows and full prompts are not logged or exported.

**Independent verification:** Unit tests cover versioned seeding, bilingual and compound terms, unknown terms, schema indexing, dictionary caching, lifecycle transitions, bounded model calls, and immediate analysis-planning reuse. The repository-wide native check covers real HTTP, R execution, sandboxing, reports, and the existing workflows.

**Operational states:**

- `discovered`: a candidate exists but has not passed catalog verification;
- `database_verified`: referenced relations and columns exist;
- `model_reviewed`: a runtime-authorized model selected a frozen subset of supplied, database-verified dictionary evidence; provenance states `clinical_confirmation: false`;
- `clinician_confirmed`: a researcher confirmed the study definition and time window;
- `validated`: the team approved the reusable mapping pack entry;
- `deprecated`: retained for history but excluded from matching.

**Evidence level:** L3 for the offline seed, lifecycle, HTTP/UI, and analysis-planning bridge. Live company MIMIC dictionary validation remains below L4 until the SSH tunnel is running and an approved real dictionary-only smoke is recorded.

**Rollback:** Remove `backend/src/variable-mapping/`, the two variable-mapping runtime adapters, the mapping pack, prompt/schema, HTTP routes, and the compact frontend panel; restore `MimicIvConceptMappingService` construction without the mutable catalog. Existing registered synthetic workflows remain independent.
