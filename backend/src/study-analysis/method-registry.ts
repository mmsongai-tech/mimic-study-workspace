import type { StudyType } from "../study-framing/index.js";

export type AnalysisOutcomeType = "binary" | "continuous" | "count" | "time_to_event";

export interface MethodRequirement {
  /** Minimum complete rows. */
  min_rows: number;
  /** Minimum events (binary: the rarer outcome level; time-to-event: events). */
  min_events?: number;
  needs_binary_exposure?: boolean;
  needs_continuous_exposure?: boolean;
  needs_covariates?: boolean;
  needs_modifier?: boolean;
  needs_mediator?: boolean;
  needs_predictors?: number;
  needs_time_to_event?: boolean;
}

export interface AnalysisMethodOption {
  method_id: string;
  label: { en: string; zh: string };
  /** One line on when this option is the better choice. */
  when_preferred: { en: string; zh: string };
  requirements: MethodRequirement;
}

export const METHOD_REGISTRY_VERSION = "1.1.0";

const option = (method_id: string, en: string, zh: string, whenEn: string, whenZh: string, requirements: MethodRequirement): AnalysisMethodOption =>
  ({ method_id, label: { en, zh }, when_preferred: { en: whenEn, zh: whenZh }, requirements });

const ADJUSTED = (binary: boolean): AnalysisMethodOption => binary
  ? option("regression.adjusted", "Multivariable logistic regression", "多因素 logistic 回归", "Standard adjusted odds ratio; reports crude and adjusted estimates.", "标准的校正 OR，同时给出粗 OR 与校正 OR。", { min_rows: 50, min_events: 20, needs_covariates: true })
  : option("regression.adjusted", "Multivariable linear regression (ANCOVA)", "多因素线性回归（协方差分析）", "Adjusted mean difference when residuals are roughly normal.", "残差近似正态时的校正均值差。", { min_rows: 30, needs_covariates: true });
const UNADJUSTED = (binary: boolean): AnalysisMethodOption => binary
  ? option("tests.unadjusted", "Chi-square / Fisher exact test", "卡方检验 / Fisher 精确检验", "Simple unadjusted comparison; Fisher is used automatically for small cells.", "未校正的简单比较；小样本时自动使用 Fisher 精确检验。", { min_rows: 20 })
  : option("tests.unadjusted", "t-test / Wilcoxon rank-sum test", "t 检验 / Wilcoxon 秩和检验", "Unadjusted comparison; Wilcoxon is used automatically for skewed data.", "未校正比较；偏态数据自动使用 Wilcoxon 检验。", { min_rows: 20 });
const ROBUST = (binary: boolean): AnalysisMethodOption => binary
  ? option("regression.modified_poisson", "Modified Poisson regression (risk ratio)", "修正 Poisson 回归（相对危险度 RR）", "Risk ratios are easier to interpret than odds ratios when the outcome is common (>10%).", "结局较常见（>10%）时，RR 比 OR 更易解释。", { min_rows: 50, min_events: 20, needs_covariates: true })
  : option("regression.robust", "Linear regression with robust standard errors", "稳健标准误线性回归", "Protects inference when residual variance differs between groups.", "组间残差方差不等时保证推断可靠。", { min_rows: 30, needs_covariates: true });

const TIME_TO_EVENT: AnalysisMethodOption[] = [
  option("survival.cox", "Multivariable Cox regression", "多因素 Cox 回归", "Adjusted hazard ratio; checks proportional hazards and draws Kaplan-Meier curves.", "校正 HR，检验比例风险假设并绘制 KM 曲线。", { min_rows: 50, min_events: 20, needs_time_to_event: true, needs_covariates: true }),
  option("survival.km_logrank", "Kaplan-Meier with log-rank test", "Kaplan-Meier 曲线与 log-rank 检验", "Unadjusted survival comparison with median survival and numbers at risk.", "未校正的生存比较，给出中位生存时间与风险人数。", { min_rows: 20, min_events: 10, needs_time_to_event: true, needs_binary_exposure: true }),
  option("survival.cox_iptw", "Propensity-weighted Cox regression (IPTW)", "倾向性评分加权 Cox 回归（IPTW）", "Treatment comparisons where many baseline differences must be balanced.", "需要平衡大量基线差异的治疗比较。", { min_rows: 100, min_events: 20, needs_time_to_event: true, needs_binary_exposure: true, needs_covariates: true }),
];

