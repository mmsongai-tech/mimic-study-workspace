import type { OutcomeStructure, ResearchIntent } from "../research-design/index.js";

export interface ResearchQuestionGoldCase {
  id: string;
  question: string;
  intent: ResearchIntent;
  outcome_structure: OutcomeStructure;
  exposure_or_predictor: string;
  outcome: string;
  expected_concepts: [string, string];
}

export const researchQuestionGoldCases: ResearchQuestionGoldCase[] = [
  { id: "a01", question: "研究早期乳酸与院内死亡之间的关联。", intent: "association", outcome_structure: "binary", exposure_or_predictor: "Lactate", outcome: "In-hospital mortality", expected_concepts: ["lactate", "in_hospital_mortality"] },
  { id: "a02", question: "平均动脉压与院内死亡是否相关？", intent: "association", outcome_structure: "binary", exposure_or_predictor: "Mean arterial pressure", outcome: "In-hospital mortality", expected_concepts: ["mean_arterial_pressure", "in_hospital_mortality"] },
  { id: "a03", question: "入院肌酐与住院时长的关系是什么？", intent: "association", outcome_structure: "continuous", exposure_or_predictor: "Creatinine", outcome: "Length of stay", expected_concepts: ["creatinine", "length_of_stay"] },
  { id: "a04", question: "血红蛋白与 ICU 住院时长是否相关？", intent: "association", outcome_structure: "continuous", exposure_or_predictor: "Hemoglobin", outcome: "Length of stay", expected_concepts: ["hemoglobin", "length_of_stay"] },
  { id: "a05", question: "SOFA 评分与治疗事件次数之间的关联。", intent: "association", outcome_structure: "count", exposure_or_predictor: "SOFA score", outcome: "Renal replacement therapy", expected_concepts: ["sofa_score", "renal_replacement_therapy"] },
  { id: "a06", question: "白细胞计数与抗菌药疗程次数之间的关联。", intent: "association", outcome_structure: "count", exposure_or_predictor: "White blood cell count", outcome: "Antibiotic exposure", expected_concepts: ["white_blood_cell_count", "antibiotic_exposure"] },
  { id: "a07", question: "乳酸与死亡时间之间的关联。", intent: "association", outcome_structure: "time_to_event", exposure_or_predictor: "Lactate", outcome: "Time to death", expected_concepts: ["lactate", "time_to_death"] },
  { id: "a08", question: "SOFA 评分与生存时间之间的关联。", intent: "association", outcome_structure: "time_to_event", exposure_or_predictor: "SOFA score", outcome: "Time to death", expected_concepts: ["sofa_score", "time_to_death"] },
  { id: "a09", question: "升压药暴露与重复测量平均动脉压的变化是否相关？", intent: "association", outcome_structure: "repeated_measure", exposure_or_predictor: "Vasopressor exposure", outcome: "Mean arterial pressure", expected_concepts: ["vasopressor_exposure", "mean_arterial_pressure"] },
  { id: "a10", question: "机械通气与重复测量呼吸频率的关系。", intent: "association", outcome_structure: "repeated_measure", exposure_or_predictor: "Invasive mechanical ventilation", outcome: "Respiratory rate", expected_concepts: ["invasive_ventilation", "respiratory_rate"] },
  { id: "a11", question: "乳酸与存在竞争事件时的死亡风险关联。", intent: "association", outcome_structure: "competing_risk", exposure_or_predictor: "Lactate", outcome: "Time to death", expected_concepts: ["lactate", "time_to_death"] },
  { id: "a12", question: "肾脏替代治疗与竞争风险框架下的死亡关联。", intent: "association", outcome_structure: "competing_risk", exposure_or_predictor: "Renal replacement therapy", outcome: "Time to death", expected_concepts: ["renal_replacement_therapy", "time_to_death"] },
  { id: "p01", question: "使用生命体征预测院内死亡。", intent: "prediction", outcome_structure: "binary", exposure_or_predictor: "Heart rate", outcome: "In-hospital mortality", expected_concepts: ["heart_rate", "in_hospital_mortality"] },
  { id: "p02", question: "使用呼吸频率预测有创机械通气。", intent: "prediction", outcome_structure: "binary", exposure_or_predictor: "Respiratory rate", outcome: "Invasive mechanical ventilation", expected_concepts: ["respiratory_rate", "invasive_ventilation"] },
  { id: "p03", question: "使用肌酐预测住院时长。", intent: "prediction", outcome_structure: "continuous", exposure_or_predictor: "Creatinine", outcome: "Length of stay", expected_concepts: ["creatinine", "length_of_stay"] },
  { id: "p04", question: "使用年龄预测 ICU 住院时长。", intent: "prediction", outcome_structure: "continuous", exposure_or_predictor: "Age", outcome: "Length of stay", expected_concepts: ["age", "length_of_stay"] },
  { id: "p05", question: "使用 SOFA 预测治疗事件次数。", intent: "prediction", outcome_structure: "count", exposure_or_predictor: "SOFA score", outcome: "Renal replacement therapy", expected_concepts: ["sofa_score", "renal_replacement_therapy"] },
  { id: "p06", question: "使用白细胞计数预测抗菌药使用次数。", intent: "prediction", outcome_structure: "count", exposure_or_predictor: "White blood cell count", outcome: "Antibiotic exposure", expected_concepts: ["white_blood_cell_count", "antibiotic_exposure"] },
  { id: "p07", question: "使用乳酸预测死亡时间。", intent: "prediction", outcome_structure: "time_to_event", exposure_or_predictor: "Lactate", outcome: "Time to death", expected_concepts: ["lactate", "time_to_death"] },
  { id: "p08", question: "使用 SOFA 预测生存时间。", intent: "prediction", outcome_structure: "time_to_event", exposure_or_predictor: "SOFA score", outcome: "Time to death", expected_concepts: ["sofa_score", "time_to_death"] },
  { id: "p09", question: "利用动态血氧预测后续重复呼吸频率。", intent: "prediction", outcome_structure: "repeated_measure", exposure_or_predictor: "Oxygen saturation", outcome: "Respiratory rate", expected_concepts: ["oxygen_saturation", "respiratory_rate"] },
  { id: "p10", question: "动态平均动脉压能否预测后续乳酸轨迹？", intent: "prediction", outcome_structure: "repeated_measure", exposure_or_predictor: "Mean arterial pressure", outcome: "Lactate", expected_concepts: ["mean_arterial_pressure", "lactate"] },
  { id: "p11", question: "预测存在竞争事件时的死亡风险。", intent: "prediction", outcome_structure: "competing_risk", exposure_or_predictor: "SOFA score", outcome: "Time to death", expected_concepts: ["sofa_score", "time_to_death"] },
  { id: "p12", question: "使用肌酐预测竞争风险框架下的死亡。", intent: "prediction", outcome_structure: "competing_risk", exposure_or_predictor: "Creatinine", outcome: "Time to death", expected_concepts: ["creatinine", "time_to_death"] },
  { id: "t01", question: "评估早期升压药对院内死亡的治疗效果。", intent: "treatment_effect", outcome_structure: "binary", exposure_or_predictor: "Vasopressor exposure", outcome: "In-hospital mortality", expected_concepts: ["vasopressor_exposure", "in_hospital_mortality"] },
  { id: "t02", question: "评估抗菌药治疗对院内死亡的效果。", intent: "treatment_effect", outcome_structure: "binary", exposure_or_predictor: "Antibiotic exposure", outcome: "In-hospital mortality", expected_concepts: ["antibiotic_exposure", "in_hospital_mortality"] },
  { id: "t03", question: "评估升压药对住院时长的平均治疗效果。", intent: "treatment_effect", outcome_structure: "continuous", exposure_or_predictor: "Vasopressor exposure", outcome: "Length of stay", expected_concepts: ["vasopressor_exposure", "length_of_stay"] },
  { id: "t04", question: "评估机械通气策略对住院时长的效果。", intent: "treatment_effect", outcome_structure: "continuous", exposure_or_predictor: "Invasive mechanical ventilation", outcome: "Length of stay", expected_concepts: ["invasive_ventilation", "length_of_stay"] },
  { id: "t05", question: "评估早期抗菌药对后续治疗事件次数的效果。", intent: "treatment_effect", outcome_structure: "count", exposure_or_predictor: "Antibiotic exposure", outcome: "Renal replacement therapy", expected_concepts: ["antibiotic_exposure", "renal_replacement_therapy"] },
  { id: "t06", question: "评估升压药暴露对治疗次数的效果。", intent: "treatment_effect", outcome_structure: "count", exposure_or_predictor: "Vasopressor exposure", outcome: "Renal replacement therapy", expected_concepts: ["vasopressor_exposure", "renal_replacement_therapy"] },
  { id: "t07", question: "评估早期升压药对生存时间的效果。", intent: "treatment_effect", outcome_structure: "time_to_event", exposure_or_predictor: "Vasopressor exposure", outcome: "Time to death", expected_concepts: ["vasopressor_exposure", "time_to_death"] },
  { id: "t08", question: "评估抗菌药对死亡时间的效果。", intent: "treatment_effect", outcome_structure: "time_to_event", exposure_or_predictor: "Antibiotic exposure", outcome: "Time to death", expected_concepts: ["antibiotic_exposure", "time_to_death"] },
  { id: "t09", question: "评估升压药对动态平均动脉压的效果。", intent: "treatment_effect", outcome_structure: "repeated_measure", exposure_or_predictor: "Vasopressor exposure", outcome: "Mean arterial pressure", expected_concepts: ["vasopressor_exposure", "mean_arterial_pressure"] },
  { id: "t10", question: "评估机械通气对动态血氧变化的效果。", intent: "treatment_effect", outcome_structure: "repeated_measure", exposure_or_predictor: "Invasive mechanical ventilation", outcome: "Oxygen saturation", expected_concepts: ["invasive_ventilation", "oxygen_saturation"] },
  { id: "t11", question: "评估升压药在竞争风险框架下对死亡的效果。", intent: "treatment_effect", outcome_structure: "competing_risk", exposure_or_predictor: "Vasopressor exposure", outcome: "Time to death", expected_concepts: ["vasopressor_exposure", "time_to_death"] },
  { id: "t12", question: "评估肾脏替代治疗在竞争风险下对死亡的效果。", intent: "treatment_effect", outcome_structure: "competing_risk", exposure_or_predictor: "Renal replacement therapy", outcome: "Time to death", expected_concepts: ["renal_replacement_therapy", "time_to_death"] },
];

