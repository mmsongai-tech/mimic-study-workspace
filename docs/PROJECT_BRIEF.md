# Project brief

## Purpose

Build an open-source-ready MIMIC research agent platform with a reproducible development pipeline, clear module boundaries, safe data handling, and evidence-based acceptance.

## Users

- Clinical researchers who need to turn a research idea into a reviewable study definition.
- Developers and reviewers who need to understand, run, test, and extend the platform without relying on private task history.

## Current delivery: backend MVP

The current delivery combines the development foundation with three complete synthetic vertical slices and a browser-connected local MIMIC archive path: confirmed research design, fail-closed variable mapping, deterministic R execution, persistent immutable aggregate evidence, report generation, and HTTP access. When `MIMIC_LOCAL_ARCHIVE` is configured, browser runs use that read-only archive and never silently fall back to synthetic records. Validation against the public MIMIC-IV demo archive is real local-data engineering evidence, not evidence for a full production MIMIC installation.

## Non-goals for the foundation stage

- Replacing or modifying the current 3002 demonstration service.
- Migrating every historical page, report, experiment, or artifact.
- Publishing patient-level MIMIC data, private database access, credentials, or local caches.
- Claiming research validity before the relevant statistical and data checks exist.
- Creating a large collection of Skills before the underlying workflow has passed representative tasks.

## Confirmed constraints

- The current demonstration repository contains uncommitted work and remains read-only during initial classification.
- Public code must not depend on private absolute paths, local keychains, undeclared services, or non-redistributable data.
- Code quality is judged by boundaries, contracts, configuration, tests, error handling, and maintainability, not only by whether it starts.

## P0

Create a safe migration inventory and move one thin, representative vertical slice through the full delivery pipeline without touching the active demonstration environment.

## Foundation completion criteria

- A new contributor can locate the scope, rules, configuration, prompts, and verification command from the repository root.
- The foundation check passes from the repository root.
- Every source item in the old repository is classified as keep, refactor then migrate, exclude from public release, or pending a decision.
- No patient-level data, credentials, local databases, generated archives, or build outputs are introduced.
