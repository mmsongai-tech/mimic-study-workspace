# Target architecture and public contracts

## Repository boundary

This repository contains the future public product and its governance tooling. The existing repository continues to serve port 3002 until a separately approved cutover. Governance files do not become runtime dependencies.

## Module map

```text
Showcase UI
    |
    v
Research workflow service
    |----> Research Design ----> ConfirmedStudySpec
    |----> Capability catalog and preflight
    |----> Read-only data gateway
    |----> Statistical executor
    `----> Run artifact and report service

Governance tools inspect source, contracts, licenses, and evidence.
They do not participate in clinical or statistical execution.
```

Dependencies point downward through the contracts below. UI code cannot import data adapters or statistical engines. Statistical code cannot read UI state. Governance code cannot change a research result.

Backend runtime support is composed at the application boundary, outside business modules:

```text
Typed runtime configuration ----> module factories
Versioned prompt registry ------> model client adapters
Authentication / correlation ---> transport adapters
```

These are replaceable runtime capabilities, not business-domain modules. Business services receive typed values and ports through constructors; they do not read TOML, environment variables, prompt files, provider SDKs, or transport state directly. Governance prompts are never registered for product runtime use.

## Dependency-ordered build sequence

1. Complete and independently verify the Research Design lifecycle through confirmation.
2. Freeze `ConfirmedStudySpec` as the only Research Design output accepted downstream.
3. Define Capability Catalog and Preflight against that frozen contract.
4. Add the read-only Data Gateway only for one explicitly supported preflight capability.
5. Connect one deterministic Statistical Executor and then persist immutable Run Evidence.
6. Add HTTP and frontend connections only against verified module APIs.

Only the selected adjacent connection is built at each step. No empty module directories are created in advance.

## Contracts

### Research Design and StudySpec

Input: natural-language research question plus explicitly supplied context.  
Output: versioned `StudySpec` or a structured clarification/unsupported result.  
Owns: the versioned conversation-to-confirmation lifecycle, semantic parsing, normalized research intent, population, exposure or predictors, outcome, time zero, windows, estimand, and requested analysis family.  
Does not own: database queries, statistical estimates, or presentation.

### Capability catalog and preflight

Input: `StudySpec`, data source descriptor, and capability catalog version.  
Output: `PreflightResult` with supported status, matched capability, missing requirements, warnings, and evidence class.  
Owns: matching a study to a registered and validated execution capability.  
Must fail closed: an unmatched or under-specified treatment question cannot reuse an association result.

### Read-only data gateway

Input: approved query specification derived from a supported `StudySpec`.  
Output: typed aggregate or controlled executor input with provenance and row-count metadata.  
Owns: read-only access, field mapping, unit and time checks, and privacy boundary.  
Does not expose: credentials, private paths, unrestricted SQL, or patient rows to the UI or language model.

### Statistical executor

Input: validated execution specification and typed data input.  
Output: `AnalysisResult` containing estimates, uncertainty, diagnostics, counts, method version, and failure state.  
Owns: deterministic statistical computation and method validation.  
Does not own: semantic interpretation, data credentials, or user-facing copy.

### Run artifact and report service

Input: `StudySpec`, `PreflightResult`, `AnalysisResult`, source provenance, and presentation metadata.  
Output: immutable, versioned `RunArtifact` plus derived report views.  
Owns: evidence labels, reproducibility metadata, integrity identifier, and safe report projection.  
Historical artifacts are never silently relabeled as current execution.

### Showcase UI

Input: public workflow responses and safe report views.  
Output: research definition review, confirmation actions, progress, results, limitations, and evidence labels.  
Owns: interaction and presentation.  
Does not calculate estimates, infer data availability, or manufacture execution state.

### Governance tools

Input: repository tree, manifests, migration policy, contracts, and evidence records.  
Output: validation reports and non-zero exit codes on violations.  
Owns: secrets and sensitive-path checks, license inventory, dependency inventory, contract checks, migration allowlist enforcement, and release evidence validation.

## Contract change rule

A public contract change updates its schema or type, producer, consumer, adapter, documentation, contract test, and compatibility or migration note in one reviewed change. No module may depend on an undocumented internal path as a shortcut.
