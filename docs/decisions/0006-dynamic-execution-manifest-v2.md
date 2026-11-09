# Decision 0006: Dynamic execution manifest v2

## Context

The first manifest recorded selected fields but could not express joins, dictionary identifiers, time-relative aggregation, analysis units, or machine-executable contrasts. It could also appear frozen while requested variables remained unmapped. Random research questions therefore could not safely reach local execution.

## Decision

- The model proposes a complete candidate `StudySpec`; the backend validates and compares it. Model-authored JSON Patch remains compatibility-only.
- `StudySpec` may state aggregation and contrast semantics, but never database identifiers or SQL.
- Variable mapping supplies catalog-verified relations, columns, item identifiers, codes, and versioned clinical definitions.
- Execution manifest v2 combines those two inputs into a deterministic relational graph containing its analysis unit, sources, joins, variables, time columns, windows, aggregation, contrast, blockers, and SHA-256 identity.
- Local archive execution accepts only a ready graph. It resolves archive members, streams rows, applies allowlisted structured operations, and never accepts SQL.
- Automated random acceptance may execute `database_verified` mappings but labels them as engineering validation. Production confirmation still requires the normal mapping lifecycle.
- Every random question terminates in either a completed real-data report or a persisted evidence-backed blocked report.

## Consequences

The existing v1 manifest remains a compatibility surface during migration and cannot count as execution approval. Unsupported outcome structures, unresolved dictionary values, ambiguous categorical values, missing joins, and incomplete research protocols fail closed. The v2 graph, local runner, generic statistical executor, and report bundle can be removed independently without changing the browser UI or registered synthetic workflows.

## Review trigger

Review this decision before exposing v2 manifests through a public HTTP API, accepting arbitrary SQL, changing clinical confirmation rules, or making a clinical/causal validity claim.
