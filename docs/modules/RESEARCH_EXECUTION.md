# Research execution module cards

Status: connected synthetic and local-archive backend MVP  
Evidence level: L4 local MIMIC demo end-to-end verification

## Research Feasibility

Primary responsibility: match a confirmed study and data-source descriptor to a registered capability, then return supported or fail closed with missing requirements. It does not query data or calculate estimates.

Public contract: `ConfirmedStudySpec + DataSourceDescriptor -> PreflightResult`. The first catalog entry is `association.lactate.in_hospital_mortality.v1`. Independent tests cover supported, missing-concept, and unmatched-study behavior.

## Association Analysis

Primary responsibility: execute the registered crude binary association method against typed input from a replaceable gateway. The gateway owns retrieval and provenance; the engine owns validation and calculation; the service owns orchestration and safe dependency errors.

Public contract: `AssociationExecutionRequest -> AssociationAnalysisResult`. The current synthetic adapter returns self-authored records. No patient rows are exposed to the model, HTTP output, or report. Tests cover the primary result, input boundaries, zero-cell correction, unsupported preflight, and gateway failure.

### R Statistical Executor

Status: design agreed

Primary responsibility: execute one validated association-analysis input in a supervised local R process and return the existing typed aggregate analysis result plus runtime and publication-output metadata.

Non-responsibilities: it does not query a database, select a study design, decide capability support, write run evidence, render UI copy, or silently fall back to another implementation.

Public input: typed `AssociationInput`, confirmed study integrity identifier, and validated lactate threshold. Public output: aggregate counts, estimates, method/runtime metadata, warnings, and safe aggregate publication outputs. Public errors: unavailable runtime, invalid input, failed execution, and malformed output, normalized as analysis errors.

State and side effects: the adapter owns a per-execution temporary directory, removes it after parsing, and never logs input rows. The R script owns no durable state. `Run Evidence` remains the sole owner of immutable run persistence.

Security boundary: R receives only the controlled executor input. It cannot receive database credentials, unrestricted SQL, prompts, or UI state. Aggregate SVG output must not contain subject identifiers.

Independent acceptance: a six-row public synthetic fixture produces the registered counts and estimates, identifies R and its version, produces a non-empty aggregate SVG, and leaves no execution directory behind. Invalid data and process failure fail closed.

Rollback boundary: remove the R adapter and composition without changing Research Design, Preflight, Data Gateway, or Run Evidence storage. The legacy TypeScript engine remains test-only until the R connection is verified.

## Run Evidence

Primary responsibility: bind the exact confirmed study, preflight, and analysis into an immutable `RunArtifact`, calculate a SHA-256 integrity identifier, derive an aggregate-only Markdown report, and persist the bundle behind a repository port.

Public contract: matching study, preflight, and analysis inputs produce `RunEvidenceBundle`; mismatched evidence fails. SQLite owns durable local state and rejects duplicate run or integrity identifiers. Tests cover evidence integrity, safe projection, duplicate rejection, and reopen.

Persisted runs can be recovered through `GET /v1/research-runs/{run_id}`. Recovery returns the immutable aggregate bundle only; it never re-runs statistics or exposes source rows.

When `MIMIC_LOCAL_ARCHIVE` is configured, `POST /v1/research-runs` resolves and profiles reviewed mappings against that archive, streams the required tables, projects only manifest-approved fields, runs the selected R analysis, and stores a schema 2.0 aggregate artifact. Mapping or data failure blocks the run; this path has no synthetic fallback.

## Report Export

Primary responsibility: load one persisted aggregate `RunEvidenceBundle` and derive a clinician-facing DOCX or PDF in Chinese or English. It generates embedded PNG figures and publication-oriented tables without receiving patient-level rows.

Public contract: `run_id + format + language -> binary report`. Supported formats are DOCX and PDF; unknown runs, invalid formats, missing report dependencies, and timeouts fail explicitly. The HTTP route is `GET /v1/research-runs/{run_id}/exports/{docx|pdf}?language={zh|en}`.

Runtime boundary: TypeScript owns lookup, temporary-file lifecycle, timeout, and HTTP delivery. A supervised Python process owns document composition only. The runtime is configured through the typed `report_exports` configuration section. Python packages are pinned in `requirements-report.txt`; they are not application database or statistical dependencies.

Document structure: study design, statistical methods, primary results, Table 1, embedded primary and threshold-sensitivity figures, adjusted analysis, diagnostics/missingness, limitations, and reproducibility identifiers. Synthetic evidence carries a prominent non-clinical warning.

Rollback boundary: remove the report-export composition and route without changing persisted evidence, statistical execution, or the workspace result view.

## Research Workflow

Primary responsibility: connect verified module APIs in order: preflight, analysis, evidence, persistence. It does not inspect module internals or manufacture support. The HTTP adapter retrieves only a confirmed design and supplies a server-owned data-source descriptor.

Rollback boundary: remove the workflow and HTTP execution composition without changing the independent Research Design, Preflight, Analysis, or Run Evidence contracts.
