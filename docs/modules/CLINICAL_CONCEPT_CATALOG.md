# Clinical concept catalog

## Module card

**Problem and user value:** Clinical research language must be normalized into reviewable data requirements without allowing a model to invent source fields.

**Primary responsibility:** Define source-independent clinical concepts, units, temporal semantics, aggregation choices, missingness cautions, plausibility requirements, and source capabilities. Resolve explicit research text to a registered concept or fail closed.

**Non-responsibilities:** The module does not select database tables, item identifiers, cohort SQL, statistical methods, or imputation values.

**Public input:** A role and natural-language concept description.

**Public output:** A resolved, ambiguous, or unresolved result with requirements and warnings.

**Failure ownership:** Duplicate catalog identifiers are catalog-construction failures. Ambiguous and unresolved text are safe domain results, not invented mappings.

**State and side effects:** The initial catalog is immutable application content. Resolution has no I/O or external side effects.

**Dependencies:** None. Data-source adapters may consume this module's public contract; this module must not depend on those adapters.

**Independent tests:** Bilingual representative concept cases, unknown concepts, and defensive-copy behavior.

**Completion evidence:** The initial catalog resolves representative ICU demographics, encounters, vital signs, laboratory tests, medications, interventions, diagnoses, scores, and outcomes while retaining a source-mapping requirement.

**Connection status:** Analysis planning calls the catalog before choosing registered or guarded execution. Undefined or ambiguous variables block execution; resolved concepts proceed to the independent source-mapping step. Resolution never implies that a MIMIC-IV or other source mapping has been verified.

**Rollback boundary:** Remove `backend/src/clinical-concept-catalog/` and this document. Existing MIMIC-specific mapping remains independent.
