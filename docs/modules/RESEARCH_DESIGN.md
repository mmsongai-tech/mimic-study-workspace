# Research Design module card

Status: verified and connected backend MVP lifecycle  
Evidence level: L3 module and connection verification

Implementation note: `start`, `continue`, and `confirm` have completed-request replay, payload conflict detection, globally unique request identifiers, immutable revision history, durable atomic request claims, and SQLite state persistence. Typed runtime configuration dynamically enforces limits, schema support, retention, retry, and claim TTL. HTTP, preflight, and synthetic workflow connections are contract-tested. Continuing a confirmed design creates an unconfirmed revision while preserving its historical confirmation; run evidence remains queryable only through the exact confirmed-study integrity identifier that produced it.

## Problem and user value

A clinical researcher should be able to describe a research idea in natural language, receive useful clarification, and confirm a reviewable study definition without learning the internal data model. The resulting definition must be stable enough for feasibility checks and reproducible analysis, while remaining editable and traceable.

This module defines the `Research Design and StudySpec` boundary in `docs/TARGET_ARCHITECTURE.md`. It does not introduce a parallel workflow.

## Primary responsibility

Own the conversation-to-study-definition lifecycle:

- create and version a design session;
- ask the model for a structured proposal;
- validate and apply controlled changes to a draft `StudySpec`;
- expose safe, typed presentation data to the frontend;
- record assumptions, warnings, confirmations, and revision history;
- publish a `ConfirmedStudySpec` for downstream preflight.

The backend is the sole owner of study-design state and business decisions. The frontend renders backend responses and submits user intent; it does not call the model, select prompts, merge patches, judge readiness, or duplicate research rules.

## Non-responsibilities

- proving that the requested variables or cohort exist in a data source;
- reading MIMIC or other patient-level data;
- selecting or running a statistical implementation;
- calculating estimates or interpreting results;
- generating reports or evidence levels;
- allowing arbitrary UI code, SQL, or executable expressions from model output.

These responsibilities belong to Research Feasibility, Data Gateway, Analysis Runtime, Run Evidence, or Research Workspace UI.

## Reuse baseline

The module should adapt existing standards before adding custom mechanisms:

- JSON Schema 2020-12 defines machine-validatable contracts.
- RFC 6902 JSON Patch supplies patch operation semantics. The module exposes only an allowlisted subset and validates the complete result after applying a patch.
- The model adapter uses provider-supported structured output where available and always performs server-side validation.
- HL7 FHIR `ResearchStudy` informs interoperability names and mappings; it is not the module's internal state model.
- Mature schema validation and JSON Patch libraries should be assessed for the selected backend stack before implementing either mechanism locally. Adoption requires a license and maintenance check.

## Public inputs

### `StartDesignRequest`

```text
message: non-empty user research description
context?: explicitly supplied, non-patient context
template_id?: versioned design template reference
client_request_id: idempotency key
```

Natural-language input and templates enter the same lifecycle. A template supplies an initial proposal; it does not bypass validation or confirmation.

The backend owns three versioned semantic templates: `association.v1`, `prediction.v1`, and `treatment-effect.v1`. Each declares its research purpose, required semantic slots, and purpose-specific constraints. With no explicit template, all three definitions are sent to the model for classification and completion. With `template_id`, the backend resolves one registered template before the model call, initializes that intent, and rejects unknown templates or model attempts to switch intent. Templates do not contain SQL, database identifiers, or executable code.

### `ContinueDesignRequest`

```text
session_id: design session identifier
base_revision: revision the user viewed
message?: free-text correction or answer
answers?: typed answers keyed by question identifier
client_request_id: idempotency key
```

### `ConfirmDesignRequest`

```text
session_id: design session identifier
base_revision: revision being confirmed
client_request_id: idempotency key
```

Confirmation fails if the revision is stale, invalid, or not ready.

## Public outputs

### `ResearchDesignView`

