# Multi-objective report

**Responsibility:** Combine the terminal results of one reviewed `ResearchObjectiveList` into one aggregate-only report without rerunning statistics or changing any child result.

**Input:** The reviewed objective list, its independent coverage review, and exactly one terminal result for every objective. A terminal result is either a `DynamicLocalRunBundle` or an explicit pre-execution block.

**Output:** A schema-versioned report with `completed`, `partial`, or `blocked` status, per-objective evidence references and aggregate statistical projections, Markdown, and independent reproducibility and integrity identifiers.

**Failure ownership:** The service rejects missing, duplicate, or unknown objective results. It preserves child blockers and diagnostic decisions and never upgrades a blocked child to a completed result.

**Security boundary:** Only aggregate cohort and analysis outputs are projected. The service does not accept patient rows, model prompts, credentials, archive paths, or executable query text.

**Replacement boundary:** The composite renderer can be replaced independently. Statistical execution remains owned by the single-objective workflow, and persistence or HTTP exposure can depend only on this module's public index.

**Verification:** Contract tests cover mixed completed/blocked results, schema validation, stable ordering and reproducibility, aggregate result projection, and fail-closed incomplete input.
