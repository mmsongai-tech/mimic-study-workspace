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
- comparator: the comparison group phrase exactly as written (for example "未使用二甲双胍", "placebo", "女性"); "" if not stated.
- outcomes: every outcome phrase, one per item. Split lists such as "30天死亡率和住院时长" into separate items.
- composite_outcome: the name of a composite outcome when the question defines one (for example "MACE"), else "". Its parts go in outcomes.
- modifiers: variables said to change or modify the effect; else []. When aim is effect_modification, modifiers must not be empty: the factor whose levels are compared (for example "性别" for "男性和女性之间是否存在差异") is the modifier, and exposure and outcomes are those of the effect being modified.
- mediators: variables the effect is said to pass through; list each named aspect separately; else []. When aim is mediation, mediators must not be empty.
- predictors: candidate predictor variables for predict goals; else [].
- time_window: the time frame as written (for example "30天", "ICU入住24小时内"); "" if not stated.

Rules: copy phrases from the question in its language; never translate. Use "" or [] rather than guessing. Never select tables, codes or statistical methods.

Examples:
Sub-question (aim main): 糖尿病患者使用二甲双胍与未使用二甲双胍的30天死亡率和住院时长有何差异
{"goal":"evaluate_treatment","outcome_kind":"event","dose_question":false,"population":"糖尿病患者","exposure":"二甲双胍","exposure_categories":[],"comparator":"未使用二甲双胍","outcomes":["30天死亡率","住院时长"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":[],"time_window":"30天"}

Sub-question (aim effect_modification): 年龄是否改变脓毒症患者早期乳酸水平与院内死亡的关系
{"goal":"relate_factor","outcome_kind":"event","dose_question":false,"population":"脓毒症患者","exposure":"早期乳酸水平","exposure_categories":[],"comparator":"","outcomes":["院内死亡"],"composite_outcome":"","modifiers":["年龄"],"mediators":[],"predictors":[],"time_window":"早期"}

Sub-question (aim mediation): C反应蛋白在他汀类药物影响缺血性卒中患者90天死亡中的中介作用
{"goal":"evaluate_treatment","outcome_kind":"event","dose_question":false,"population":"缺血性卒中患者","exposure":"他汀类药物","exposure_categories":[],"comparator":"","outcomes":["90天死亡"],"composite_outcome":"","modifiers":[],"mediators":["C反应蛋白"],"predictors":[],"time_window":"90天"}

Sub-question (aim main): 心力衰竭患者不同累计利尿剂剂量与肾功能恶化的关系
{"goal":"relate_factor","outcome_kind":"event","dose_question":true,"population":"心力衰竭患者","exposure":"累计利尿剂剂量","exposure_categories":[],"comparator":"","outcomes":["肾功能恶化"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":[],"time_window":""}

Sub-question (aim main): 使用入ICU首日生命体征和实验室指标预测急性呼吸衰竭患者的院内死亡
{"goal":"predict","outcome_kind":"event","dose_question":false,"population":"急性呼吸衰竭患者","exposure":"","exposure_categories":[],"comparator":"","outcomes":["院内死亡"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":["生命体征","实验室指标"],"time_window":"入ICU首日"}

Sub-question (aim main): Does blood glucose change over the first 72 hours differ between patients with and without insulin infusion in diabetic ketoacidosis?
{"goal":"evaluate_treatment","outcome_kind":"change_over_time","dose_question":false,"population":"patients with diabetic ketoacidosis","exposure":"insulin infusion","exposure_categories":[],"comparator":"without insulin infusion","outcomes":["blood glucose"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":[],"time_window":"first 72 hours"}

Sub-question (aim main): 慢性肾病患者的一年生存率在男性和女性之间是否不同
{"goal":"compare_groups","outcome_kind":"time_to_event","dose_question":false,"population":"慢性肾病患者","exposure":"性别","exposure_categories":["男性","女性"],"comparator":"","outcomes":["一年生存率"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":[],"time_window":"一年"}

Sub-question (aim effect_modification): 抗凝治疗与出血风险的关联在男性和女性之间是否存在差异
{"goal":"evaluate_treatment","outcome_kind":"event","dose_question":false,"population":"","exposure":"抗凝治疗","exposure_categories":[],"comparator":"","outcomes":["出血风险"],"composite_outcome":"","modifiers":["性别"],"mediators":[],"predictors":[],"time_window":""}

Sub-question (aim main): 急性胰腺炎患者使用奥曲肽或生长抑素与未使用者的住院时长比较
{"goal":"evaluate_treatment","outcome_kind":"value","dose_question":false,"population":"急性胰腺炎患者","exposure":"奥曲肽或生长抑素","exposure_categories":["奥曲肽","生长抑素"],"comparator":"未使用者","outcomes":["住院时长"],"composite_outcome":"","modifiers":[],"mediators":[],"predictors":[],"time_window":""}
