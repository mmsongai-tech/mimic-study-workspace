# Question pipeline (decision 0008)

Turns any research question into framed studies, MIMIC-IV mappings, cohorts, one of three registered statistical
methods, and bilingual reports. Built for small local models: the model answers short constrained questions; all
codes, windows, methods and statistics are deterministic and versioned.

## Flow

```text
question
  → study-framing      split (aim) → frame extraction (facets + slot phrases) → general rules → frames
                       slot normalization (English label + data category) via the term expander
  → compileStudyPlans  frame → StudySpec per exposure level (defaults written as assumptions)
  → variable-mapping   StudySpec concepts (English labels) → validated / dictionary-verified MIMIC mappings
  → execution-manifest catalog-verified manifest (+ first eligible admission, time-to-event rules)
  → study-protocol     target-trial protocol per plan (8 elements + design checks)
  ═ plan-draft.json    DRAFT: nothing above reads patient data
  ═ locked-plan.json   CONFIRM: chosen methods and exclusions, hashed with the draft (lock_id)
  → clinical-data      LocalExecutionGraphRunner.runMany: each archive table read once for all plans
  → study-analysis     3 options with readiness → confirmed method in R (study_methods.R)
  → result-checks      pass / warning / fail per check (config/result-checks)
  → study-report       zh + en × Markdown / text / Word, with mimic-limitations
```

A blocked or failed plan never stops the others. Every stop carries a stage-specific bilingual reason; frames that
need clarification are reported with what is missing.

## Draft, confirm, run unattended

1. **Draft** (`QuestionPipelineService.draft`, `--draft`): framing, compilation, mapping and frozen manifests, plus
   each plan's target-trial protocol and its three methods. Minutes; no patient data is read.
2. **Confirm** (`lockQuestionPlan`, `POST /api/runs/:id/confirm`): the user keeps or skips each plan and picks one of
   the three methods. The draft and choices are hashed into `lock_id`; an edited lock is rejected.
3. **Run** (`runLocked`, `--locked FILE`): cohorts for all confirmed plans are extracted in one pass, then the
   confirmed methods, result checks and reports. No model call and no re-mapping. If a confirmed method cannot run on
   the data, the first available method is used and the report says so.

On the workspace (port 9000) a question stops at *awaiting confirmation* with a review page; *run without review*
locks the recommended methods automatically. `--question` alone still runs end to end (a draft locked
automatically).

## Concept library and question rules

- **Validated concept library** (`config/mappings/mimic-iv-core.json` 1.5.0, built by `scripts/build-core-concepts.py`
  from mimic-code and published definitions; every item id checked against the dictionaries): 18 diagnosis code sets
  (sepsis, septic shock, cirrhosis, DKA, diabetes, AF, MI, stroke, heart failure, AKI, CKD, COPD, pneumonia, ARDS,
  acute pancreatitis, lung cancer, smoking), 18 vital signs, labs and infusion rates with plausible ranges,
  vasopressors, norepinephrine, propofol, ventilation, CRRT and renal replacement, CAM-ICU delirium, systemic
  hydrocortisone, ICU length of stay and emergency admission. Drug classes in `config/drug-classes` (1.4.0): a class is
  every prescription label containing a member ingredient, except labels naming a locally applied form (ointment,
  cream, gel, eye/ear drops, nasal, rectal, vaginal, rinse; whole words, so "Oint" counts) unless that form is the
  class's own route (`counted_local_forms`: eye forms for ophthalmic beta blockers, rectal for laxatives, nasal and
  rectal for opioids). Labels with no form word are not caught by this rule. An exact label or synonym match outranks
  a smaller code set.
- **Phrase rules** (`study-framing/frame-rules.ts`): aggregation and time words are split off measured concepts
  (最高乳酸 → lactate, maximum); bracketed lists become separate levels; `A/B` levels are ratios computed per patient;
  generic predictor phrases expand to 15 first-day features; outcome cut-offs (≥75 小时) become threshold outcomes;
  duplicate aims are merged; English questions use the English extraction prompt.
- **Answerability** (`config/mimic-limitations` 1.2.0): outpatient/community populations stop with the reason; death
  follow-up beyond one year is analysed to one year.

## Design options (confirmed per plan)

