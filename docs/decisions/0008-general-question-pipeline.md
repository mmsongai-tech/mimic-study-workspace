# 0008. General question-to-report pipeline

- Status: accepted (direction), implementation in progress on `feature/general-question-pipeline`
- Date: 2026-09-23
- Decided by: project owner, with the coding agent's proposal

## Context

The staged pipeline (question → objectives → StudySpec → mapping → R execution → report) stopped at variable mapping
for every formal question. Diagnosis of the 2026-09-22 run showed that extracted items were kept as raw source
phrases (`使用美托洛尔`, `高血压患者`, `住院期间全因死亡`) and matched to English MIMIC dictionaries by literal
substring. The only bridge — the clinical term expander — failed on fenced model replies and was not wired at all in
local-model mode. A curated list of canonical concepts would fix individual questions but not the product goal:
**any question MIMIC can answer should go from idea to publication-style report; when MIMIC cannot answer, the
report must explain why.**

## Decision

Generalize on *structure*, not on a concept list.

1. **Study type + slots.** The model classifies each question into one of ten study types and fills fixed slots:

   | Study type | Required slots |
   |---|---|
   | descriptive | population, measure |
   | group_comparison | population, groups, outcome |
   | association | population, factor, outcome, adjusters |
   | treatment_effect | population, treatment, comparator, outcome, confounders |
   | time_to_event | population, groups, event, follow-up |
   | longitudinal_change | population, measure, time points |
   | dose_response | population, dose, outcome |
   | effect_modification | base study + modifier |
   | mediation | base study + mediator |
   | prediction | population, outcome, candidate predictors |

   Each slot is a general variable spec: `source_text, meaning_en, data_domain` (one of the eight MIMIC domains in
   `mimic-data-domain-catalog.ts`), `measurement` (presence/value/count/change/first/last/max/cumulative dose),
   `time_window`, and `qualifiers` (all-cause, never-used, in-hospital…). Qualifiers shape windows and comparators;
   only the clinical core is looked up.

2. **Dictionary-grounded mapping.** Retrieve candidates from the real dictionaries (`d_icd_diagnoses`,
   `d_icd_procedures`, `d_labitems`, `d_items`, prescription drug names) restricted to the slot's domain; the model
   re-ranks retrieved candidates with aggregate evidence (counts, units, ranges); the user confirms from the top 3.
   **The model never supplies codes** — measured on 2026-09-23, both llama3.1:8b and qwen2.5:14b invented ICD and drug
   codes. Confirmed mappings are persisted and reused; seed mappings are a cache, not a prerequisite.

3. **Answerability.** Every slot is `available`, `derivable`, `proxy_only`, or `unavailable`, backed by a versioned
   MIMIC limitations knowledge base. The question verdict is answerable / answerable with modifications (with a
   proposed rewritten question) / not answerable (with reasons). Every outcome produces a report.

4. **Three method options.** A registry keyed by study type × outcome structure offers one recommended and two
   alternative methods, each with data-driven readiness checks (events per variable, group sizes, positivity,
   missingness). The user chooses; implementations stay fixed and versioned in R.

5. **Standard TLF.** Flow diagram, Table 1 with SMD, main results, KM / forest / love plots as applicable,
   missing-data table, sensitivity analyses, and limitations generated from the answerability step (STROBE/RECORD).

Human checkpoints: confirm study frame, confirm mappings, choose method.

## Constraints agreed with the owner (2026-09-23)

- Local models only (no Router). Machine: 16 GB M1 Pro.
- New web app on port 9000; UI polish after the pipeline works.
- Reports in Markdown, Word (.docx) and .txt, bilingual Chinese/English.
- Approved: contract changes to objective/StudySpec/report; R packages MatchIt, WeightIt, cobalt, survival,
  survminer, mediation; python-docx. Each still needs a license check and lockfile update when added.
- Answer key: published MIMIC-IV papers (`backend/src/validation-fixtures/literature-benchmark/`).

## Consequences

- Objective and StudySpec contracts change (versioned; old versions stay readable).
- Mapping quality becomes measurable against the literature benchmark instead of hand review of each run.
- Derived concepts papers rely on (Sepsis-3, SOFA, Charlson, KDIGO) are not in the archive and must be implemented
  as versioned derived-concept definitions.

## Rollback

All work is on `feature/general-question-pipeline`; `main` is unchanged until the owner approves a merge.
