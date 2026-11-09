# Decision 0005: Additional clinical analysis capabilities

Status: accepted for synthetic implementation

## Context

The workspace presents three clinical research starters. Only the lactate association currently owns an executable statistical capability. Re-labeling that 2×2 association as prediction or treatment effect would be methodologically misleading.

## Decision

Add two independently testable business modules behind the existing confirmed-design, preflight, immutable-evidence, persistence, and export workflow.

### Invasive ventilation prediction

- Problem and value: estimate the risk of invasive ventilation within 24 hours of ICU admission.
- Responsibility: synthetic cohort loading, prespecified logistic prediction, deterministic internal train/test validation, discrimination, calibration, threshold performance, diagnostics, and publication outputs.
- Inputs: a confirmed prediction StudySpec and a matching supported preflight.
- Outputs: aggregate model performance, diagnostics, figures, tables, provenance, and warnings.
- Non-responsibilities: causal interpretation, clinical deployment, treatment recommendations, or real-data validation.
- Replacement boundary: its data gateway and R executor are independently replaceable.

### Early vasopressor treatment effect

- Problem and value: estimate the effect of vasopressor initiation within six hours on in-hospital mortality in a prespecified target population.
- Responsibility: synthetic cohort loading, propensity-score weighting, covariate-balance and positivity diagnostics, weighted risks and effect estimates, sensitivity summaries, and publication outputs.
- Inputs: a confirmed treatment-effect StudySpec and a matching supported preflight.
- Outputs: aggregate causal estimand results, diagnostics, figures, tables, provenance, and warnings.
- Non-responsibilities: treatment assignment, clinical recommendation, unmeasured-confounding removal, or real-data validation.
- Replacement boundary: its data gateway and R executor are independently replaceable.

## Shared connection

The workflow dispatches only by an allowlisted capability identifier returned by preflight. Analysis modules never access another module's gateway, executor, storage, or internal helpers. Run Evidence owns immutable aggregate artifacts; Report Export owns clinician-facing files; the UI only renders the returned capability contract.

Tomorrow's approved database connection replaces synthetic gateways only. Both modules already provide SQLite safety-database adapters that open in read-only/query-only mode, select only explicitly mapped fields, validate identifiers and row domains, and exclude unrelated columns. Tomorrow supplies the approved path and field mappings, then preflights those concepts before either executor can run.

## Acceptance

Each module must pass independent primary-path and rejection tests. Each starter must then pass create, confirm, preflight, R execution, persistence, recovery, chart/table generation, bilingual report export, and browser rendering with 1,000 deterministic synthetic records. Results remain labeled synthetic and non-clinical.
