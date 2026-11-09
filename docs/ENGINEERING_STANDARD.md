# Engineering standard

This standard is the reduced, enforceable form of the supplied programming standard. It preserves the original architecture and quality intent while removing repeated prohibitions and mandatory empty directory trees.

## 0. Decide boundaries before implementation

Before choosing files or writing code, identify each responsibility, its state owner, its failure owner, and the direction of its dependencies. Check whether business rules and replaceable dependencies can be tested independently and whether changing one capability would force unrelated capabilities to change.

Do not accept a god service, mixed layer, duplicated rule, or hidden dependency merely because it is the shortest prototype path. When speed matters, reduce the feature slice while preserving the agreed architecture. Search for an existing standard, maintained library, or repository abstraction before creating a new mechanism.

If a boundary correction would materially change approved scope, a public contract, cost, safety, or delivery acceptance, resolve that decision before implementation.

Technical names use English: repositories, directories, files, modules, packages, public domains, endpoint paths, configuration keys, environment variables, and code identifiers. Chinese or another product language is allowed only in intentional user-facing content, localized copy, or representative content fixtures.

## 1. Architecture follows business capability

Backend modules represent business domains. Frontend modules represent product features. A module exposes a small public API and keeps implementation details private.

Create only the layers the module needs:

- routes or transport adapters handle HTTP and WebSocket protocols;
- schemas define external requests, responses, events, and errors;
- domain code holds stable business concepts and rules;
- services coordinate use cases;
- repositories access structured data;
- storage handles files, caches, and runtime buffers;
- clients isolate external services and SDKs;
- engines implement independently testable algorithms or inference flows.

Routes do not contain business workflows. Domain code does not access databases, files, networks, or models. Repositories and clients do not call services. Utilities contain only small functions without business meaning.

## 2. Public interfaces are explicit

Cross-module code depends only on a documented public service, exported module API, client, or network contract. Internal repositories, storage, engines, prompts, models, and utilities are not public interfaces.

Every public interface defines its input, output, error model, side effects, configuration dependencies, and stability. Contract changes update backend schemas, frontend types, adapters, documentation, examples, and tests together.

## 3. Configuration has one entry point

Each runtime has one typed configuration entry point. Precedence is:

```text
defaults < versioned config < environment variables < command-line arguments
```

Business code does not call `os.getenv`, read TOML directly, or embed ports, service URLs, model paths, timeouts, thresholds, or feature flags. Versioned examples contain safe placeholders only.

## 4. Prompts and models are maintained assets

Prompts are versioned templates outside service code. A prompt records its purpose, required inputs, output contract, constraints, test cases, and observed results. A material change creates a history entry and runs representative tests.

Model weights and caches are not committed by default. A model integration documents the provider or artifact, version, license, expected location, download process, integrity check, and fallback behavior.

## 5. Frontend code is feature based

Application-level routing and providers stay in the app layer. Reusable presentation components do not contain business rules or API calls. A feature owns its pages, components, hooks, API wrapper, types, adapters, workflows, rules, and tests as those responsibilities appear.

Other features import only from the feature's public entry point. Complex DTO-to-view transformations belong in adapters. Complex interaction state belongs in a workflow or focused hook, not a page component.

## 6. Types, errors, and logs are contracts

Core data crossing layers is typed. Do not use long-lived unstructured dictionaries or `any` for core business state.

Errors have a stable code, readable message, and optional safe details. Services raise business errors; transports map them; clients normalize external failures; repositories expose data-access failures. Do not swallow errors.

Logs identify the module and correlation or session identifier without containing secrets, patient data, full prompts, or large model context. Debug traces are disabled by default in release environments and never influence business decisions.

## 7. Tests follow risk

Prioritize business rules, interface contracts, complex workflows, configuration, adapters, and failure boundaries. Mock external model calls for deterministic tests. Keep a separate integration or smoke check for the real provider when authorization and cost allow it.

A bug fix includes a regression test when practical. A new path covers its primary behavior and important boundaries. If automation is not practical, document the manual procedure and evidence.

## 8. Code remains small and local

Prefer a small reversible diff and existing abstractions. A file over roughly 300 lines, or a complex workflow over roughly 500 lines, triggers a responsibility review rather than an automatic split.

Names describe business responsibility. Avoid generic `helper`, `manager`, or `processor` modules unless the name also identifies a specific capability. Do not abstract before two real callers or a clear contract justify it.

## 9. Completion requires evidence

Before reporting completion, run the checks relevant to the change and record the exact commands and results. A report states skipped checks, residual risk, and rollback. Use the evidence levels in `DELIVERY_PIPELINE.md`; do not upgrade the status based on wording alone.