This is the only design payload the frontend needs to interpret.

```text
session_id
revision
phase: drafting | needs_clarification | ready_to_confirm | confirmed
assistant_message
intent_assessment
study_spec: safe draft projection
assumptions[]
clarifying_questions[]:
  id
  prompt
  reason
  required
  response_kind
  options[]?: { value, label, explanation }
suggestions[]: { id, label, explanation }
warnings[]: { code, message, field_path? }
allowed_actions[]
```

`response_kind` and `allowed_actions` are backend-defined enums. Model output cannot introduce a new component type or executable frontend behavior.

### `ConfirmedStudySpec`

```text
schema_version
session_id
revision
confirmed_at
spec
integrity_id
```

Downstream modules receive only `ConfirmedStudySpec`, never raw chat, raw model output, prompts, or mutable session storage.

### Initial `StudySpec` capability

The schema allows versioned intent families but the first executable path supports association studies only.

```text
schema_version
title
research_question
intent_family: association | prediction | treatment_effect
population
index_time
exposure_or_predictors
outcome
outcome_structure: binary | continuous | count | time_to_event | repeated_measure | competing_risk
time_windows
covariates
estimand
analysis_family
assumptions
```

The three intent families represent research purpose. `outcome_structure` and `analysis_family` select statistical approaches within that purpose. Survival analysis is therefore not a fourth intent, and descriptive statistics are supporting evidence required across all three purposes. Research Feasibility separately decides whether an exact execution capability exists.

The versioned schemas live in `contracts/research-design/`. They cover requests, model proposals, frontend views, drafts, and confirmed output. A draft must pass the structural `StudySpec` schema after every accepted change. Confirmation additionally requires the confirmed-association schema and the deterministic readiness rules below.

### Intent routing

The model returns a typed recommendation for association, prediction, treatment effect, or `undetermined`. High-confidence, unambiguous recommendations may update the draft after backend validation. Medium-confidence, low-confidence, or conflicting interpretations require one user-facing clarification before the backend accepts `intent_family`.

The frontend displays the recommendation, plain-language reason, alternatives, and optional clarification question. It does not classify the question itself. Classification does not grant execution capability: only the first association path can proceed beyond design in the initial slice.

When clarification is required, the backend rejects any proposal that writes `intent_family`. After the user answers, the backend accepts only a high-confidence class that matches the proposed `intent_family`; otherwise it asks again or returns a safe classification error.

### Minimum confirmation readiness for the first slice

The backend may expose `ready_to_confirm` only when all conditions hold:

1. the draft matches the supported schema version;
2. `intent_family` and `analysis_family` are both `association`;
3. title and research question are present;
4. the population and its selection meaning are described;
5. index event and index-event selection rule are defined;
6. at least one operationally defined exposure is present;
7. one operationally defined outcome is present;
8. at least one outcome window is anchored to index time;
9. target population, exposure contrast, outcome measure, and summary measure are stated in the estimand;
10. no required clarification remains unanswered and no blocking warning remains active.

Passing these rules means only that the design is complete enough for preflight. It does not prove data availability, statistical validity, or executability.

## Internal model boundary

The model returns a versioned `ResearchDesignProposal` through a backend adapter:

```text
assistant_message
intent_assessment
spec_patch[]
assumptions[]
clarifying_questions[]
suggestions[]
warnings[]
readiness: needs_clarification | candidate_ready
```

The proposal is untrusted input. The backend:

1. validates the proposal schema;
2. rejects patch paths outside the allowlist;
3. checks `base_revision` before mutation;
4. applies the patch atomically;
5. validates the complete `StudySpec` and deterministic domain rules;
6. derives the public phase and allowed actions;
7. persists the new revision only if every check succeeds.

The model does not confirm a study, determine data feasibility, or create execution evidence.

## Public errors

