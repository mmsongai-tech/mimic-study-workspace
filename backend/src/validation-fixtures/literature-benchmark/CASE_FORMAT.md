# Literature benchmark case format (one JSON array of objects)

{
  "id": "lit-<study_type_short>-<nn>",
  "citation": { "title": "", "first_author": "", "journal": "", "year": 2024, "pmid": "", "pmcid": "", "doi": "", "url": "" },
  "mimic_version": "MIMIC-IV v2.2 (as reported, or 'not reported')",
  "question_en": "Researcher-style question, paraphrased in your own words (<= 40 words)",
  "question_zh": "Natural Chinese phrasing a Chinese clinician would type (your own translation)",
  "study_type": "descriptive | group_comparison | association | treatment_effect | time_to_event | longitudinal_change | dose_response | effect_modification | mediation | prediction",
  "outcome_structure": "binary | continuous | count | time_to_event | repeated_measure | competing_risk",
  "analysis_unit": "patient | hospital_admission | icu_stay",
  "population": {
    "description": "",
    "inclusion": ["..."], "exclusion": ["..."],
    "definitions": [ { "concept": "sepsis", "data_domain": "diagnoses|laboratory|bedside_measurements|medications|procedures|encounters|demographics|microbiology|derived", "source_tables": ["mimiciv_hosp.diagnoses_icd"], "codes": { "system": "ICD-9|ICD-10|itemid|drug_name|derived_concept", "values": ["..."] }, "rule": "e.g. first ICU stay, age>=18, Sepsis-3 via mimic-code derived table" } ]
  },
  "exposures_or_predictors": [ { "name": "", "role": "exposure|predictor|comparison_group", "definition": "", "data_domain": "", "source_tables": [], "codes": { "system": "", "values": [] }, "measurement": "presence|value|first|max|mean|cumulative_dose|change|category", "time_window": "e.g. first 24h of ICU stay", "comparator": "" } ],
  "outcomes": [ { "name": "", "primary": true, "definition": "", "data_domain": "", "source_tables": [], "codes": { "system": "", "values": [] }, "time_window": "e.g. 28 days from ICU admission" } ],
  "covariates": ["age", "sex", "SOFA", "..."],
  "effect_modifiers": [], "mediators": [],
  "methods": { "primary": "e.g. PSM + logistic regression", "secondary": ["IPTW", "multivariable Cox"], "sensitivity": ["E-value"], "missing_data": "e.g. multiple imputation" },
  "results": { "cohort_n": 0, "group_ns": { "exposed": 0, "unexposed": 0 }, "events_n": null,
               "primary_estimate": { "measure": "HR|OR|RR|RD|mean_difference|AUC|beta|other", "value": 0, "ci_low": 0, "ci_high": 0, "p": null } },
  "reported_limitations": ["short paraphrase, e.g. no outpatient medication data"],
  "tlf_reported": ["flow diagram", "Table 1", "KM curve", "forest plot", "love plot", "ROC curve", "calibration plot", "RCS plot"],
  "extraction": { "source_section_checked": ["abstract","methods","results","supplement"], "confidence": "high|medium|low", "not_reported": ["fields that the paper did not report"], "notes": "" }
}

Rules:
- Only MIMIC-IV studies (any version). Not MIMIC-III, not eICU-only. Multi-database papers are fine if MIMIC-IV results are reported separately.
- Prefer open-access full text (PubMed Central) so codes/itemids in methods/supplements can be checked.
- Record facts only. Do NOT copy sentences from papers; paraphrase. No quotations longer than a few words.
- Never invent codes, itemids, Ns, or estimates. If not reported, use null / empty and list the field in extraction.not_reported.
- Prefer papers that report concrete code lists or itemids and a clear primary estimate with CI.
- Diversity: vary clinical areas (cardiology, sepsis, renal, neuro, respiratory, pharmacology, lab markers, scores).
