# What the platform answers, and what it does not / 平台能回答什么，不能回答什么

**One sentence / 一句话：** for a question the data can support, the platform gives a reproducible analysis with checks and limits; for a question it cannot support or is unsure of, it says so and gives the reason. Not returning a wrong answer silently is the design goal, not a guarantee: silent errors have been found and fixed several times (recorded in the internal progress log), and some paths remain open (for example a code set chosen from code prefixes the model suggests).
对数据能支持的问题，给出带检查和局限的可复现分析；对不能支持或不确定的问题，明确说明原因。不悄悄给出错误答案是设计目标而不是保证：已多次发现并修复隐蔽错误（见进度日志），仍有未解决的路径（例如由模型建议的编码前缀选出的编码集）。

## In scope / 范围内

A question is in scope when **all four** hold / 同时满足四条才在范围内：

1. **A study form the engine runs / 引擎支持的研究形式**
   - Association or comparison of an exposure with an outcome, with adjustment: drug versus no drug, drug versus drug, a level or score of a measurement, a change in a measurement, subgroup and sex interaction, dose or level response, mediation.
     Client release pilot-1 does not offer dose-response, effect modification and mediation (set by `question_scope.allowed_study_types` in `backend/src/runtime/runtime-config.ts`); such an aim is reported unanswered with the reason. / 客户版 pilot-1 不提供剂量-反应、效应修饰和中介分析，此类目标会注明原因、不做分析。
   - Prediction of a yes/no outcome from baseline variables (with a baseline comparison and cross-validation). A numeric, count or time-to-event prediction stops at planning with the reason.
   - Description of a cohort: counts, patient flow, Table 1 (overall or by group) and the proportion or mean of each listed characteristic. A diagnosis is described as the share of admissions with the code recorded; diagnosis codes carry no date, so this is not incidence (new onset).
2. **Patients in MIMIC-IV / 人群在 MIMIC-IV 内：** adults admitted to this one hospital (2008–2022), identifiable by diagnosis codes, age, sex, admission or ICU stay.
3. **Variables recorded in MIMIC-IV / 变量在 MIMIC-IV 里有记录：** laboratory results, vital signs (ICU only), prescriptions and administrations, procedures, diagnosis codes (undated), demographics, death date, and the derived layer (acute kidney injury, eGFR, readmission, first-day SOFA, OASIS and SAPS II, Sepsis-3 at ICU admission, temperature in Celsius, organ-support duration, variability). A variable the platform does not yet know (a drug, a laboratory item, a diagnosis code set, a ratio or a formula) is defined in the Variables page from the archive's dictionaries; it passes six automatic checks and is marked as unreviewed until the team or a clinician reviews it (docs/decisions/0009). A new score or derived-layer variable still needs a developer and clinician review.
4. **A time anchor / 有时间起点：** hospital admission or ICU admission, with windows the researcher can confirm.

Within scope, the platform always returns one of three things, never silence / 范围内的结果只有三种，不会无声：
- a result with its checks and reading limits;
- "not reliably estimable" with the raw counts (too few patients or events);
- a stop with the reason (a variable not found, a definition that needs confirmation).

**It cannot promise that every in-scope question gets an estimate or that the first reading of the question is right.** A small model misreads some questions, so the plan is shown for confirmation before any patient data is touched, and the share of questions answered directly is measured on questions we did not tune on (see the literature test).
范围内也不能承诺每个问题都出估计、也不能保证第一次就读对；所以先出计划让研究者确认，且用没调过的问题来衡量直接可答的比例。

## Out of scope: examples / 范围外：举例

| Kind | Example question | Why |
|---|---|---|
| Imaging | Chest CT edema grade and outcome | MIMIC-IV core tables hold no images or their readings |
| Echo and reports in free text | Left ventricular ejection fraction below 40% and outcome | Not structured in the tables used |
| Patient-reported outcomes | Quality of life, pain as the patient felt it after discharge | Not recorded |
| Genetics and lifestyle | A gene variant, smoking pack-years, diet | Not recorded (smoking is a coarse flag at most) |
| Tumour response | Progression-free survival, RECIST response | Not recorded |
| Children | Neonatal or paediatric outcomes | Adults only |
| Other hospitals | Readmission to another hospital, follow-up beyond about one year | One hospital; death follow-up is limited (readmission to this hospital within 30, 90 or 365 days is answered, with that caution) |
| Exposure before admission | "Statin use before ICU admission", home medication | MIMIC-IV records drugs given in hospital; there is no outpatient medication history; the platform reads exposures after time zero |
| Recommendations and causes | "Should this drug be used?", "does it cause…?" | The platform reports association, not a clinical recommendation |
| Other populations | Does this hold in China or in primary care? | One US hospital; no external validation |
| Under-specified questions | "Is drug X effective?" with no outcome or comparator | The platform offers up to three readings of the vague outcome (config/clarifications); the researcher picks one and the question is planned again. A batch test can pick for them (`clarify: first` or `random` on POST /api/runs); the run records the reading and who chose it. Without a choice the aim stops. |
| Not built yet | APS III, hourly or time-varying SOFA and Sepsis-3 onset later in a stay, time-varying treatment sequences, trajectories | Possible, not built; each needs a definition and clinician review |

## Known limits that apply inside the scope / 范围内仍有的限制

Diagnosis codes carry no date, so a diagnosis outcome reads as association with a diagnosis of the same admission, not new onset. Blood pressure and pain scores are read only from ICU charting (the archive also holds outpatient blood-pressure readings in hosp/omr, which the platform does not use). Only readmission to this hospital is seen. Observational data: confounding by indication cannot be removed. Concept pack, derived definitions and drug catalogue have not been reviewed by a clinician. Prediction models have no external validation.
