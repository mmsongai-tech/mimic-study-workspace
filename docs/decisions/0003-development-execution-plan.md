# Decision 0003: Development execution plan

Date: 2026-08-31  
Status: accepted

## Context

The platform needs a stable sequence of product, research, safety, and architecture decisions so implementation can proceed independently without repeatedly asking the user for choices that can be anticipated.

## Decision

- Deliver an internal research-workspace MVP before an external production service.
- Start with a single-user local runtime while preserving explicit ownership boundaries for later authentication.
- Use SQLite behind a replaceable repository contract before considering PostgreSQL.
- Build the first end-to-end capability around a lactate and in-hospital mortality association study.
- Develop association, then prediction, then treatment-effect capabilities.
- Preserve unsupported study intent. The platform may propose the closest executable alternative, but it must create a distinct proposed `StudySpec` and obtain explicit user confirmation before execution. It never silently relabels or substitutes the original question.
- Prepare read-only integration with the approved 1,000-person safety database from the first product slice. Do not copy the database into the repository, expose patient rows to the model or frontend, or treat connectivity as analysis evidence.
- Keep the model boundary provider-neutral. Deterministic tests use fixtures; an authorized real provider is a separate adapter and evidence step.
- Retry only transient model failures with a small configured limit and bounded backoff. After exhaustion, preserve state and return an explicit safe failure. Never fabricate a proposal or result.
- Provide user-selectable Chinese and English UI content. Technical names, contracts, endpoints, configuration, and identifiers remain English.
- Produce a web result, immutable JSON `RunArtifact`, and an exportable report.
- Keep one open-source core containing only synthetic or explicitly redistributable fixtures. Private data connections remain external adapters and configuration.
- Prioritize correctness, traceability, and fail-closed behavior over feature count or presentation speed.
- Repository-local reversible implementation, tests, and documentation may proceed autonomously. Real patient-data access, material paid usage, deployment, release, destructive changes, public-contract changes, secrets, and dependency/license decisions still require the applicable explicit approval.

## Implementation sequence

```text
Persistent repository and atomic request claim
-> enforce runtime limits and retention
-> provider-neutral model adapter
-> HTTP transport
-> Capability Catalog and Preflight
-> first association capability
-> read-only safety-database gateway
-> deterministic statistical execution
-> RunArtifact and report
-> bilingual minimal frontend
-> synthetic end-to-end acceptance
-> approved real-data validation
```

## Review triggers

Review this decision if the first release becomes multi-user, public-facing, cloud-hosted, or treatment-effect execution becomes P0; if the approved data boundary changes; or if SQLite no longer satisfies atomicity, concurrency, or operating requirements.
