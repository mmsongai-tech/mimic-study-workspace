# Research Design backend module

## Responsibility

Turn a user's research idea and follow-up answers into a validated, versioned study-design draft, then confirm one exact ready revision. The module owns design-session state, intent clarification, controlled StudySpec updates, immutable revision history, confirmation, and safe response data for the UI.

It does not access research data, judge data feasibility, or run statistics. Those responsibilities are connected through downstream public APIs. The runnable MVP uses a deterministic synthetic model; a real provider remains a replaceable adapter and separate evidence step.

## Structure

```text
clients/       External model boundary
domain/        Study concepts, errors, and deterministic rules
engines/       Controlled StudySpec patch application and confirmation integrity
repositories/  Session persistence boundary with in-memory and SQLite implementations
schemas/       Request, model-output, response, and JSON Schema validation
services/      Start, continue, and confirm use-case orchestration
tests/         Synthetic service and boundary tests
```

Canonical JSON Schemas remain in `contracts/research-design/` so backend, future frontend tooling, and other runtimes share one contract. The versioned model prompt remains in `prompts/product/research-design/`; business code does not contain prompt text.

## Public API

Import only from `index.ts`:

- `createResearchDesignService(model, sessions)` creates the public service.
- `createInMemoryDesignSessionRepository()` creates a deterministic test repository.
- `createSqliteDesignSessionRepository(filename)` creates the persistent local repository.
- `start(request)` creates revision 1.
- `continue(request)` applies a validated change to the viewed revision.
- `confirm(request)` atomically confirms a ready revision without another model call.

All state-changing requests use a globally unique `client_request_id`. A completed retry with the same payload replays the original result without another model call. Reusing the identifier with another payload or operation fails safely. An atomic request claim prevents concurrent duplicate `start` or `continue` operations from calling the model twice. While the first request is active, another caller receives `DESIGN_REQUEST_IN_PROGRESS` and can retry the same request after completion.

The runtime exposes the module through versioned HTTP routes. A provider-neutral retrying model adapter and persistent SQLite repository are included; no real provider is configured by default.

## Errors

Public service failures use `DesignError` with a stable `code`, safe `message`, and optional validation details. Raw model, storage, prompt, and patient data are never included.

## Commands

From the repository root:

```bash
npm run typecheck
npm test
npm run check
```

## Current evidence

Automated tests cover fixtures, configured policies, atomic request claims, SQLite restart behavior, HTTP transport, and the connected synthetic workflow. They do not prove real-model, real-data, frontend, deployment, or clinical execution.
