# Decision 0004: R is the primary medical-statistics runtime

Status: accepted

## Context

The synthetic MVP proves orchestration with an in-process TypeScript calculation, but it does not produce the statistical tables, figures, diagnostics, and manuscript-ready reporting expected by clinical researchers. The product must keep workflow state and evidence ownership separate from statistical implementation.

## Decision

- TypeScript remains the owner of research workflow, typed contracts, process supervision, evidence persistence, HTTP, and UI delivery.
- R is the primary runtime for medical-statistics execution and publication-oriented statistical figures.
- Python may be added behind the same executor contract for prediction, machine learning, data preparation, or independent verification.
- Statistical runtimes receive only a validated execution input through an adapter and return a typed aggregate result. They do not read application configuration, databases, prompts, or UI state.
- Runtime failure fails closed. The workflow must not silently substitute a TypeScript or Python result for a requested R execution.
- Tables, figures, diagnostics, reports, and reproducibility metadata must derive from the same immutable run.

## Initial scope

The first R slice reproduces the registered synthetic lactate association with aggregate counts, risks, risk difference, odds ratio, confidence interval, method metadata, and an aggregate risk figure. It is synthetic workflow evidence, not clinical validation.

## Review triggers

Review this decision before remote execution, container deployment, patient-level data transfer across a host boundary, a second statistical runtime becoming primary, or a public `AnalysisResult` version change.