| Code | Owner | Meaning |
| --- | --- | --- |
| `DESIGN_INVALID_INPUT` | Research Design | Request is malformed or contains disallowed content. |
| `DESIGN_SESSION_NOT_FOUND` | Research Design | The session does not exist or is not accessible. |
| `DESIGN_REVISION_CONFLICT` | Research Design | The caller acted on a stale revision. |
| `DESIGN_PROPOSAL_INVALID` | Research Design | Model output or its patch failed validation. |
| `DESIGN_NOT_READY` | Research Design | Confirmation requirements are incomplete. |
| `DESIGN_MODEL_UNAVAILABLE` | model dependency | The provider timed out, failed, or was disabled. |
| `DESIGN_STORAGE_FAILURE` | storage dependency | Session state could not be read or persisted. |

Errors expose a stable code, readable safe message, correlation identifier, and optional safe field paths. They do not expose prompts, provider payloads, credentials, or patient data.

## Side effects and state ownership

Research Design exclusively owns:

- current design-session revision;
- immutable prior revisions;
- confirmation status;
- idempotency records for state-changing requests;
- downstream invalidation events when a confirmed definition is revised.

Revising a confirmed study creates a new draft revision. It preserves history and invalidates downstream preflight and results by reference; it never edits a historical run artifact.

## Dependencies

- a model client behind a provider-neutral backend port;
- a versioned prompt registry;
- a design-session repository;
- a schema validator and controlled JSON Patch implementation;
- an event or explicit workflow callback for downstream invalidation.

The module does not expose any dependency's SDK types as its public contract.

## Configuration

Configuration enters through the backend's typed configuration entry point and may include:

- model profile and timeout;
- prompt version;
- maximum turns and request size;
- supported `StudySpec` schema versions;
- patch operation and path allowlists;
- retention policy.

Business code does not read environment variables, TOML files, or provider settings directly.

## Security and data boundary

- Accept research-design context only; reject patient-level rows and credentials.
- Do not log full user messages, prompts, model context, or model responses.
- Apply authentication and authorization to every session read or mutation.
- Treat all model output as untrusted input.
- Cap message, answer, patch, and session-history sizes.
- Keep public fixtures synthetic and label their provenance.

## Independent tests

1. Start from natural language and return a typed draft view.
2. Route clear association, prediction, and treatment-effect inputs to the matching design class.
3. Ask for clarification when association and treatment-effect meanings are both plausible.
4. Start from a template and enter the same validated lifecycle.
5. Apply a valid patch and increment the revision once.
6. Reject stale revisions without changing state.
7. Reject unknown patch operations and paths atomically.
8. Reject schema-valid but domain-invalid study definitions.
9. Prevent confirmation until deterministic readiness rules pass.
10. Confirm exactly one revision and produce a stable integrity identifier.
11. Revise a confirmed definition without mutating its history.
12. Normalize provider timeout, malformed output, and storage failure.
13. Verify logs and errors contain no prompt, credential, or patient-level content.
14. Verify prediction and treatment-effect designs are not presented as executable in the first slice.

Model calls are mocked for deterministic tests. A separately authorized provider smoke test proves only integration availability, not research validity.

## Connection tests

- Research Workspace UI renders each `ResearchDesignView` phase and submits only documented actions.
- Research Feasibility accepts a `ConfirmedStudySpec` and rejects drafts or unsupported schema versions.
- Research Workflow invalidates downstream references when a confirmed definition is revised.

## Completed implementation slice: confirmation lifecycle

The completed slice has one public outcome: a caller can confirm the exact ready revision and receive a stable `ConfirmedStudySpec` without another model call.

Implemented boundaries:

