# 0007 Guarded generated analysis

## Status

Accepted on 2026-09-01.

## Context

The three deterministic analysis capabilities validate the product workflow but do not cover general MIMIC-IV research questions. The approved expansion allows a hosted model to propose R or Python analysis code for association, prediction, and treatment-effect studies. Time-to-event and other outcome structures select methods within those purposes; descriptive analysis supports every study. Model output is untrusted and must never receive database credentials or unrestricted host access.

## Decision

- Use the existing provider-neutral Research Design port with an OpenAI-compatible Router adapter. The development profile is low-cost and configuration-controlled.
- Keep the three verified deterministic executors as the preferred fallback whenever a catalog match exists.
- Permit generated R or Python only after a typed analysis plan, MIMIC-IV concept mapping, statistical-condition review, static source review, and explicit user confirmation.
- Execute approved source in a new temporary directory under the macOS sandbox with network denied, process spawning denied, fixed read/write paths, wall-clock and CPU limits, output-size limits, and a minimal environment.
- Do not expose patient rows, prompts, credentials, generated source, or private paths in logs or public errors.
- Reject unsupported imports, package installation, dynamic evaluation, shell/process calls, environment access, sockets, URLs, and paths outside the run directory.
- Validate the machine-readable output contract and record policy, runtime, model profile, code digest, diagnostics, and fallback reason in run provenance.
- Automatically fall back to a registered deterministic capability when generated planning, review, execution, or output validation fails and an exact capability match exists. Otherwise fail closed.

## Monitoring and review trigger

Track review rejection rate, runtime failure rate, timeout rate, output-contract failure rate, fallback rate, and three-purpose evaluation accuracy without storing patient content. Reconsider generated execution and return to registered-only execution if any severe isolation failure occurs, or if the rolling evaluation falls below the agreed acceptance threshold.

## Consequences

Generated execution increases coverage but remains experimental until real MIMIC-IV validation reaches L4. Static review and operating-system sandboxing reduce risk but do not prove production-grade hostile-code isolation. A container or separate worker security boundary remains required before multi-user or production deployment.
