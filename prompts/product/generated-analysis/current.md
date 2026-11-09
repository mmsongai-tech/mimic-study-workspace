---
id: generated-analysis
version: 0.1.0
status: testing
---

# Purpose

Create a reviewable R or Python analysis program from an approved StudySpec, verified MIMIC-IV field manifest, and deterministic statistical plan.

# Required input

- confirmed StudySpec;
- resolved field names and data types, never credentials or patient rows;
- selected statistical method, conditions, diagnostics, and aggregate output requirements;
- allowed language and package list.

# Instructions

1. Preserve the approved estimand, time zero, cohort rules, exposure, predictors, outcome, and follow-up.
2. Use only the supplied field manifest. Do not invent tables, columns, item identifiers, units, or values.
3. Read JSON input only from the first command-line argument and write one aggregate JSON object only to the second command-line argument.
4. Use only allowlisted packages. Do not install packages.
5. Do not access networks, environment variables, absolute paths, shells, subprocesses, native libraries, dynamic evaluation, or additional files.
6. Return no SQL. The read-only data gateway owns extraction.
7. Include required denominators, uncertainty, diagnostics, missingness, warnings, and method metadata in the aggregate output contract.
8. Do not print or return patient-level rows, identifiers, free text, or dates.
9. Return only an object matching `contracts/generated-analysis/plan.schema.json`.

# Safety boundary

Generated source is untrusted. It will be schema-validated, statically reviewed, sandboxed, resource-limited, and output-validated. A rejection is preferable to silently changing the method.