1. Add `ConfirmDesignRequest` to the TypeScript public request types and validate it against the existing request schema.
2. Extend the session aggregate so it owns phase, immutable revision records, and confirmation metadata.
3. Add an explicit repository confirmation operation that atomically compares the revision and prevents a second confirmation; revision saves also preserve the prior history prefix.
4. Add a deterministic confirmation service path. It rechecks the confirmed-association schema, rejects stale or incomplete revisions, records confirmation once, and returns `ConfirmedStudySpec`.
5. Derive `integrity_id` from a canonical serialization of the confirmed public payload with a versioned algorithm. Timestamps and request identifiers do not alter the identifier for the same confirmed revision.
6. Add primary, replay, concurrency, readiness, history, and storage-failure tests.

Verified acceptance cases:

- a ready current revision confirms without calling the model;
- an incomplete, unsupported-intent, stale, or missing session does not mutate state;
- retrying the same `client_request_id` returns the original result;
- reusing a request identifier with a different payload fails safely;
- two competing confirmations produce one stored confirmation;
- revision history remains readable and unchanged;
- `integrity_id` is stable for the same canonical confirmed revision;
- storage failures are normalized without exposing internals.

Subsequent backend slices added SQLite persistence, HTTP routes, the downstream feasibility connection, revision of a previously confirmed design, and integrity-scoped historical run lookup without changing this public service API. Authentication, frontend adapters, a real model provider, and real-data access remain outside the current MVP.

## Completed implementation slice: request idempotency

Every `start`, `continue`, and `confirm` request now has a canonical SHA-256 request fingerprint. The repository atomically stores the state mutation and its public result under one globally unique `client_request_id`.

Verified behavior:

- a completed retry with the same operation and payload returns the original result without calling the model again;
- the same identifier with different content or another operation returns `DESIGN_IDEMPOTENCY_CONFLICT`;
- a repeated `continue` does not add another revision;
- concurrent duplicate starts persist one session;
- concurrent duplicate continues persist one new revision;
- confirmation retains its existing atomic and replay guarantees.

Both repository adapters claim `start` and `continue` requests before model invocation. A concurrent duplicate receives `DESIGN_REQUEST_IN_PROGRESS`; after the first request completes, retrying the same payload replays the stored result. Claim expiry is typed runtime configuration. SQLite tests verify claim behavior and replay across repository reopen.

## Verified runtime configuration and prompt boundary

The application composition root provides one validated configuration object containing the selected product prompt identifier/version, model profile, timeout, request limits, supported schema versions, and retention policy. Precedence is `defaults < versioned < environment mapping < command-line mapping`. Research Design receives constructed dependencies; it does not know where configuration came from.

The prompt registry loads only explicitly registered `prompts/product/<capability>/current.md` assets. It returns a typed prompt asset to the model factory and rejects unknown or mismatched capability/version pairs. `prompts/governance/` is outside the runtime registry. Prompt loading, provider formatting, and model invocation remain outside domain rules and session state.

The selected prompt, model profile, timeout, retry policy, request limits, supported schema versions, retention, and claim TTL are connected and verified. JSON Schemas remain the canonical structural contracts; runtime policy supplies bounded operational limits.

## Completion evidence

- **Design agreed:** this boundary and public contract are accepted.
- **Implemented:** backend code and schemas exist, without claiming provider or end-to-end success.
- **Verified:** independent tests pass with deterministic model fixtures.
- **Contract frozen:** schema examples, compatibility note, and adjacent consumer contract tests pass.
- **Connected:** the named Research Feasibility connection and the synthetic end-to-end backend workflow pass; this does not prove real-data or production execution.

## Rollback or replacement boundary

The model provider, prompt version, storage implementation, validator, and patch library can be replaced behind internal ports. The public requests, `ResearchDesignView`, and `ConfirmedStudySpec` remain the compatibility boundary. A schema-version change requires an impact note and migration or explicit rejection behavior.

## Deferred decisions

1. Whether a baseline window is mandatory for every association study or becomes conditional on covariate definitions.
2. Authentication and ownership rules for a future multi-user runtime.
3. The real provider adapter and approved safety-database adapter, each requiring separate authorization and evidence.
