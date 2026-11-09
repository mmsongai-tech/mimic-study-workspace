# Research Workspace module card

Status: connected synthetic and local-archive MVP  
Evidence level: L4 browser, HTTP, and approved local demo-input verification

Visual direction: the layout intentionally preserves the strongest interaction patterns from the read-only legacy mother UI—persistent study navigation, connection status, a focused research-question entry, staged review, and evidence-first results. No legacy result cache, business rule, database state, private path, or framework dependency is imported.

## Responsibility

The Research Workspace guides one local user through a research question, structured design review, explicit confirmation, execution, and evidence inspection. With `MIMIC_LOCAL_ARCHIVE` configured, it renders aggregate-only evidence from the local read-only archive; otherwise it retains the explicitly labeled synthetic workflow.

It does not classify intent, determine readiness, match data capabilities, calculate estimates, rewrite backend errors, or label an execution as real. Those decisions remain in backend modules.

## Public inputs and outputs

The browser calls only versioned HTTP endpoints:

- `POST /v1/research-design/sessions`
- `POST /v1/research-design/sessions/{session_id}/confirm`
- `POST /v1/research-runs`

It renders `ResearchDesignView`, `ConfirmedStudySpec`, and `RunEvidenceBundle` responses without importing backend internals. Report Markdown is displayed as text, not executable HTML.

## State and failure ownership

Browser state contains the selected language and the current public responses. Durable sessions and artifacts remain owned by SQLite backend repositories. Safe backend error code and message pairs are shown in a local alert; unknown browser failures use a generic retry message.

## Security and data boundary

- Static files are served from an explicit allowlist with a same-origin Content Security Policy.
- No third-party script, font, analytics, or network dependency is loaded.
- The current page accepts research questions, not patient rows or credentials.
- The active synthetic or local-MIMIC mode, provenance, denominator, and archive digest are visible with the result.

## Verification

- JavaScript syntax checks cover every browser module.
- A real HTTP test verifies the workspace document, security headers, application module, and the complete design-to-result API connection on one server.
- Browser verification covers Chinese and English, confirmation, execution, aggregate counts, uncertainty, evidence integrity, and responsive layout.

## Replacement boundary

The browser implementation can later be replaced by a framework application or audited components from the previous UI. The versioned HTTP contracts and backend ownership rules remain the connection boundary.