| Option | Offered when | Default |
|---|---|---|
| 24-hour landmark | event outcomes would count during the 0–24 h exposure window | on |
| Illness severity | treatment comparisons | emergency admission, vasopressors, invasive ventilation, highest creatinine on; lactate off |

Unmappable severity variables are dropped with a note. The locked run applies the choices (landmark on the frozen
manifest, switched-off variables out of the model) and the protocol shows what ran, in English and Chinese.

A prediction of a timed event is not offered the landmark as a choice: it is always made at its prediction time, the
end of the predictor window (compiler 1.5.0). The compiler starts the outcome window there (6–48 h for "within 48 hours
using the first 6 hours") and says so in the assumptions; the extractor excludes units discharged or dead before it
(`ended_before_landmark`) and units with a dated outcome record before it, after time zero or earlier in the same
encounter (`outcome_before_prediction_time`; with an ICU index, an outcome on the ward before the stay), so an outcome that
happens while the predictors are measured, or was already present, is never predicted. A landmark design excludes in the
same way a unit whose timed event outcome is recorded before the landmark (`outcome_before_landmark`; a death timed
before the landmark although the discharge time is later), instead of following it as event-free. A record of another
admission of the patient before time zero is history and excludes no one.
An undated outcome (a diagnosis code) cannot be placed in time and keeps the `outcome_timing` warning. The protocol
reports this as the `outcome_after_prediction_time` design check; treatment designs keep `outcome_after_exposure` and
`baseline_before_exposure`.

## Literature benchmark

`node --import tsx backend/src/entrypoints/literature-benchmark-score.ts --runs map.json` scores finished workspace
runs of the 40 cases against the papers (cohort size, direction, CI overlap) and writes bilingual Markdown and JSON to
`.local/benchmark/<date>/` (MIMIC-derived aggregates; not committed).

## Study types and method options

| Study type | Recommended | Alternatives |
|---|---|---|
| descriptive | Table 1 and overall rates | rates with exact CI by group; group rates with test |
| group comparison | chi-square/Fisher or t/Wilcoxon | adjusted regression; modified Poisson / robust SE |
| association | adjusted logistic / linear | modified Poisson (RR) / robust SE; unadjusted test |
| treatment effect | IPTW | 1:1 PSM; outcome regression |
| time to event | adjusted Cox | KM + log-rank; IPTW Cox |
| longitudinal change | ANCOVA on change (or IPTW for treatments) | robust SE; unadjusted |
| dose-response | restricted cubic spline | quartiles + trend; linear per unit |
| effect modification | interaction + stratified | stratified only; IPTW interaction |
| mediation | causal mediation (quasi-Bayesian) | product of coefficients; difference + bootstrap |
| prediction | logistic (held-out AUC, calibration) | LASSO; spline logistic |

## Commands

```zsh
OLLAMA_MODELS="$HOME/.mimic/local-models" ollama serve &
MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip node --import tsx backend/src/entrypoints/question-report-run.ts --formal 1
MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip node --import tsx backend/src/entrypoints/question-report-run.ts --question "..." --method treatment.psm
MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip node --import tsx backend/src/entrypoints/question-report-run.ts --question "..." --draft --out DIR
MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip node --import tsx backend/src/entrypoints/question-report-run.ts --locked DIR/locked-plan.json --out DIR
MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip node --import tsx backend/src/entrypoints/question-workspace-server.ts   # http://127.0.0.1:9000
node --import tsx backend/src/entrypoints/study-framing-benchmark.ts            # framing score on the 40 literature cases
zsh scripts/setup-report-runtime.zsh                                              # Word output (REPORT_PYTHON=... if needed)
```

Outputs go to `.local/question-runs/<timestamp>/` (git-ignored): `run.json`, `report.{zh,en}.{md,txt,docx}` and
`analyses/<plan>/<method>/` figures. Patient-level rows exist only in a 0600 temporary CSV during an R run and are
always deleted.

## Versions

StudySpec compiler 1.4.0, method registry 1.0.0, R method library 1.1.0, study protocol 1.0.0, result-check rules
1.1.0, limitations knowledge 1.2.0, drug classes 1.1.0, prompts `study-question-split` 1.0.0,
`study-frame-extraction` 1.0.0, `study-frame-extraction-en` 1.0.0, `variable-mapping` 0.3.0, mapping pack 1.5.0.
