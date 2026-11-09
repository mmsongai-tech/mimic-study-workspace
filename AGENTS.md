# Repository instructions

## Scope and source of truth

- This repository is the redevelopment and future open-source codebase.
- The existing MIMIC application is a migration source, not a directory to edit from this repository.
- Read `docs/PROJECT_BRIEF.md`, `docs/DELIVERY_PIPELINE.md`, and `docs/ENGINEERING_STANDARD.md` before implementation.
- Preserve user changes. Never overwrite, reset, or delete another repository to simplify migration.

## Required engineering rules

- Before implementation, check responsibility boundaries, state and failure ownership, dependency direction, independent testability, and replacement boundaries. Reduce feature scope rather than creating a god service or mixing layers for speed.
- Use English for repositories, directories, files, modules, packages, public domains, endpoint paths, configuration keys, environment variables, and code identifiers. Other languages are limited to intentional user-facing content and content fixtures.
- Organize backend code by business domain and frontend code by feature.
- Keep protocol, business orchestration, domain rules, data access, external clients, algorithms, and storage concerns separate when those concerns exist.
- Do not create empty architectural directories. Add a layer only when the code has that responsibility.
- Cross-module calls must use a documented public API. Do not import another module's internal repository, storage, engine, prompt, model, or utility code.
- Keep configuration behind one typed entry point. Business code must not read environment variables or TOML files directly.
- Keep prompts outside business logic. Version prompts and test material changes on representative cases.
- Treat API schemas, frontend types, adapters, documentation, and contract tests as one change set.
- Prefer small, reversible changes. Do not combine feature work with unrelated cleanup.

## Safety and open-source rules

- Never commit secrets, credentials, private connection strings, patient-level data, raw MIMIC data, local databases, model weights, generated caches, logs, build outputs, or recovery archives.
- Public fixtures must be synthetic or explicitly redistributable and must state their provenance.
- Do not log full prompts, model context, patient data, or secrets.
- New dependencies require a purpose, license check, and lockfile update.
- Large deletion, public contract changes, license changes, and data migration require explicit user approval.

## Verification and status

- Run the smallest meaningful tests for the change, then the repository checks required by its risk.
- A bug fix needs a regression test when practical. New behavior needs primary-path and important boundary coverage.
- Never report code written, a fixture run, a successful HTTP response, or a configured integration as a production result.
- Use the L1-L5 evidence levels defined in `docs/DELIVERY_PIPELINE.md`.
- Final reports must state changed files, commands run, results, skipped checks, residual risk, and rollback path.
