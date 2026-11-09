# Research protocol assessment

## Module card

**Problem and user value:** A schema-valid draft can still omit the scientific definitions needed for a reviewable protocol.

**Primary responsibility:** Deterministically identify missing or inconsistent research-purpose, population, time-zero, input, outcome, outcome-structure, time-window, estimand, and analysis-family definitions. Return questions with reasons and field paths.

**Non-responsibilities:** The module does not answer its own questions, infer source fields, select statistical methods, or determine scientific validity.

**Public input/output:** A `StudySpec` produces a complete or needs-clarification assessment containing required and recommended requirements.

**Failure ownership:** Missing and inconsistent definitions are protocol-domain results. They are not model or database failures.

**State and side effects:** Deterministic, stateless, and no I/O.

**Independent tests:** Complete protocol, ten required definitions, role consistency, invalid windows, and non-blocking recommendations.

**Connection status:** The assessment is connected to candidate readiness and confirmation. Candidate-ready proposals with missing required definitions return clarification questions through the existing API, and confirmation repeats the deterministic gate. Recommended items remain visible, non-blocking warnings. Ordinary drafts are not flooded with questions before the model declares them candidate-ready.

**Rollback boundary:** Remove the assessment domain file, its export, tests, and this document without affecting stored sessions.
