# 0006 Model cost policy

## Status

Accepted on 2026-08-31.

## Context

The synthetic development runtime currently uses a deterministic local research-design adapter. It does not call OpenAI, an API router, or another hosted model. Statistical execution uses local R and report generation uses local Python.

A hosted model provider will be needed later for research-question interpretation and structured research-design proposals. During development, the primary requirement is reliable contract-compliant structured output and tool or function calling, not maximum model quality.

## Decision

- Keep deterministic local adapters as the default for automated tests and offline development.
- When a hosted provider is introduced, use a configurable low-cost model profile as the default testing profile.
- Do not hard-code a provider, model identifier, base URL, or credential in business code.
- Keep credentials in environment variables or an approved secret manager; never commit them.
- Require the testing profile to pass the same schema validation, function-call contract tests, retry policy, and representative prompt cases as any higher-cost profile.
- Upgrade to a more capable model only when recorded evaluation evidence shows that the lower-cost profile fails an agreed quality threshold on a task that matters to the product.
- Allow separate development, evaluation, and production profiles without changing research-design business logic.

## Consequences

Routine automated verification remains deterministic and free of provider cost. Real-provider smoke tests are separate, explicitly enabled, rate-limited, and reported as integration evidence rather than ordinary unit-test evidence. A later provider adapter must expose its selected non-secret profile in run provenance so cost and behavior can be audited.

## Review trigger

Review this decision when a real model provider is connected, when representative prompt evaluations are available, or when a low-cost profile cannot reliably satisfy the research-design output contract.
