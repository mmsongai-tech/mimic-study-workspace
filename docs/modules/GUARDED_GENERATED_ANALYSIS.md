# Guarded Generated Analysis module card

Status: design-agreed

## Problem and user value

Researchers need analyses beyond three fixed examples without allowing model-generated code to obtain unrestricted access to MIMIC data or the application host.

## Primary responsibility

Own the review and isolated execution of a typed generated-analysis plan. It validates language, packages, source policy, statistical prerequisites, resource limits, and the result contract, then returns aggregate results and non-sensitive provenance.

## Non-responsibilities

- interpreting a natural-language research question;
- mapping clinical concepts to MIMIC-IV tables and columns;
- issuing unrestricted SQL or managing database credentials;
- deciding that a result is clinically valid;
- replacing registered deterministic executors when an exact verified capability exists.

## Public inputs

`GeneratedAnalysisPlan`, an approved controlled input payload, and `GeneratedExecutionPolicy`.

## Public outputs

`GeneratedAnalysisResult` with status, aggregate result, diagnostics, source digest, runtime evidence, and safe warnings.

## Public errors

`GENERATED_PLAN_INVALID`, `GENERATED_SOURCE_REJECTED`, `GENERATED_RUNTIME_UNAVAILABLE`, `GENERATED_EXECUTION_FAILED`, `GENERATED_EXECUTION_TIMEOUT`, and `GENERATED_OUTPUT_INVALID`.

## Side effects and state ownership

The module owns temporary run directories and removes them after each attempt. Immutable run evidence remains owned by Run Evidence.

## Dependencies

Fixed runtime binaries, a checked-in resource supervisor, the host sandbox adapter, and a cryptographic digest implementation. It does not depend on provider SDKs or a database adapter.

## Configuration

Allowed languages and packages, source/output limits, wall-clock/CPU/memory/file limits, and sandbox mode enter through typed runtime configuration.

## Security and data boundary

Generated source is untrusted. Network, subprocesses, package installation, dynamic evaluation, environment access, and paths outside the run directory are denied. Public errors contain no source, input rows, prompt, secret, or private path.

## Independent tests

- accept minimal compliant R and Python plans;
- reject network, process, environment, dynamic-evaluation, installation, and path-escape attempts;
- enforce timeout and output-size limits;
- validate output schema and remove temporary files;
- return only safe errors and provenance.

## Connection tests

Research Planning can submit only typed plans. Research Workflow can persist only validated aggregate results. Registered capabilities remain the fallback boundary.

## Rollback or replacement boundary

Disable generated execution in typed configuration. Research Design, MIMIC mapping, registered analysis modules, and historical run evidence remain unchanged.