const TREATMENT = (binary: boolean): AnalysisMethodOption[] => [
  option("treatment.iptw", "Inverse probability of treatment weighting (IPTW)", "逆概率加权（IPTW）", "Uses the whole cohort; reports balance, overlap and a truncation sensitivity analysis.", "使用全部队列；报告平衡性、重叠度及截断敏感性分析。", { min_rows: 100, min_events: binary ? 20 : undefined, needs_binary_exposure: true, needs_covariates: true } as MethodRequirement),
  option("treatment.psm", "1:1 propensity score matching", "1:1 倾向性评分匹配", "Transparent matched cohort; loses unmatched patients.", "匹配队列直观易懂，但会丢弃未匹配的患者。", { min_rows: 100, min_events: binary ? 20 : undefined, needs_binary_exposure: true, needs_covariates: true } as MethodRequirement),
  ADJUSTED(binary),
];

const DOSE = (binary: boolean): AnalysisMethodOption[] => [
  option("regression.rcs", "Restricted cubic spline regression", "限制性立方样条回归", "Shows the full dose-response shape and tests non-linearity.", "展示完整剂量-反应曲线并检验非线性。", { min_rows: 100, min_events: binary ? 30 : undefined, needs_continuous_exposure: true } as MethodRequirement),
  option("regression.quartiles", "Quartile categories with trend test", "四分位分组与趋势检验", "Familiar table of quartile estimates versus the lowest quartile.", "常见的四分位 vs 最低四分位估计表格。", { min_rows: 100, min_events: binary ? 30 : undefined, needs_continuous_exposure: true } as MethodRequirement),
  { ...ADJUSTED(binary), label: { en: "Linear per-unit trend", zh: "每单位线性趋势" }, when_preferred: { en: "Single per-unit estimate when the relation is approximately linear.", zh: "关系近似线性时给出单一的每单位估计。" } },
];

const MODIFICATION: AnalysisMethodOption[] = [
  option("modification.interaction", "Interaction test with stratified estimates", "交互作用检验与分层估计", "Formal P for interaction plus an estimate within each modifier level.", "给出交互作用 P 值及各亚组内的效应估计。", { min_rows: 100, min_events: 30, needs_modifier: true }),
  option("modification.stratified", "Stratified (subgroup) models only", "仅分层（亚组）模型", "Descriptive subgroup estimates without a formal interaction test.", "描述性的亚组估计，不做正式交互检验。", { min_rows: 80, min_events: 20, needs_modifier: true }),
  option("modification.iptw_interaction", "Propensity-weighted interaction analysis", "倾向性加权交互作用分析", "Treatment comparisons that also need confounding balance within subgroups.", "治疗比较且需要在亚组内平衡混杂。", { min_rows: 150, min_events: 30, needs_modifier: true, needs_binary_exposure: true, needs_covariates: true }),
];

const MEDIATION: AnalysisMethodOption[] = [
  option("mediation.mediate", "Causal mediation analysis (quasi-Bayesian)", "因果中介分析（准贝叶斯）", "Direct, indirect and total effects with the proportion mediated.", "给出直接、间接、总效应及中介比例。", { min_rows: 100, needs_mediator: true, needs_binary_exposure: true }),
  option("mediation.product", "Product of coefficients (Sobel)", "系数乘积法（Sobel 检验）", "Classic, fast indirect-effect estimate for continuous outcomes.", "经典快速的间接效应估计，适用于连续结局。", { min_rows: 50, needs_mediator: true }),
  option("mediation.difference", "Difference method with bootstrap CI", "差值法（Bootstrap 置信区间）", "Total minus direct effect; bootstrap interval without normality assumptions.", "总效应减直接效应；Bootstrap 区间无需正态假设。", { min_rows: 50, needs_mediator: true }),
];

