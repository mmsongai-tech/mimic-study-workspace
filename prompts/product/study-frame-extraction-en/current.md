---
id: study-frame-extraction-en
version: 1.0.0
status: testing
---

---
id: study-frame-extraction
version: 1.0.0
status: testing
---

You read one sub-question of a clinical research question and fill a study frame. The full original question is given for context only. `aim` tells you whether the sub-question is a main aim, an effect-modification aim or a mediation aim.

Fields:
- goal: describe (rates, patterns, characteristics), compare_groups (differences between naturally defined groups such as sex, race, age groups), relate_factor (a factor, biomarker, score or condition related to an outcome), evaluate_treatment (a drug, therapy or procedure versus none or an alternative), predict (build or test a model that predicts an outcome).
- outcome_kind: event (yes/no event such as death), time_to_event (survival or time until an event), value (a measured value such as length of stay or a lab value), change_over_time (change, trajectory, reduction or repeated measurements over time), count, none (descriptive questions without an outcome).
- dose_question: true only when the question asks about dose, amount, level-response or cumulative quantity.
- population: the patient group, copied as a short phrase from the question.
- exposure: what the exposed or treated group has or receives (the treatment, factor, biomarker or grouping variable), copied as a short phrase. Never use the comparator's concept here and never include negation words. When the question lists alternatives ("A或B", "A or B"), put the whole phrase here and each alternative in exposure_categories.
- exposure_categories: named levels or classes of the exposure listed in the question (for example several drug classes); otherwise [].
- comparator: the comparison group phrase exactly as written (for example "without metformin", "placebo", "women"); "" if not stated.
- outcomes: every outcome phrase, one per item. Split lists such as "30-day mortality and length of stay" into separate items.
- composite_outcome: the name of a composite outcome when the question defines one (for example "MACE"), else "". Its parts go in outcomes.
- modifiers: variables said to change or modify the effect; else []. When aim is effect_modification, modifiers must not be empty: the factor whose levels are compared (for example "sex" for "does it differ between men and women") is the modifier, and exposure and outcomes are those of the effect being modified.
- mediators: variables the effect is said to pass through; list each named aspect separately; else []. When aim is mediation, mediators must not be empty.
- predictors: candidate predictor variables for predict goals; else [].
- time_window: the time frame as written (for example "30-day", "within 24 hours of ICU admission"); "" if not stated.

Rules: the question is in English. Copy every phrase from the question in English, word for word; never translate and never shorten a disease or drug name. Use "" or [] rather than guessing. Never select tables, codes or statistical methods.

Examples:
Sub-question (aim main): What are the 30-day mortality and length of stay of diabetic patients treated with metformin compared with those without metformin?
{"goal":"evaluate_treatment","outcome_kind":"event","dose_question":false,"population":"diabetic patients","exposure":"metformin","exposure_categories":[],"comparator":"without metformin","outcomes":["30-day mortality","length of stay"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":[],"time_window":"30-day"}

Sub-question (aim effect_modification): Does age modify the association between early lactate and in-hospital death in patients with sepsis?
{"goal":"relate_factor","outcome_kind":"event","dose_question":false,"population":"patients with sepsis","exposure":"early lactate","exposure_categories":[],"comparator":"","outcomes":["in-hospital death"],"composite_outcome":"","modifiers":["age"],"mediators":[],"predictors":[],"time_window":"early"}

Sub-question (aim main): What is the in-hospital mortality of patients admitted with acute pancreatitis, by sex?
{"goal":"compare_groups","outcome_kind":"event","dose_question":false,"population":"patients admitted with acute pancreatitis","exposure":"sex","exposure_categories":[],"comparator":"","outcomes":["in-hospital mortality"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":[],"time_window":""}

Sub-question (aim main): Predict in-hospital death in patients with acute respiratory failure using vital signs and laboratory values from the first ICU day.
{"goal":"predict","outcome_kind":"event","dose_question":false,"population":"patients with acute respiratory failure","exposure":"","exposure_categories":[],"comparator":"","outcomes":["in-hospital death"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":["vital signs","laboratory values"],"time_window":"first ICU day"}

Sub-question (aim main): Does blood glucose change over the first 72 hours differ between patients with and without insulin infusion in diabetic ketoacidosis?
{"goal":"evaluate_treatment","outcome_kind":"change_over_time","dose_question":false,"population":"patients with diabetic ketoacidosis","exposure":"insulin infusion","exposure_categories":[],"comparator":"without insulin infusion","outcomes":["blood glucose"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":[],"time_window":"first 72 hours"}

Sub-question (aim main): Is octreotide or somatostatin, compared with patients without either drug, associated with length of stay in acute pancreatitis?
{"goal":"evaluate_treatment","outcome_kind":"value","dose_question":false,"population":"acute pancreatitis","exposure":"octreotide or somatostatin","exposure_categories":["octreotide","somatostatin"],"comparator":"patients without either drug","outcomes":["length of stay"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":[],"time_window":""}
