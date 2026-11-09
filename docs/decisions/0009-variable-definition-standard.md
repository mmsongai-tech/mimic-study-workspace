# 0009 One standard for defining variables, used by developers and researchers / 变量定义的统一标准

Status: approved by the project lead 2026-10-20 ("we do need this now"). Steps 1, 2, 3 and 5 are built (2026-10-21); step 4 has a first version in `frontend/question-workspace-app` (Variables page, "Define this variable" on blocked plans), not yet merged into the served build.

## Problem / 问题

A variable the platform does not know today is added in one of three different ways, by a developer: a Python script for the derived layer (`scripts/derived/*.py`), a line in the concept-pack generator (`scripts/build-core-concepts.py`), or an entry of the drug catalogue. Each has its own format, its own checks and its own place in the review. The literature test (20 published papers) stopped on 7 questions for exactly this reason: a drug, a laboratory item or a formula (dexmedetomidine, anion gap, ePVS) was not defined. Developers cannot add every variable a researcher will ask for, so a researcher must be able to add one, safely.

## Decision / 决定

Every variable, whoever adds it, is one **variable definition**: a declarative record, not code. It is validated by the same checks, shown in the same plan screen, and carries a review status that the report prints.

### The definition (kinds, not free code)

| Kind | A researcher writes | Example |
|---|---|---|
| `lab_or_chart` | the dictionary items (picked from a search of `d_labitems` / `d_items`, never typed ids), unit, plausible range, aggregation | anion gap = lab item "Anion Gap" |
| `drug` | ingredient names or a drug class; routes to include or exclude; source (prescriptions, inputevents) | dexmedetomidine, all systemic routes |
| `diagnosis` | code sets for ICD-9 and ICD-10 (picked from `d_icd_diagnoses`), primary-only or any position | type 2 MI = I21.A1 |
| `procedure_or_event` | item/procedure codes | enteral feeding items |
| `ratio` | numerator and denominator, each an existing definition | CRP ÷ albumin |
| `formula` | a short arithmetic expression over named existing definitions, and nothing else (+ − × ÷, constants, min, max, log) | ePVS = (100 − Hct) ÷ Hb ; SHR = glucose ÷ (1.59 × HbA1c − 2.59) |
| `threshold` | an existing definition, an operator and a value | creatinine ≥ 1.5 |
| `score` | a table of points over existing definitions | not for researchers at first (developer only) |

Each definition also states: window (baseline, first 24 hours, whole stay, before ICU admission), missing-value rule, name and synonyms (Chinese and English), and a one-line clinical meaning.

No free code is accepted: the analysis engine runs only what these kinds express. This is what keeps researcher-made variables from producing silently wrong results.

### Automatic checks before a definition can be used / 使用前的自动检查

1. **Resolves to real items**: every item or code exists in the dictionary; a code or name that matches nothing is rejected.
2. **Counts**: the number of patients and rows that carry it in the archive, shown to the researcher ("1,204 patients, 31,022 rows"). Zero rows is an error.
3. **Distribution**: median, 1st and 99th percentile and the share outside the plausible range; a unit mix (Fahrenheit and Celsius) is flagged.
4. **Name collision**: its names must not equal or contain a name of another definition (the pack-wide resolution test, run on the new definition only).
5. **Fidelity**: the definition's own names must carry every word of its label (the same rule that now stops a plan from dropping "type 2").
6. **Ratio and formula parts** must each be an existing definition with a status at least as high as the new one.

### Status and where it shows / 状态与展示

`researcher_defined` (private to the workspace, can be used at once, always printed in the report as "defined by the researcher, not clinician-reviewed") → `team_reviewed` → `clinician_confirmed` → `validated` (the existing ladder). Promotion changes the status and the review note of the definition and therefore raises its patch version; a changed definition is a new version. A researcher-defined variable is never merged into the shared pack without a reviewer.

### Where it is stored

One folder of JSON files `config/variables/` (shared, reviewed) and one per workspace (`.local/…/variables/`, private). The concept-pack generator, the derived layer and the drug catalogue become *readers* of this folder in turn; a definition that needs a precomputed layer (SOFA, Sepsis-3, OASIS) stays developer-built, and says so ("needs derived layer").

## Researcher interface / 研究者界面

1. On a plan with an unmapped, "broader than asked" or wrong variable, the row shows **Define this variable** and **Replace mapping**.
2. *Replace mapping*: search the dictionaries by name, tick items, see counts, save. Used for this run only, or saved to the workspace.
3. *Define this variable*: choose a kind, fill the fields above, press **Check**; the six checks and the counts appear; **Use in this question** or **Save**.
4. The report prints every researcher-defined variable with its definition table.

## What this fixes in the literature test

| Question | Missing | Kind |
|---|---|---|
| L06 | dexmedetomidine, other sedatives | drug |
| L07, L18 | anion gap | lab |
| L11 | CRP | lab |
| L13 | ePVS | formula |
| L10 | SHR, HbA1c | formula, lab |
| L16 | enteral nutrition | procedure_or_event |
| L18 | vasopressin | drug |
| L20 | vitamin D | drug |
| L02, L15, L17 | type 2 MI, survivors of type 2 MI, sepsis with myocardial injury | diagnosis + population conjunction |

## Build order / 顺序

1. Definition schema, validator (the six checks) and a command-line loader; port 10 existing hand-written entries to prove the format; tests.
2. Resolver reads the folder; fidelity rule applies to it.
3. API: search dictionaries, check a definition, save to workspace.
4. Interface in the plan screen.
5. Fill the 7 literature gaps through the same path (this is the test that the standard works).

Not decided here: scores with points tables for researchers, and sharing researcher definitions between workspaces.
