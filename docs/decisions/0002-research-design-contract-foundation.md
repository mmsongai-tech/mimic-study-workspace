# 0002: Use standards-based Research Design contracts

Status: proposed  
Date: 2026-08-30

## Context

Research Design must turn model-assisted conversation into a versioned `StudySpec` without placing business behavior in the frontend or coupling the product to one model provider. Drafts need structural validation before they are complete, while only sufficiently specified association studies may enter the first preflight path.

The repository uses TypeScript for web application and orchestration. Adding a separate Python service for this responsibility would create an unnecessary process boundary.

## Decision

- Implement Research Design orchestration in the TypeScript backend.
- Use JSON Schema 2020-12 as the language-neutral contract source of truth.
- Keep separate draft and confirmed-association schemas so structural validity is not confused with readiness.
- Use a controlled subset of RFC 6902 JSON Patch for model-proposed changes.
- Use provider-supported structured output behind a provider-neutral model port.
- Confirm the entire `StudySpec` revision in the first slice; do not add field-level locks.
- Define session persistence behind a repository contract and use the smallest replaceable implementation that meets the selected evidence level.

## Reuse candidates

No dependency is introduced by this decision record.

| Capability | Preferred candidate | Reason | Check before adoption |
| --- | --- | --- | --- |
| JSON Schema validation | Ajv 8 | TypeScript support, JSON Schema 2020-12, MIT | Pin version; run schema and security checks. |
| JSON Patch | `fast-json-patch` | RFC 6902 implementation, built-in TypeScript declarations, MIT, zero dependencies | Review release age, security posture, atomic wrapper behavior, and prototype protections. |
| Model structured output | Official provider SDK through an internal adapter | Reuses native schema-constrained output and refusal handling | Pin provider/model compatibility; retain server validation and fallback errors. |
| Type generation | Evaluate `json-schema-to-typescript` as a development tool | Avoids duplicating hand-written DTO types | Confirm generated output stability and keep JSON Schema authoritative. |

## Consequences

- Frontend and downstream consumers can share generated types without owning research rules.
- A model or Prompt change cannot bypass deterministic readiness checks.
- Draft validity, confirmation readiness, data feasibility, and executable capability remain separate states.
- JSON Schema features must stay within the subset supported by consumers and the selected model provider; provider-specific schemas may require an adapter projection.
- Dependency installation requires a separate reviewed change with lockfile and license evidence.

## Review trigger

Review this decision if the first schema cannot express a required study-design invariant, another language becomes the orchestration owner, a selected library is unmaintained or unsafe, or an adjacent consumer cannot support the schema dialect.
