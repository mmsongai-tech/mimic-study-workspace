# Backend module map

The backend is a modular monolith. Modules are business capabilities, not one file per
class or error type. Internal files may be merged when they share state, change cadence,
and failure ownership.

## Dependency direction

`application -> {research, clinical_data, analysis, evidence} -> infrastructure`

The public application facade is the only place that assembles a complete workflow.
Business modules do not call one another's internal files.

Adapters for PostgreSQL, local MIMIC archives, R, Python, and model routers remain at the
edge of the owning module. No caller imports an adapter's internal repository or engine.

## Module responsibilities

| Module | Owns | Does not own |
| --- | --- | --- |
| `research` | Question interpretation, study-spec lifecycle, clinical concept mapping, method planning and feasibility decisions | Source queries, R/Python execution, UI state |
| `clinical_data` | MIMIC catalog, local archive/database adapters, read-only profiling, query evidence | Clinical interpretation, study-method choice |
| `analysis` | Association, prediction, treatment-effect execution and method diagnostics | Question interpretation, source connection, report presentation |
| `evidence` | Run diagnostics, provenance, integrity and report artifacts | Source querying, study design |
| `application` | HTTP-facing orchestration and dependency assembly | Domain rules and adapter implementation |
| `infrastructure` | Configuration, model/router clients, storage and runtime adapters | Product decisions |

## Consolidation rule

Each module should expose one small public facade and keep related contracts, errors,
rules, and orchestration together. A separate file is justified only by an independent
replacement boundary, external adapter, security boundary, or materially independent
test surface. Tiny barrel files and contract-only files are not a problem by themselves;
the problem is splitting one business capability across many technical-layer folders.
