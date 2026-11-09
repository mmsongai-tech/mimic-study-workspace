# What we built and why: design highlights of the MIMIC research platform / 平台设计要点

**Aim / 目标:** a researcher types a clinical question in plain Chinese or English and receives a reproducible MIMIC-IV analysis report with
conclusions, checks and limits. The platform provides analysis reports, analysis information and conclusions; it does not write papers.
研究者用中文或英文输入临床问题，得到可复现的 MIMIC-IV 分析报告、分析信息和结论及其局限；平台不负责写论文。

**Evidence level / 证据等级:** all results are L4 engineering evidence (reproducible runs on the full MIMIC-IV 3.1), not clinical findings.
所有结果均为 L4 工程证据（在 MIMIC-IV 3.1 全量数据上可复现），不是临床结论。

## 1. The core idea: the model plans, rules and code compute / 核心思路：模型只做规划，计算由规则和代码完成

A small local language model (7B, runs offline on a laptop) reads the question, but it never produces numbers. Everything after the plan is deterministic.
本地小模型（7B，离线）只负责理解问题，不产生任何数字；规划之后的所有步骤都是确定性的。

| Step | What happens | Why it matters |
|---|---|---|
| Split / 拆题 | One question becomes several research aims (e.g. "A and B in patients with C" → separate analyses) | Multi-part questions are answered part by part, not forced into one model |
| Frame / 结构化 | Population, exposure, comparator, outcome, time windows are extracted by model **plus** rules (`frame-rules.ts`) | Rules catch what a small model gets wrong; the same rules apply to every question, with no special case for a single example |
| Compile / 编译 | The frame becomes a formal study specification (a typed contract) | The analysis is defined independently of the model, so a different model gives the same analysis for the same plan |
| Map / 变量映射 | Every term is mapped to MIMIC fields: a curated concept pack, a drug-class catalogue and a live search of the MIMIC dictionary | Variable definitions are listed in full (every code, drug label, item id) and can be reviewed |
| Plan confirmation / 计划确认 | The researcher sees the plan, assumptions and anything the model translated or could not find, and confirms or changes options | Nothing touches patient data before a human has read the plan |
| Run / 运行 | A local graph runner scans the archive once; R computes the statistics | Same numbers on every machine |

## 2. Honesty by design / 把"诚实"做进设计

- **Question-capability boundary / 能力边界:** a machine-readable list of what MIMIC cannot answer (imaging, patient-reported outcomes, genetics, children, tumour progression, readmission elsewhere…). Such questions stop with the reason instead of returning a plausible-looking wrong answer.
  MIMIC 回答不了的问题带着原因被拦下，而不是给出看似合理的错误答案。
- **Marked translation / 标注模型翻译:** a drug or concept the model had to translate itself is flagged in the plan; catalogued terms are marked as catalogued.
- **Silent-error fixes found by testing / 测试中发现并堵住的静默错误:** "no treatment" read as a drug named "non-use"; "without prostatic hyperplasia" dropped from the population; a predictor window mistaken for the outcome follow-up. Each now has a rule and a regression test.
- **Result checks / 结果检查:** every estimate carries checks (sample size, events per variable, balance, extreme values, outcome timing, prediction coverage…). Informational checks do not turn the trust badge to warning; real problems do.
- **"How far to read it" / 解读边界:** each result states in plain words what it can and cannot support.
- **Unreliable estimates are not shown as numbers / 不可靠的估计不显示成数字:** a degenerate or sparse model shows "not reliably estimable" with the raw counts, plus a Firth penalised estimate as a stable alternative.
- **Multiplicity and bias / 多重比较与偏倚:** Holm correction across the analyses of one question (identical analyses counted once) and E-values for unmeasured confounding.

## 3. The researcher chooses the design, not the model / 设计选项由研究者确认

At plan confirmation the researcher can lock design options: landmark time, severity strata and **time options** (exposure window 6/12/24/48/72 h, end of follow-up for change outcomes, outcome horizon). A chosen time re-times every window consistently (cohort, protocol, report) through one function (`retimeWindows`). In testing, we confirm them ourselves.
研究者在确认计划时选择界标时间、严重程度分层和时间选项；所选时间一致地应用到队列、方案和报告。

## 4. The derived-variable layer / 推导变量层

MIMIC has no ready-made "acute kidney injury", "eGFR", "SOFA" or "readmission". We compute them once from the archive into an events table, which the engine then reads like any other MIMIC table; so time windows, options and checks apply unchanged. Adding a variable means adding a definition, not changing the engine. Details and known limits: [DERIVED_VARIABLES.md](DERIVED_VARIABLES.md).
推导变量一次性算好，再当作普通表读取，新增变量不需要改分析引擎。

Covered: KDIGO acute kidney injury, eGFR (CKD-EPI 2021), readmission (any cause, or for a given diagnosis; 30/90/365 days), history of a diagnosis, first-day SOFA with components, organ-support durations, ventilator-free days, and variability (standard deviation) of blood pressure, heart rate, respiratory rate and glucose.

## 5. Analysis methods chosen automatically / 方法自动选择

The method follows the outcome type and design (logistic, Cox, linear, Poisson, interaction, mediation, prediction), with a stated reason and an alternative the researcher can switch to.
Prediction questions: background-only baseline model, AUC with DeLong comparison, 5-fold cross-validation, multiple imputation where data are missing (outcome excluded from the imputation; the baseline is scored on the same patients), and a coverage check that warns when the predictors are measured for too few patients.
预测题：基线模型对比、DeLong 检验、5 折交叉验证、多重插补，并检查预测变量的覆盖率。

## 6. Reports for people / 面向人的报告

Bilingual Word, Markdown and text reports per question: the plan, patient flow, Table 1, figures, estimates with checks, assumptions, limits and the full variable definitions. Each question is rated A (reportable with stated limits), B (exploratory) or C (no result yet) by judgement, not by computation.
中英文双语报告；每题有可用性等级（A 可报告须附限制，B 仅作探索，C 暂无结果）。

## 7. Built to be moved and tested / 可迁移、可复测

- One setup script from clone to running ([SETUP_NEW_MACHINE.md](SETUP_NEW_MACHINE.md)); a fresh clone reproduced the main-machine numbers exactly.
- A 39-question planning regression set with a snapshot: change the model and compare plans against the baseline.
- The model is replaceable (section 7 of [SETUP_NEW_MACHINE.md](SETUP_NEW_MACHINE.md)); a larger model reduces how often a plan needs correcting, it does not replace plan confirmation.
- Privacy by structure: the repository holds no patient data or credentials; outputs derived from MIMIC go only to PhysioNet-credentialed people.

## 8. What is not done / 尚未完成

- SOFA is first-day only; sepsis-3, SAPS II, APS III, OASIS are not built.
- No external or temporal validation of prediction models.
- The concept pack, derived definitions and drug catalogue have not been reviewed by a clinician.
- Diagnosis codes are undated; blood pressure and pain scores exist only in the ICU; the data come from one hospital, so readmission elsewhere is not seen.
- Acute kidney injury uses creatinine only (no urine output).
以上局限在每份报告中都会写明。