const PREDICTION: AnalysisMethodOption[] = [
  option("prediction.logistic", "Logistic regression model", "Logistic 回归预测模型", "Interpretable model; reports AUC, calibration and Brier score on a held-out set.", "可解释模型；在验证集上报告 AUC、校准度和 Brier 分数。", { min_rows: 200, min_events: 50, needs_predictors: 1 }),
  option("prediction.lasso", "LASSO logistic regression", "LASSO logistic 回归", "Selects predictors automatically when there are many candidates.", "候选预测因子较多时自动筛选变量。", { min_rows: 200, min_events: 50, needs_predictors: 2 }),
  option("prediction.rcs", "Logistic regression with spline terms", "含样条项的 logistic 回归", "Captures non-linear effects of continuous predictors.", "捕捉连续预测因子的非线性效应。", { min_rows: 300, min_events: 80, needs_predictors: 1 }),
];

// A description fits no model: each characteristic's proportion (exact interval) or mean (t interval), with Table 1 (study_methods.R run_descriptive).
const DESCRIPTIVE: AnalysisMethodOption[] = [
  option("descriptive.summary", "Descriptive summary (Table 1, each characteristic overall and by group)", "描述性汇总（基线表，各特征总体及分组）", "The number of patients and each characteristic's proportion or mean with its 95% CI, in the whole cohort and in each group.", "患者人数及每个特征的比例或均值（95% CI），整个队列及各组。", { min_rows: 20 }),
  option("descriptive.rates", "Proportions and means by group only", "仅分组的比例与均值", "Each group's proportions (exact binomial intervals) and means, without the whole-cohort rows.", "仅各组的比例（精确二项区间）与均值，不列整个队列。", { min_rows: 20 }),
  option("descriptive.stratified", "By group with an unadjusted test", "分组描述并做未校正检验", "Adds a chi-square or rank test of each characteristic between groups; the tests are unadjusted and exploratory.", "对每个特征增加组间卡方或秩检验；检验未校正，仅供探索。", { min_rows: 20 }),
];

/**
 * Three options per study type and outcome type; the first is recommended. Every method id is implemented in
 * runtimes/r/study_methods.R; options whose requirements the data do not meet are shown as unavailable.
 */
export const methodOptions = (studyType: StudyType, outcomeType: AnalysisOutcomeType, goal?: string): AnalysisMethodOption[] => {
  const binary = outcomeType === "binary";
  if (outcomeType === "time_to_event" && studyType !== "effect_modification" && studyType !== "mediation" && studyType !== "prediction") return TIME_TO_EVENT;
  switch (studyType) {
    case "descriptive": return DESCRIPTIVE;
    case "group_comparison": return [UNADJUSTED(binary), ADJUSTED(binary), ROBUST(binary)];
    case "treatment_effect": return TREATMENT(binary);
    case "dose_response": return DOSE(binary);
    // A treatment whose effect is compared between subgroups needs the confounding balanced inside each subgroup.
    case "effect_modification": return goal === "evaluate_treatment" ? [MODIFICATION[2]!, MODIFICATION[0]!, MODIFICATION[1]!] : MODIFICATION;
    case "mediation": return MEDIATION;
    case "prediction": return PREDICTION;
    case "longitudinal_change": return goal === "evaluate_treatment" ? TREATMENT(false) : [ADJUSTED(false), ROBUST(false), UNADJUSTED(false)];
    default: return [ADJUSTED(binary), ROBUST(binary), UNADJUSTED(binary)];
  }
};
