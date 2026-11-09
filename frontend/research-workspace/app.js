import { renderMethodComparison, renderPublicationReport } from "./statistical-presentation.js";
import { ResearchApiError, researchApi } from "./api.js";
import { translations } from "./translations.js";

const state = { language: "zh", design: null, confirmed: null, plan: null, mappings: null, mappingSearchStatus: null, run: null, busy: false, view: "home", editing: false, chartUrl: null, sensitivityChartUrl: null, localDataReady: false, pendingFallback: null, reviewedReusedDecisions: new Set(), program: null };
const element = (id) => document.getElementById(id);
const text = () => translations[state.language];

const reusedDecisionKey = (decision, index) => `${index}:${decision.question_id}`;
const reusedReviewComplete = () => {
  const decisions = state.design?.reused_design_review?.decisions ?? [];
  if (decisions.length === 0) return true;
  const visibleChecks = [...document.querySelectorAll("#reused-design-review .reused-decision-confirmation input[type=checkbox]")];
  if (visibleChecks.length === decisions.length && visibleChecks.every((checkbox) => checkbox.checked)) return true;
  return decisions.every((decision, index) => state.reviewedReusedDecisions.has(reusedDecisionKey(decision, index)));
};
const syncReusedReviewGate = () => {
  const confirm = element("confirm-button");
  if (!confirm) return;
  confirm.disabled = state.busy || Boolean(state.design?.reused_design_review && !state.confirmed && !reusedReviewComplete());
};

const questionElement = () => element("question");
let isQuestionComposing = false;

const chineseStudyText = new Map([
  ["Lactate and in-hospital mortality", "乳酸与院内死亡"],
  ["The synthetic lactate and in-hospital mortality association design is ready for confirmation.", "乳酸与院内死亡关联研究的设计已经整理完成，请核对后确认。"],
  ["Synthetic adult ICU admissions", "合成成人 ICU 入院记录"],
  ["ICU admission", "ICU 入科"],
  ["First eligible ICU admission", "首次符合条件的 ICU 入科记录"],
  ["Lactate", "乳酸"],
  ["In-hospital mortality", "院内死亡"],
  ["Crude odds ratio and risk difference", "粗比值比（OR）与风险差"],
  ["Results are demonstration evidence, not clinical findings.", "结果仅用于演示和检验流程，不代表真实临床发现。"],
  ["24-hour invasive ventilation prediction", "24 小时有创机械通气预测"],
  ["The 24-hour invasive ventilation prediction design is ready for confirmation.", "24 小时有创机械通气预测设计已整理完成，请核对后确认。"],
  ["Synthetic adult ICU admissions not invasively ventilated at ICU admission", "ICU 入科时尚未接受有创通气的合成成人 ICU 入院记录"],
  ["Age", "年龄"], ["Respiratory rate", "呼吸频率"], ["SpO2/FiO2 ratio", "SpO₂/FiO₂ 比值"], ["Glasgow Coma Scale", "格拉斯哥昏迷评分"],
  ["Invasive mechanical ventilation within 24 hours", "24 小时内有创机械通气"],
  ["Early vasopressor use and in-hospital mortality", "早期升压药与院内死亡"],
  ["The early vasopressor treatment-effect design is ready for confirmation.", "早期升压药治疗效果研究设计已整理完成，请核对后确认。"],
  ["Synthetic adult ICU admissions with hypotension", "发生低血压的合成成人 ICU 入院记录"],
  ["First qualifying hypotension after ICU admission", "ICU 入科后首次符合条件的低血压"],
  ["Early vasopressor initiation", "早期开始使用升压药"],
  ["IPTW-adjusted risk difference and risk ratio", "IPTW 调整后的风险差与风险比"],
  ["The question was preserved, but the current synthetic MIMIC demonstration has no registered data mapping or statistical capability for it. No substitute analysis will run.", "研究问题已按原文保留，但当前 MIMIC 合成演示尚未注册对应的数据映射和统计能力，因此不会运行替代分析。"],
  ["The original question was not converted and no analysis was executed.", "原研究问题未被改写，也没有执行任何分析。"],
  ["The research question has been structured for review. Data mapping and execution feasibility remain separate checks.", "研究问题已经整理为可审阅的研究设计；数据映射和执行可行性将单独核对。"],
  ["The design is reviewable, but execution requires validated clinical mappings and a compatible capability.", "研究设计可以审阅，但执行前还需要完成临床变量映射验证，并具备匹配的分析能力。"],
  ["Adults with an eligible ICU admission", "符合条件的成人 ICU 入院记录"],
  ["Researcher-confirmed definition and index-relative measurement window", "需要研究者确认变量定义及相对于起始时间的测量窗口"],
  ["Researcher-confirmed outcome definition and ascertainment window", "需要研究者确认结局定义及判定窗口"],
  ["Risk difference and odds ratio", "风险差和比值比（OR）"],
  ["The research purpose is explicit in the question or was selected by the researcher.", "研究问题已明确表达研究目的，或研究者已完成选择。"],
  ["Explicit inclusion criteria improve denominator auditability.", "明确纳入标准有助于核查研究分母。"],
  ["Explicit exclusions reduce post hoc cohort changes.", "明确排除标准可以减少事后改变研究队列。"],
  ["Assumptions should be visible before analysis.", "分析前应明确展示统计假设。"],
  ["Association and treatment-effect estimates usually require prespecified adjustment variables.", "关联和治疗效果估计通常需要预先指定调整变量。"],
  ["Unsupported requests must not be silently converted to a different study.", "不应在未确认的情况下，把原问题静默转换成另一种研究。"],
  ["Is the objective association, prediction, or treatment effect?", "这项研究的目的是分析关联、进行预测，还是评估治疗效果？"],
  ["The research purpose determines the estimand and analysis family.", "研究目的决定目标估计量和统计分析方法。"],
  ["What is the exact research question?", "请确认准确的研究问题。"],
  ["A reviewable protocol must preserve the researcher's question.", "可审阅的研究方案必须保留研究者提出的原始问题。"],
  ["Who is eligible for the study?", "哪些患者符合研究纳入条件？"],
  ["The target population and denominator must be explicit.", "需要明确目标人群以及用于计算的总人数。"],
  ["What event defines time zero, and which eligible record is selected?", "哪一个事件作为研究起点，并选择哪一次符合条件的记录？"],
  ["Time zero prevents temporal ambiguity and immortal-time errors.", "明确共同起点可以避免时间顺序不清和不死时间偏倚。"],
  ["What exposure, treatment, or predictors will be evaluated?", "需要评估哪些暴露因素、治疗措施或预测变量？"],
  ["The primary study input must be operationally defined.", "主要研究变量需要给出可执行、可复现的定义。"],
  ["What is the outcome and how is it operationally defined?", "研究结局是什么，如何进行可复现的判定？"],
  ["Outcome classification must be reproducible.", "结局判定规则必须能够重复执行。"],
  ["Is the outcome binary, continuous, count, time-to-event, repeated, or competing-risk?", "结局属于二分类、连续型、计数型、事件时间、重复测量，还是竞争风险？"],
  ["Outcome structure determines the statistical method family.", "结局的数据结构决定应采用哪一类统计方法。"],
  ["Over what period is the outcome assessed?", "结局需要在哪一段时间内进行判定？"],
  ["The estimand requires a defined follow-up or outcome horizon.", "目标估计量需要明确随访期或结局观察期限。"],
  ["What target population, contrast, outcome measure, and summary measure should be estimated?", "需要估计哪个目标人群、哪种对比、哪项结局指标和哪种汇总效应？"],
  ["A method cannot be selected responsibly without a target estimand.", "只有明确目标估计量后，才能选择合适的统计方法。"],
  ["Which analysis family corresponds to the confirmed purpose and outcome?", "哪一类统计分析与已确认的研究目的和结局相匹配？"],
  ["Execution must use a compatible registered or guarded method.", "正式执行必须使用兼容且已登记或受控的统计方法。"],
  ["Confirm that the designated outcome has the outcome role.", "请确认指定变量确实作为研究结局。"],
  ["Role mismatches make the protocol internally inconsistent.", "变量角色不一致会导致研究方案内部矛盾。"],
  ["Correct the time window whose end precedes its start.", "请修正结束时间早于开始时间的时间窗。"],
  ["Negative-duration windows cannot be executed.", "持续时间为负的时间窗无法执行。"],
  ["Correct the structured condition definition.", "请修正结构化条件定义。"],
  ["Lactate association", "乳酸关联研究"],
  ["Ventilation prediction", "机械通气预测"],
  ["Vasopressor treatment effect", "升压药治疗效果"],
  ["Association study", "关联研究"],
  ["Prediction study", "预测研究"],
  ["Treatment-effect study", "治疗效果研究"],
  ["Estimate the relationship between the selected exposure and outcome.", "估计所选暴露与结局之间的关联。"],
  ["Estimate individual outcome risk from predictors available at the index time.", "根据起始时间可获得的预测变量估计个体结局风险。"],
  ["Estimate the effect of a defined treatment strategy on the outcome.", "估计明确治疗策略对结局的影响。"],
  ["Use the synthetic lactate and in-hospital mortality fixture.", "使用乳酸与院内死亡合成数据流程。"],
  ["Use the 24-hour invasive-ventilation prediction fixture.", "使用 24 小时有创机械通气预测合成数据流程。"],
  ["Use the early-vasopressor IPTW fixture.", "使用早期升压药 IPTW 合成数据流程。"],
]);

const localizeStudyText = (value) => {
  if (!value || state.language !== "zh") return value;
  const translated = chineseStudyText.get(value);
  if (translated) return translated;
  if (value === "Confirm that every primary input is an exposure or treatment.") return "请确认每个主要研究变量都是暴露因素或治疗措施。";
  if (value === "Confirm that every primary input is a predictor.") return "请确认每个主要研究变量都是预测变量。";
  return value;
};

const localizeBlockingRequirement = (value) => {
  if (state.language !== "zh") return value;
  return value
    .replace(/^Define exposure:\s*/u, "请定义暴露因素：")
    .replace(/^Define outcome:\s*/u, "请定义结局：")
    .replace(/^Unmapped exposure:\s*/u, "暴露因素尚未映射：")
    .replace(/^Unmapped outcome:\s*/u, "结局尚未映射：")
    .replace(/^Unmapped population:\s*/u, "研究人群尚未映射：")
    .replace(/^Unmapped index_time:\s*/u, "起始时间尚未映射：")
    .replace(/\s+Researcher-confirmed definition and index-relative measurement window$/u, "：需要研究者确认变量定义及相对于起始时间的测量窗口")
    .replace(/\s+Researcher-confirmed outcome definition and ascertainment window$/u, "：需要研究者确认结局定义及判定窗口")
    .replace(/^No registered capability matches and guarded generated execution is disabled\.$/u, "当前没有匹配的已注册分析能力，且受控通用分析尚未启用。")
    .replace(/^The design is reviewable, but execution requires validated clinical mappings and a compatible capability\.$/u, "研究设计可以审阅，但执行前还需要完成临床变量映射验证，并具备匹配的分析能力。");
};

const chineseAnalysisMethods = {
  association: {
    primary_method: "根据结局类型建立多变量回归模型，并预先指定调整变量",
    rationale: "在不改变暴露、结局、共同起始时间和效应指标的前提下，估计调整后的关联。",
    required_conditions: ["研究单位相互独立", "暴露发生在结局之前", "结局事件数足够", "模型形式和调整变量预先确定", "缺失数据处理方案明确"],
    required_diagnostics: ["队列筛选流程与分母", "各变量缺失情况", "连续变量函数形式", "共线性", "高影响观测", "调整后效应值及 95% 置信区间"],
  },
  prediction: {
    primary_method: "预先指定预测模型，并采用重抽样完成内部验证",
    rationale: "只使用预测时点之前的信息估计个体风险，同时评价区分度、校准度和不确定性。",
    required_conditions: ["预测时点早于结局", "预测变量在预测时点可获得", "样本量和事件数足够", "不存在信息泄漏", "缺失数据处理纳入重抽样流程"],
    required_diagnostics: ["结局发生比例", "AUROC 与校准", "Brier 评分", "校准截距与斜率", "重抽样乐观偏倚", "阈值表现及置信区间"],
  },
  treatment_effect: {
    primary_method: "按照目标试验框架进行倾向评分调整，并补充双重稳健敏感性分析",
    rationale: "明确治疗策略、共同起始时间和目标效应，同时检查交换性、阳性和删失相关假设。",
    required_conditions: ["治疗策略定义清楚", "入组、治疗分配和起始时间对齐", "说明无未测量混杂假设", "满足阳性假设", "满足一致性", "处理信息性删失"],
    required_diagnostics: ["倾向评分重叠", "调整前后协变量平衡", "权重分布与有效样本量", "结局模型检查", "不同截尾方案", "残余偏倚讨论"],
  },
  time_to_event: {
    primary_method: "报告 Kaplan-Meier 生存曲线，并建立调整后的时间结局模型",
    rationale: "处理随访时间不同和删失问题，估计生存概率或预先指定的相对、绝对效应。",
    required_conditions: ["共同起始时间明确", "事件和删失规则明确", "随访时间足够", "评估独立删失假设", "必要时处理竞争风险"],
    required_diagnostics: ["各时点风险集人数", "删失分布", "使用 Cox 模型时检查比例风险假设", "竞争事件数", "绝对生存概率及置信区间"],
  },
};

const localizedAnalysisMethod = (method) => method;

const localizeReport = (report) => {
  if (state.language !== "zh") return report;
  return report
    .replace(/^# Lactate and in-hospital mortality$/mu, "# 乳酸与院内死亡")
    .replace(/^## Study design$/mu, "## 研究设计")
    .replace(/^Research question:/mu, "研究问题：")
    .replace(/^Population:/mu, "研究人群：")
    .replace(/^Index time:/mu, "共同起始时间：")
    .replace(/^Exposure:/mu, "暴露因素：")
    .replace(/^Outcome:/mu, "结局：")
    .replace(/^## Statistical methods$/mu, "## 统计方法")
    .replace(/^Primary method:/mu, "主要统计方法：")
    .replace(/^Method rationale:/gmu, "方法选择理由：")
    .replace(/^Model specification:/gmu, "模型设定：")
    .replace(/^Required conditions:/gmu, "适用前提：")
    .replace(/^Diagnostic interpretation:/gmu, "诊断解释：")
    .replace(/^Runtime:/mu, "统计运行时：")
    .replace(/^Exposure threshold:/mu, "暴露阈值：")
    .replace(/The analysis reports group risks, an absolute risk difference, and a crude odds ratio with a 95% confidence interval\./gu, "报告两组风险、绝对风险差，以及粗比值比（OR）及其 95% 置信区间。")
    .replace(/A Haldane–Anscombe correction of 0\.5 is applied only if a 2×2 table cell is zero\./gu, "仅当 2×2 列联表出现零格时，采用 Haldane–Anscombe 0.5 校正。")
    .replace(/No covariate adjustment, missing-data imputation, subgroup analysis, or sensitivity analysis is performed in this initial synthetic capability\./gu, "当前合成能力尚未进行协变量调整、缺失数据插补、亚组分析或敏感性分析。")
    .replace(/The prespecified primary estimate is crude\. A secondary logistic model adjusts for age and sex as a sensitivity analysis; no missing-data imputation or subgroup analysis is performed\./gu, "预设主要估计为粗关联；次要 Logistic 模型调整年龄和性别，作为敏感性分析。本次未进行缺失数据插补或亚组分析。")
    .replace(/a 2x2 analysis was selected because both the prespecified exposure contrast and outcome are binary\. It directly reports absolute risk difference and odds ratio; the secondary logistic model examines whether the association persists after limited adjustment\./gu, "预设暴露对比与结局均为二分类，因此采用 2×2 分析，直接报告绝对风险差和比值比；次要 Logistic 模型用于检验有限调整后关联是否仍存在。")
    .replace(/one eligible record per patient, exposure measured before outcome ascertainment, correct binary classification, independent observations, adequate cell counts, and no uncontrolled confounding for any causal interpretation\./gu, "每位患者保留一条符合规则的记录；暴露测量早于结局判定；二分类定义可靠；观察相互独立；格数充分；进行因果解释前不存在未控制的重要混杂。")
    .replace(/logistic regression was selected because the prespecified outcome is binary and the analysis must return an individual 24-hour event probability\. The model is intentionally simple and interpretable for this synthetic workflow check\./gu, "预设结局为二分类事件，且分析需要输出个体 24 小时事件概率，因此采用 Logistic 回归。当前模型保持简单和可解释，用于合成流程验证。")
    .replace(/prespecified admission predictors; complete-case analysis; deterministic 70\/30 development-validation split; probability threshold selected by Youden's index in the development set and evaluated once in the validation set\./gu, "使用预设入科时预测变量；完整病例分析；固定 70/30 开发-验证划分；概率阈值在开发集按 Youden 指数选择，并仅在验证集评价一次。")
    .replace(/the outcome must occur after predictor measurement; one eligible record per patient; no predictor may contain post-outcome information; continuous predictors should be approximately linear on the logit scale; severe collinearity should be absent; and the number of outcome events must support the fitted parameters\./gu, "结局必须发生在预测变量测量之后；每位患者仅保留一条符合规则的记录；预测变量不得包含结局后的信息；连续变量与 logit 近似线性；不存在严重多重共线性；结局事件数足以支持拟合参数。")
    .replace(/AUROC assesses discrimination, the Brier score assesses overall probabilistic error, and calibration intercept\/slope assess agreement between predicted and observed risk\. These measures do not establish clinical utility or external validity\./gu, "AUROC评价区分度，Brier评分评价总体概率误差，校准截距和斜率评价预测风险与观察风险的一致性。这些指标不能证明临床效用或外部有效性。")
    .replace(/stabilized inverse-probability-of-treatment weighting was selected to estimate a marginal average treatment effect while balancing prespecified measured baseline confounders between treatment groups\./gu, "采用稳定化治疗逆概率加权，在平衡两组预设且已测量的基线混杂因素后估计边际平均治疗效果。")
    .replace(/a logistic propensity-score model uses age, sex, SOFA score, and baseline lactate; stabilized weights are truncated at the 1st and 99th percentiles; percentile bootstrap replicates quantify uncertainty\./gu, "Logistic 倾向评分模型纳入年龄、性别、SOFA评分和基线乳酸；稳定化权重在第1和第99百分位截尾；采用百分位Bootstrap量化不确定性。")
    .replace(/treatment consistency, no interference, correct temporal ordering of baseline covariates before treatment, conditional exchangeability given measured confounders, positivity, and adequate propensity-model specification\. Causal interpretation is not justified if these conditions fail\./gu, "适用前提包括治疗一致性、无干扰、基线协变量早于治疗、给定已测量混杂后的条件交换性、阳性假设及充分的倾向评分模型设定。若这些条件不成立，不应进行因果解释。")
    .replace(/covariate balance after weighting is assessed with standardized mean differences; an absolute SMD below 0\.10 is used as a practical target\. Effective sample size and extreme weights describe precision loss and potential positivity problems\./gu, "使用标准化均值差评价加权后的协变量平衡，绝对SMD低于0.10作为实践目标。有效样本量和极端权重用于判断精度损失及潜在阳性问题。")
    .replace(/No covariate adjustment, missing-data imputation, subgroup analysis, or sensitivity analysis was estimable for this run\./gu, "本次运行无法估计协变量调整、缺失数据插补、亚组分析或敏感性分析。")
    .replace(/^Evidence: synthetic_execution$/mu, "证据类型：合成数据执行")
    .replace(/^Run ID:/mu, "运行 ID：")
    .replace(/^Study integrity:/mu, "研究设计完整性：")
    .replace(/^Data source:/mu, "数据来源：")
    .replace(/^## Results$/mu, "## 分析结果")
    .replace(/^## Validation results$/mu, "## 内部验证结果")
    .replace(/^## Diagnostics$/mu, "## 模型诊断")
    .replace(/^## Causal diagnostics$/mu, "## 因果分析诊断")
    .replace(/^Total observations:/mu, "观察总数：")
    .replace(/^Exposed events:/mu, "暴露组事件：")
    .replace(/^Unexposed events:/mu, "非暴露组事件：")
    .replace(/^Exposed risk:/mu, "暴露组风险：")
    .replace(/^Unexposed risk:/mu, "非暴露组风险：")
    .replace(/^Risk difference:/mu, "风险差：")
    .replace(/^Odds ratio:/mu, "比值比（OR）：")
    .replace(/^## Limitations$/mu, "## 局限性")
    .replace(/^## Table 1\. Baseline characteristics$/mu, "## 表 1　基线特征")
    .replace(/^## Adjusted sensitivity analysis$/mu, "## 调整后敏感性分析")
    .replace(/^Adjusted exposure odds ratio:/mu, "调整后暴露比值比：")
    .replace(/^Wald p-value:/mu, "Wald P 值：")
    .replace(/^Covariates:/mu, "调整变量：")
    .replace(/^## Model diagnostics and missing data$/mu, "## 模型诊断与缺失数据")
    .replace(/^Complete cases:/mu, "完整病例数：")
    .replace(/^Records with missing adjustment variables:/mu, "调整变量缺失记录数：")
    .replace(/^Total outcome events:/mu, "结局事件总数：")
    .replace(/^Events per fitted parameter:/mu, "每个拟合参数对应事件数：")
    .replace(/^Adjusted model status:/mu, "调整模型状态：")
    .replace(/^Model converged:/mu, "模型是否收敛：")
    .replace(/^Maximum variance inflation factor:/mu, "最大方差膨胀因子（VIF）：")
    .replace(/^Crude OR confidence-interval width ratio:/mu, "粗 OR 置信区间宽度比：")
    .replace(/^Sparse-data warning:/mu, "稀疏数据警告：")
    .replace(/^## Sensitivity analyses$/mu, "## 敏感性分析")
    .replace(/^Threshold >/gmu, "乳酸阈值 >")
    .replace(/^Continuous lactate per 1 mmol\/L:/mu, "乳酸每增加 1 mmol/L：")
    .replace(/Results are demonstration evidence, not clinical findings\./gu, "结果仅用于演示和检验流程，不代表真实临床发现。")
    .replace(/Synthetic fixture result; not clinical or real-data evidence\./gu, "合成夹具结果，不属于临床或真实数据证据。")
    .replace(/Crude association does not establish a causal treatment effect\./gu, "粗关联分析不能证明因果治疗效应。")
    .replace(/Synthetic internal validation only; external clinical validity is not established\./gu, "仅完成合成数据内部验证，尚未建立外部临床有效性。")
    .replace(/The model must not be used for patient-level decisions\./gu, "该模型不得用于患者级决策。")
    .replace(/Synthetic IPTW estimate only; unmeasured confounding is not addressed\./gu, "仅为合成数据 IPTW 估计，未测量混杂仍无法排除。")
    .replace(/This result is not a clinical treatment recommendation\./gu, "该结果不构成临床治疗建议。")
    .replace(/^Artifact integrity:/mu, "分析制品完整性：");
};

const setText = (id, value) => { element(id).textContent = value; };
const loadRuntimeMode = async () => {
  try {
    const response = await fetch("/health/ready", { headers: { accept: "application/json" } });
    const report = await response.json();
    state.localDataReady = report.capabilities?.some(({ id, state: capabilityState }) => id === "local_mimic_archive" && capabilityState === "ready") ?? false;
  } catch { state.localDataReady = false; }
  if (state.localDataReady) {
    Object.assign(translations.zh, { connectionStatus: "MIMIC 模式 · 本地只读数据", evidenceNotice: "已连接本地只读 MIMIC-IV 档案；统计只返回聚合结果，不向模型发送患者记录。", questionHint: "从一句研究想法开始；执行前系统会核对变量映射、时间窗和本地数据证据。", confirmAndRunHelp: "确认后运行本地 MIMIC 队列与统计分析", researcherReminderBody: "结果来自本地去标识 MIMIC 数据，仍需核对研究定义、缺失数据、统计假设和临床解释边界。", scope: "本地只读数据", completedAnalysis: "本地数据分析已完成" });
    Object.assign(translations.en, { connectionStatus: "MIMIC mode · local read-only data", evidenceNotice: "A local read-only MIMIC-IV archive is connected. Only aggregate results are returned; patient records are not sent to the model.", questionHint: "Start with one research idea; variable mappings, time windows, and local-data evidence are checked before execution.", confirmAndRunHelp: "Run the local MIMIC cohort and statistical analysis after confirmation", researcherReminderBody: "Results use local de-identified MIMIC data and still require review of definitions, missingness, assumptions, and clinical interpretation.", scope: "Local read-only data", completedAnalysis: "Local-data analysis completed" });
  }
};
const setBusy = (busy) => {
  state.busy = busy;
  for (const button of document.querySelectorAll("button")) button.disabled = busy;
  element("activity").textContent = busy ? text().working : "";
  syncReusedReviewGate();
};

const renderStage = () => {
  document.body.dataset.stage = state.view === "design" && state.design
    ? "design"
    : state.run ? "result" : state.design ? "design" : "home";
  if (state.design) {
    const spec = state.design.study_spec;
    const studyCode = state.run?.artifact?.preflight?.capability_id === "prediction.invasive_ventilation_24h.v1" ? "SYNTHETIC-VENTILATION-01" : state.run?.artifact?.preflight?.capability_id === "treatment_effect.early_vasopressor.in_hospital_mortality.v1" ? "SYNTHETIC-VASOPRESSOR-01" : state.run?.artifact?.preflight?.capability_id === "association.lactate.in_hospital_mortality.v1" ? "SYNTHETIC-LACTATE-01" : "MIMIC-STUDY-DRAFT";
    document.querySelector(".workspace-heading > p").textContent = `${studyCode} · v1.0.0`;
    setText("workspace-title", localizeStudyText(spec.title) ?? text().newMedicalStudy);
    setText("workspace-question", spec.research_question ?? "");
    setText("recent-study-title", localizeStudyText(spec.title) ?? text().newMedicalStudy);
    setText("recent-study-status", state.run ? text().syntheticExecution : state.confirmed ? text().confirmed : localizePhase(state.design.phase));
  } else {
    setText("recent-study-title", text().newMedicalStudy);
    setText("recent-study-status", text().waitingQuestion);
  }
  renderNavigation();
};

const renderNavigation = () => {
  for (const button of document.querySelectorAll("[data-workflow-step]")) {
    const step = button.dataset.workflowStep;
    const available = step === "question" || step === "design" || Boolean(state.run);
    button.setAttribute("aria-disabled", String(!available));
    button.classList.toggle("active", step === state.view || (state.view === "result" && step === "analysis"));
  }
};

const localizePhase = (phase) => ({
  ready_to_confirm: text().ready,
  needs_clarification: text().needsClarification,
  drafting: text().drafting,
  confirmed: text().confirmed,
})[phase] ?? phase;

const field = (label, value) => {
  const row = document.createElement("div");
  row.className = "definition-row";
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value || "—";
  row.append(term, description);
  return row;
};

const statisticsHeading = (title, note) => {
  const heading = document.createElement("div");
  heading.className = "statistics-heading";
  const name = document.createElement("b");
  name.textContent = title;
  heading.append(name);
  if (note) {
    const description = document.createElement("p");
    description.textContent = note;
    heading.append(description);
  }
  return heading;
};

const conditionSummary = (condition) => {
  if (condition.kind === "all") return "AND";
  if (condition.kind === "any") return "OR";
  if (condition.kind === "not") return "NOT";
  if (condition.kind === "numeric_comparison") return `${condition.concept} ${condition.operator} ${condition.value}${condition.unit ? ` ${condition.unit}` : ""}`;
  if (condition.kind === "category_comparison") return `${condition.concept} ${condition.operator} ${condition.values.join(", ")}`;
  if (condition.kind === "event_exists") return `${condition.concept} · ${condition.occurrence}`;
  return `${condition.concept} · ${condition.assertion}`;
};

const conditionNode = (condition) => {
  const node = document.createElement("div"); node.className = "condition-node";
  const title = document.createElement("b"); title.textContent = conditionSummary(condition);
  const id = document.createElement("code"); id.textContent = condition.condition_id;
  const source = document.createElement("small"); source.textContent = condition.source_text;
  node.append(title, id, source);
  for (const child of condition.operands ?? (condition.operand ? [condition.operand] : [])) node.append(conditionNode(child));
  return node;
};

const renderConditionTree = (spec) => {
  const panel = element("condition-tree-panel"); const root = element("condition-tree"); root.replaceChildren();
  const trees = [spec.population?.criteria, ...(spec.exposure_or_predictors ?? []).map(({ definition }) => definition), ...(!spec.analysis_objectives ? [spec.outcome?.definition] : []), ...(spec.covariates ?? []).map(({ definition }) => definition)].filter(Boolean);
  panel.hidden = trees.length === 0;
  for (const tree of trees) root.append(conditionNode(tree));
  if (spec.analysis_objectives) {
    panel.hidden = false;
    for (const requested of spec.analysis_objectives.requested) {
      const objective = spec.analysis_objectives.objectives.find((item) => item.objective_id === requested.objective_id);
      const group = document.createElement("section"); group.className = "condition-node";
      const heading = document.createElement("h4"); heading.textContent = requested.source_text;
      const note = document.createElement("p");
      note.textContent = !objective ? "目标尚未定义，不能确认研究" : objective.status === "blocked"
        ? `此目标暂不支持：${objective.blocking_reason}`
        : `独立分析目标 · ${objective.outcome_structure} · ${objective.outcome.operational_definition}`;
      group.append(heading, note);
      if (objective?.outcome.definition) group.append(conditionNode(objective.outcome.definition));
      if (objective?.outcome.derivation) {
        const derived = document.createElement("p"); const definition = objective.outcome.derivation;
        derived.textContent = `派生测量：${definition.source_concept}；${definition.aggregation}；${definition.direction === "baseline_minus_follow_up" ? "基线减随访" : "随访减基线"}。两个窗口分别核验，不用阈值替代。`;
        group.append(derived);
      }
      root.append(group);
    }
  }
};

const renderDesignSuggestions = () => {
  const section = element("design-suggestions");
  const list = element("design-suggestion-list");
  list.replaceChildren();
  const suggestions = state.design?.suggestions ?? [];
  section.hidden = suggestions.length === 0;
  for (const suggestion of suggestions) {
    const row = document.createElement("div"); row.className = "design-suggestion";
    const copy = document.createElement("div"); const title = document.createElement("b"); title.textContent = localizeStudyText(suggestion.label);
    const detail = document.createElement("small"); detail.textContent = localizeStudyText(suggestion.explanation); copy.append(title, detail);
    const button = document.createElement("button"); button.type = "button"; button.className = "quiet-button"; button.textContent = text().useSimilarDesign;
    button.addEventListener("click", async () => {
      setBusy(true); element("error-panel").hidden = true;
      try {
        state.design = await researchApi.continueSuggestion(state.design.session_id, state.design.revision, suggestion);
        state.confirmed = null; state.plan = null; state.mappings = null; state.run = null;
        renderDesign(); renderRun(); void loadVariableMappings(false).catch(reportError);
      } catch (error) { reportError(error); } finally { setBusy(false); }
    });
    row.append(copy, button); list.append(row);
  }
};

const renderVariableMappings = () => {
  const section = element("variable-mapping-review");
  section.hidden = !state.design || !state.confirmed;
  const list = element("variable-mapping-list"); list.replaceChildren();
  if (!state.mappings) { const note = document.createElement("p"); note.className = "supporting-copy"; note.textContent = text().mappingWaiting; list.append(note); return; }
  const summary = document.createElement("p"); summary.className = "supporting-copy"; summary.setAttribute("aria-live", "polite");
  summary.textContent = state.mappingSearchStatus
    ? text()[state.mappingSearchStatus]
    : state.mappings.status === "ready" ? text().mappingSummaryReady : state.mappings.status === "needs_confirmation" ? text().mappingSummaryReview : text().mappingSummaryBlocked;
  list.append(summary);
  for (const variable of state.mappings.variables) {
    const row = document.createElement("div"); row.className = "mapping-row";
    const copy = document.createElement("div"); const title = document.createElement("b");
    title.textContent = `${localizeStudyText(variable.requested_term)} · ${text()[`mappingStatus_${variable.status}`]}`;
    copy.append(title);
    // `candidate_review` is the automated dictionary-evidence review outcome for this VARIABLE
    // (it covers every candidate for the term together), not a per-candidate field — checking it
    // here, before filtering candidates, is what actually hides candidates the automated review
    // rejected. (Previously this checked a per-candidate field of the same name, which is never
    // set on an individual candidate, so the check was always vacuously true and never hid a
    // rejection.)
    const automatedReviewApproved = !variable.candidate_review || variable.candidate_review.decision === "approved";
    const reviewableCandidates = variable.status === "needs_confirmation" && automatedReviewApproved ? variable.candidates.filter((candidate) => candidate.requires_clinician_confirmation
      && ["discovered", "database_verified"].includes(candidate.mapping.status)) : [];
    const visibleCandidates = variable.status === "resolved" ? variable.candidates.slice(0, 1) : reviewableCandidates;
    if (!visibleCandidates.length) {
      const detail = document.createElement("small"); detail.textContent = variable.status === "unmapped" ? text().noSafeMappingCandidates : text().unmappedExplanation;
      copy.append(detail);
    }
    for (const candidate of visibleCandidates) {
      const candidateCard = document.createElement("div"); candidateCard.className = "mapping-candidate";
      const explanation = ["validated", "clinician_confirmed"].includes(candidate.mapping.status) ? text().validatedMappingExplanation : text().candidateMappingExplanation;
      const detail = document.createElement("small"); detail.textContent = `${candidate.mapping.labels[state.language] ?? candidate.mapping.labels.en} · ${explanation}`;
      const evidence = document.createElement("div"); evidence.className = "mapping-evidence"; const profile = candidate.mapping.evidence?.data_profile;
      const dictionaryEntries = candidate.mapping.evidence?.dictionary_entries ?? [];
      evidence.textContent = profile ? [`${profile.source_id}`, `${text().conditionMatches}: ${profile.matched_record_count}`, `${text().conditionMissing}: ${profile.missing_value_count}`, profile.units?.length ? `${text().conditionUnits}: ${profile.units.map(({ value, count }) => `${value} (${count})`).join(", ")}` : "", profile.top_values?.length ? `${text().conditionValues}: ${profile.top_values.map(({ value, count }) => `${value} (${count})`).join(", ")}` : ""].filter(Boolean).join(" · ") : dictionaryEntries.length ? `${text().dictionaryEvidence}: ${dictionaryEntries.map(({ dictionary, identifier, label }) => `${dictionary} ${identifier} ${label}`).join("; ")}` : text().conditionEvidencePending;
      candidateCard.append(detail, evidence);
      if (state.mappings.verification_available && candidate.requires_clinician_confirmation) {
        const button = document.createElement("button"); button.type = "button"; button.className = "quiet-button"; button.textContent = text().confirmMapping;
        button.addEventListener("click", async () => {
          setBusy(true);
          try {
            await researchApi.confirmVariableMapping(candidate.mapping.mapping_id, text().mappingReviewNote);
            await loadVariableMappings(false);
            if (state.confirmed) {
              state.plan = await researchApi.analysisPlan(state.design.session_id);
              renderDesign();
            }
          } catch (error) { reportError(error); } finally { setBusy(false); }
        });
        candidateCard.append(button);
      }
      copy.append(candidateCard);
    }
    row.append(copy);
    list.append(row);
  }
};

// --- Staged multi-objective research program (works for ANY free-text MIMIC question) ---

let programPollTimer = null;

const updateProgramRecoveryUrl = (jobId, question) => {
  const url = new URL(window.location.href);
  if (jobId) { url.searchParams.set("program_job_id", jobId); url.searchParams.set("program_question", question ?? ""); }
  else { url.searchParams.delete("program_job_id"); url.searchParams.delete("program_question"); }
  window.history.replaceState(null, "", url);
};

const stopProgramPolling = () => {
  if (programPollTimer) { window.clearTimeout(programPollTimer); programPollTimer = null; }
};

const scheduleProgramPoll = () => {
  stopProgramPolling();
  const status = state.program?.job?.status;
  if (!state.program || status === "completed" || status === "failed") return;
  programPollTimer = window.setTimeout(pollProgram, 1500);
};

const pollProgram = async () => {
  if (!state.program) return;
  try {
    const job = await researchApi.getMultiObjectiveRunJob(state.program.jobId);
    if (!job) { state.program = null; renderProgram(); return; }
    state.program.job = job;
    renderProgram();
  } catch (error) {
    reportError(error);
  } finally {
    scheduleProgramPoll();
  }
};

const startProgram = async (originalQuestion, retry = false) => {
  const job = await researchApi.startMultiObjectiveRun(originalQuestion, retry);
  state.program = { jobId: job.job_id, question: originalQuestion, job, mappings: {}, openObjectives: new Set() };
  state.view = "program";
  document.body.dataset.stage = "program";
  updateProgramRecoveryUrl(job.job_id, originalQuestion);
  renderProgram();
  scheduleProgramPoll();
};

const resumeProgram = async (jobId, question) => {
  const job = await researchApi.getMultiObjectiveRunJob(jobId);
  if (!job) return;
  state.program = { jobId, question: question ?? "", job, mappings: {}, openObjectives: new Set() };
  state.view = "program";
  document.body.dataset.stage = "program";
  renderProgram();
  scheduleProgramPoll();
};

const exitProgram = () => {
  stopProgramPolling();
  state.program = null;
  state.view = "home";
  document.body.dataset.stage = "home";
  updateProgramRecoveryUrl();
  element("question-form").reset();
  renderProgram();
};

const loadObjectiveMappings = async (objectiveId, live) => {
  try {
    state.program.mappings[objectiveId] = await researchApi.objectiveVariableMappings(state.program.jobId, objectiveId, live);
  } catch {
    state.program.mappings[objectiveId] = { error: true };
  }
  renderProgram();
};

// Purely presentational: the backend (buildObjectiveMappingView) already decided which
// candidates are visible and confirmable — this only formats and paints what it was given.
const formatEvidence = (evidence) => {
  if (evidence.kind === "data_profile") {
    return [evidence.source_id, `${text().conditionMatches}: ${evidence.matched_record_count}`, `${text().conditionMissing}: ${evidence.missing_value_count}`, evidence.units?.length ? `${text().conditionUnits}: ${evidence.units.map(({ value, count }) => `${value} (${count})`).join(", ")}` : "", evidence.top_values?.length ? `${text().conditionValues}: ${evidence.top_values.map(({ value, count }) => `${value} (${count})`).join(", ")}` : ""].filter(Boolean).join(" · ");
  }
  if (evidence.kind === "dictionary") {
    return `${text().dictionaryEvidence}: ${evidence.entries.map(({ dictionary, identifier, label }) => `${dictionary} ${identifier} ${label}`).join("; ")}`;
  }
  return text().conditionEvidencePending;
};

const renderMappingCandidateRow = (variable, onConfirmed) => {
  const row = document.createElement("div"); row.className = "mapping-row";
  const copy = document.createElement("div"); const title = document.createElement("b");
  title.textContent = `${localizeStudyText(variable.requested_term)} · ${text()[`mappingStatus_${variable.status}`]}`;
  copy.append(title);
  if (!variable.candidates.length) {
    const detail = document.createElement("small"); detail.textContent = variable.status === "unmapped" ? text().noSafeMappingCandidates : text().unmappedExplanation;
    copy.append(detail);
  }
  for (const candidate of variable.candidates) {
    const candidateCard = document.createElement("div"); candidateCard.className = "mapping-candidate";
    const explanation = text()[`${candidate.explanation_kind}MappingExplanation`];
    const detail = document.createElement("small"); detail.textContent = `${candidate.labels[state.language] ?? candidate.labels.en} · ${explanation}`;
    const evidence = document.createElement("div"); evidence.className = "mapping-evidence";
    evidence.textContent = formatEvidence(candidate.evidence);
    candidateCard.append(detail, evidence);
    if (candidate.confirmable) {
      const button = document.createElement("button"); button.type = "button"; button.className = "quiet-button"; button.textContent = text().confirmMapping;
      button.addEventListener("click", async () => {
        setBusy(true);
        try {
          await researchApi.confirmVariableMapping(candidate.mapping_id, text().mappingReviewNote);
          await onConfirmed();
        } catch (error) { reportError(error); } finally { setBusy(false); }
      });
      candidateCard.append(button);
    }
    copy.append(candidateCard);
  }
  row.append(copy);
  return row;
};

const renderObjectiveMappings = (trace) => {
  const container = document.createElement("div");
  const assessment = state.program.mappings[trace.objective_id];
  if (!assessment) {
    const note = document.createElement("p"); note.className = "supporting-copy"; note.textContent = text().mappingWaiting;
    container.append(note);
    return container;
  }
  if (assessment.error) {
    const note = document.createElement("p"); note.className = "supporting-copy"; note.textContent = text().programNoStudySpec;
    container.append(note);
    return container;
  }
  for (const variable of assessment.variables ?? []) {
    container.append(renderMappingCandidateRow(variable, () => loadObjectiveMappings(trace.objective_id, false)));
  }
  if ((assessment.variables ?? []).length === 0) {
    const note = document.createElement("p"); note.className = "supporting-copy"; note.textContent = text().programNoStudySpec;
    container.append(note);
  }
  return container;
};

const renderObjectiveCard = (trace) => {
  const card = document.createElement("div"); card.className = "objective-card";
  const title = document.createElement("b");
  title.append(document.createTextNode(trace.question || trace.objective_id));
  const badge = document.createElement("span"); badge.className = `objective-status ${trace.status}`;
  badge.textContent = text()[`programObjectiveStatus_${trace.status}`] ?? trace.status;
  title.append(badge);
  card.append(title);
  if (trace.status === "blocked" && trace.blocker) {
    const reason = document.createElement("small");
    reason.textContent = `${text().programBlockerPrefix}: ${trace.blocker.message}`;
    card.append(reason);
  }
  if (trace.status === "blocked" && trace.study_spec) {
    const isOpen = state.program.openObjectives.has(trace.objective_id);
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "quiet-button";
    toggle.textContent = isOpen ? text().programHideMappings : text().programReviewMappings;
    toggle.addEventListener("click", async () => {
      if (state.program.openObjectives.has(trace.objective_id)) {
        state.program.openObjectives.delete(trace.objective_id);
        renderProgram();
        return;
      }
      state.program.openObjectives.add(trace.objective_id);
      renderProgram();
      await loadObjectiveMappings(trace.objective_id, false);
    });
    card.append(toggle);
    if (isOpen) card.append(renderObjectiveMappings(trace));
  } else if (trace.status === "blocked") {
    const note = document.createElement("small"); note.textContent = text().programNoStudySpec;
    card.append(note);
  }
  return card;
};

const renderProgram = () => {
  const section = element("program-view");
  if (!state.program) { section.hidden = true; return; }
  section.hidden = false;
  const job = state.program.job;
  setText("program-question", state.program.question);
  setText("program-phase-title", text()[`programPhase_${job.phase}`] ?? job.phase);
  const seconds = Math.max(0, Math.floor((job.elapsed_ms ?? 0) / 1000));
  setText("program-elapsed", `${text().programElapsed} ${seconds}s`);
  const errorBox = element("program-error");
  if (job.status === "failed" && job.error) {
    errorBox.hidden = false;
    errorBox.textContent = text().apiErrors?.[job.error.code] ?? job.error.message;
  } else {
    errorBox.hidden = true;
  }
  setText("program-status", job.status === "completed" || job.status === "failed" ? "" : (text()[`programPhase_${job.phase}`] ?? job.phase));
  const objectivesSection = element("program-objectives");
  const traces = Array.isArray(job.objective_traces) ? job.objective_traces : [];
  objectivesSection.hidden = traces.length === 0;
  const list = element("program-objective-list"); list.replaceChildren();
  for (const trace of traces) list.append(renderObjectiveCard(trace));
  const anyBlocked = traces.some((trace) => trace.status === "blocked");
  element("program-retry-button").hidden = !(job.status === "completed" && anyBlocked);
  const reportSection = element("program-report-transparency");
  if (job.status === "completed" && job.result?.report_markdown) {
    reportSection.hidden = false;
    element("program-report-content").textContent = job.result.report_markdown;
  } else {
    reportSection.hidden = true;
  }
};

element("program-back-button").addEventListener("click", () => exitProgram());

element("program-retry-button").addEventListener("click", async () => {
  if (!state.program || state.busy) return;
  setBusy(true);
  element("error-panel").hidden = true;
  try {
    await startProgram(state.program.question, true);
  } catch (error) { reportError(error); } finally { setBusy(false); }
});

const loadVariableMappings = async (live) => {
  if (!state.design) return;
  if (!live) state.mappingSearchStatus = null;
  state.mappings = await researchApi.variableMappings(state.design.session_id, live);
  renderVariableMappings();
};

const renderDesign = () => {
  const waiting = element("design-waiting");
  const content = element("design-content");
  if (!state.design) {
    waiting.hidden = false;
    content.hidden = true;
    renderStage();
    return;
  }
  waiting.hidden = true;
  content.hidden = false;
  const spec = state.design.study_spec;
  setText("design-message", localizeStudyText(state.design.assistant_message));
  setText("phase-value", state.confirmed ? text().confirmed : localizePhase(state.design.phase));
  setText("revision-value", String(state.design.revision));
  const definitions = element("design-definitions");
  definitions.replaceChildren(
    field(text().population, localizeStudyText(spec.population?.description)),
    field(text().indexTime, [spec.index_time?.event, spec.index_time?.selection_rule].filter(Boolean).map(localizeStudyText).join(" · ")),
    field(text().exposure, spec.exposure_or_predictors?.map((item) => localizeStudyText(item.name)).join(", ")),
    field(text().outcome, localizeStudyText(spec.outcome?.name)),
    field(text().estimand, localizeStudyText(spec.estimand?.summary_measure)),
  );
  renderConditionTree(spec);
  const warningList = element("warning-list");
  warningList.replaceChildren();
  for (const warning of state.design.warnings ?? []) {
    const item = document.createElement("li");
    item.textContent = localizeStudyText(warning.message);
    warningList.append(item);
  }
  element("warnings-block").hidden = warningList.children.length === 0;
  let reusedReview = element("reused-design-review");
  if (!reusedReview) {
    reusedReview = document.createElement("section");
    reusedReview.id = "reused-design-review";
    reusedReview.className = "warning-block";
    reusedReview.dataset.testid = "reused-design-review";
    element("warnings-block").after(reusedReview);
  }
  const savedReview = state.design.reused_design_review;
  reusedReview.replaceChildren();
  reusedReview.hidden = !savedReview || Boolean(state.confirmed);
  if (savedReview && !state.confirmed) {
    const heading = document.createElement("h3");
    heading.textContent = state.language === "zh" ? "审核已保存的研究选择" : "Review saved research choices";
    const help = document.createElement("p");
    help.textContent = state.language === "zh"
      ? "这是已保存研究过程的加速回放，不是重新调用模型。请逐项核对历史选择；全部确认后，才可确认 StudySpec 并进入数据映射与统计。"
      : "This is an accelerated replay of the saved research process, not a new model call. Review every saved choice before confirming the StudySpec and continuing to mapping and analysis.";
    reusedReview.append(heading, help);
    if (savedReview.decisions.length) {
      const decisions = document.createElement("div");
      decisions.className = "reused-decision-list";
      savedReview.decisions.forEach((decision, index) => {
        const key = reusedDecisionKey(decision, index);
        const row = document.createElement("fieldset"); row.className = "reused-decision";
        const question = document.createElement("legend"); question.textContent = `${index + 1}. ${localizeStudyText(decision.question)}`;
        const answerLabel = document.createElement("label");
        const answerTitle = document.createElement("span"); answerTitle.textContent = state.language === "zh" ? "当时确认的答案" : "Previously confirmed answer";
        const answer = document.createElement("select"); answer.disabled = true; answer.setAttribute("aria-label", answerTitle.textContent);
        const selectedValues = new Set(Array.isArray(decision.selected_value) ? decision.selected_value.map(String) : [String(decision.selected_value)]);
        const options = decision.options?.length ? decision.options : [{ value: String(decision.selected_value), label: decision.selected_label, explanation: "" }];
        answer.multiple = decision.response_kind === "multi_select";
        for (const option of options) {
          const item = document.createElement("option"); item.value = option.value; item.textContent = localizeStudyText(option.label); item.selected = selectedValues.has(option.value); item.title = localizeStudyText(option.explanation);
          answer.append(item);
        }
        answerLabel.append(answerTitle, answer);
        const confirmation = document.createElement("label"); confirmation.className = "reused-decision-confirmation";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = state.reviewedReusedDecisions.has(key);
        const updateReview = () => {
          if (checkbox.checked) state.reviewedReusedDecisions.add(key); else state.reviewedReusedDecisions.delete(key);
          syncReusedReviewGate();
        };
        checkbox.addEventListener("input", updateReview);
        checkbox.addEventListener("change", updateReview);
        confirmation.addEventListener("click", () => window.setTimeout(syncReusedReviewGate, 0));
        const confirmationText = document.createElement("span"); confirmationText.textContent = state.language === "zh" ? "我已核对这项选择" : "I reviewed this choice";
        confirmation.append(checkbox, confirmationText);
        row.append(question, answerLabel, confirmation); decisions.append(row);
      });
      const instruction = document.createElement("p"); instruction.className = "supporting-copy";
      instruction.textContent = state.language === "zh" ? "回放中的答案不可直接改写，以免旧答案与已保存 StudySpec 不一致；需要改变时请使用“修改研究设计”。" : "Replay answers are read-only so they cannot diverge from the saved StudySpec. Use Edit design to make changes.";
      decisions.append(instruction);
      reusedReview.append(decisions);
    } else {
      const note = document.createElement("p");
      note.className = "supporting-copy";
      note.textContent = state.language === "zh" ? "该方案没有历史澄清题，请直接审核上方结构化研究定义。" : "This design has no saved clarification questions; review the structured definition above.";
      reusedReview.append(note);
    }
    const fingerprint = document.createElement("small");
    fingerprint.textContent = `${state.language === "zh" ? "来源证据" : "Source evidence"}: ${savedReview.source_integrity_id}`;
    reusedReview.append(fingerprint);
  }
  let clarification = element("clarification-block");
  if (!clarification) {
    clarification = document.createElement("section");
    clarification.id = "clarification-block";
    clarification.className = "warning-block";
    element("warnings-block").after(clarification);
  }
  const questions = state.design.clarifying_questions ?? [];
  clarification.replaceChildren();
  clarification.hidden = questions.length === 0;
  if (questions.length) {
    const form = document.createElement("form");
    form.className = "clarification-form";
    for (const question of questions) {
      const group = document.createElement("section");
      const heading = document.createElement("h4"); heading.textContent = localizeStudyText(question.prompt);
      const reason = document.createElement("p"); reason.textContent = localizeStudyText(question.reason) || text().clarificationReason;
      const answer = question.options.length && question.response_kind !== "text" ? document.createElement("select") : document.createElement("input");
      answer.name = question.id;
      answer.required = true;
      answer.setAttribute("aria-label", localizeStudyText(question.prompt));
      if (answer instanceof HTMLSelectElement) {
        for (const option of question.options) {
          const item = document.createElement("option"); item.value = option.value; item.textContent = localizeStudyText(option.label); item.title = localizeStudyText(option.explanation);
          answer.append(item);
        }
      } else {
        answer.type = "text";
        answer.placeholder = state.language === "zh" ? "请输入你的答案" : "Enter your answer";
      }
      group.append(heading, reason, answer); form.append(group);
    }
    const clarificationNotesLabel = document.createElement("label");
    clarificationNotesLabel.textContent = state.language === "zh" ? "补充研究定义（可选）" : "Additional research definitions (optional)";
    const clarificationNotes = document.createElement("textarea");
    clarificationNotes.rows = 4; clarificationNotes.maxLength = 12000;
    clarificationNotes.setAttribute("aria-label", clarificationNotesLabel.textContent);
    clarificationNotes.placeholder = state.language === "zh" ? "若选择自定义、需要多项条件，或选项不够准确，请在这里说明。" : "Explain custom choices, multiple conditions, or corrections to the available options.";
    clarificationNotesLabel.append(clarificationNotes); form.append(clarificationNotesLabel);
    const submit = document.createElement("button"); submit.type = "submit"; submit.className = "primary-button";
    submit.textContent = state.language === "zh" ? "确认这些选择" : "Confirm these choices";
    form.append(submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.busy) return;
      const answers = Object.fromEntries(new FormData(form).entries());
      setBusy(true); element("error-panel").hidden = true; element("activity").textContent = text().clarificationWorking;
      try {
        state.design = await researchApi.continue(state.design.session_id, state.design.revision, answers, clarificationNotes.value.trim());
        state.confirmed = null; state.plan = null; state.mappings = null; state.run = null; state.view = "design";
        renderDesign(); renderRun();
        void loadVariableMappings(false).catch(reportError);
      } catch (error) { reportError(error); } finally { setBusy(false); }
    });
    clarification.append(form);
  }
  element("confirm-button").hidden = !state.design.allowed_actions.includes("confirm") || Boolean(state.confirmed);
  syncReusedReviewGate();
  element("edit-design-button").hidden = state.editing;
  element("edit-design-form").hidden = !state.editing;
  element("revision-notice").hidden = !state.editing || !state.confirmed;
  element("design-definitions").hidden = state.editing;
  if (state.editing) {
    element("edit-population").value = spec.population?.description ?? "";
    element("edit-index-event").value = spec.index_time?.event ?? "";
    element("edit-selection-rule").value = spec.index_time?.selection_rule ?? "";
    element("edit-exposure").value = spec.exposure_or_predictors?.[0]?.name ?? "";
    element("edit-outcome").value = spec.outcome?.name ?? "";
    element("edit-summary-measure").value = spec.estimand?.summary_measure ?? "";
  }
  element("confirmed-badge").hidden = !state.confirmed;
  renderAnalysisPlan();
  renderDesignSuggestions();
  renderVariableMappings();
  element("run-form").hidden = !state.confirmed || state.editing || state.plan?.status !== "ready_for_confirmation";
  // Execution must use the contrast frozen in the confirmed StudySpec. The
  // legacy lactate override is retained only as a hidden transport default.
  element("threshold").hidden = true;
  element("threshold").required = false;
  document.querySelector('label[for="threshold"]').hidden = true;
  renderGuide();
  renderStage();
};

const renderAnalysisPlan = () => {
  const section = element("analysis-plan");
  section.hidden = !state.plan;
  if (!state.plan) return;
  const method = localizedAnalysisMethod(state.plan.method);
  let comparison = element("method-comparison");
  if (!comparison) {
    comparison = document.createElement("section");
    comparison.id = "method-comparison";
    element("analysis-plan-summary").after(comparison);
  }
  renderMethodComparison(comparison, state.plan, state.language);
  const executionMode = state.plan.execution_mode === "registered"
    ? text().registeredExecution
    : state.plan.execution_mode === "guarded_generated"
      ? text().guardedGeneratedExecution
      : text().planBlocked;
  element("analysis-plan-summary").replaceChildren(
    field(text().primaryMethod, method.primary_method),
    field(text().methodRationale, method.rationale),
    field(text().executionMode, executionMode),
  );
  element("analysis-plan-details").replaceChildren(
    field(text().requiredConditions, method.required_conditions.join("；")),
    field(text().requiredDiagnostics, method.required_diagnostics.join("；")),
  );
  const blockers = element("analysis-plan-blockers");
  const list = blockers.querySelector("ul");
  list.replaceChildren(...state.plan.blocking_requirements.map((message) => {
    const item = document.createElement("li");
    item.textContent = localizeBlockingRequirement(message);
    return item;
  }));
  blockers.hidden = state.plan.blocking_requirements.length === 0;
};

const metric = (label, value, detail = "") => {
  const card = document.createElement("div");
  card.className = "metric";
  const name = document.createElement("span");
  name.textContent = label;
  const number = document.createElement("strong");
  number.textContent = value;
  card.append(name, number);
  if (detail) {
    const note = document.createElement("small");
    note.textContent = detail;
    card.append(note);
  }
  return card;
};

const formatNumber = (value) => Number(value).toFixed(3).replace(/\.000$/u, "");
const eventSummary = (count, label) => {
  if (state.language !== "en") return `${count} ${label}`;
  return `${count} ${label.toLocaleLowerCase().replace(/events$/u, count === 1 ? "event" : "events")}`;
};

const openSelectedResultSection = () => {
  element("data-transparency").open = state.view === "data";
  element("analysis-transparency").open = state.view === "analysis";
  element("report-transparency").open = state.view === "report";
};

const renderRun = () => {
  let publications = element("publication-results");
  if (!publications) {
    publications = document.createElement("section");
    publications.id = "publication-results";
    element("metrics").after(publications);
  }
  renderPublicationReport(publications, state.run?.artifact, state.language);
  element("result-waiting").hidden = Boolean(state.run);
  element("result-content").hidden = !state.run;
  if (!state.run) {
    renderStage();
    return;
  }
  const { artifact } = state.run;
  if ("objective_counts" in artifact) {
    const counts = artifact.objective_counts;
    const metrics = element("metrics");
    const conclusionTitle = document.querySelector(".conclusion-card b");
    const conclusionBody = document.querySelector(".conclusion-card p");
    conclusionTitle.textContent = state.language === "zh" ? "多目标本地 MIMIC 报告已生成" : "Multi-objective local MIMIC report generated";
    conclusionBody.textContent = state.language === "zh"
      ? `共 ${counts.total} 个目标，完成 ${counts.completed} 个，阻断 ${counts.blocked} 个。每个目标均保留独立终态。`
      : `${counts.total} objectives: ${counts.completed} completed and ${counts.blocked} blocked. Each objective retains its own terminal status.`;
    metrics.replaceChildren(
      metric(state.language === "zh" ? "总体状态" : "Overall status", artifact.status),
      metric(state.language === "zh" ? "目标总数" : "Objectives", String(counts.total)),
      metric(state.language === "zh" ? "已完成" : "Completed", String(counts.completed)),
      metric(state.language === "zh" ? "已阻断" : "Blocked", String(counts.blocked)),
    );
    setText("integrity-value", artifact.integrity_id);
    setText("report-content", state.run.report_markdown);
    element("analysis-figure").hidden = true;
    element("sensitivity-figure").hidden = true;
    element("download-report").hidden = false;
    element("download-report-pdf").hidden = true;
    element("download-table").hidden = true;
    element("data-evidence").replaceChildren(
      field(state.language === "zh" ? "报告标识" : "Report ID", artifact.report_id),
      field(state.language === "zh" ? "覆盖复核" : "Coverage review", artifact.coverage_decision),
      field(state.language === "zh" ? "复现标识" : "Reproducibility", artifact.reproducibility_id),
    );
    element("calculation-notes").replaceChildren(...artifact.objectives.map((objective) =>
      field(
        `${objective.objective_id} · ${objective.status}`,
        objective.analysis?.method ?? (objective.blockers.map(({ stage, code }) => `${stage}/${code}`).join("; ") || "—"),
      )));
    element("contingency-table").replaceChildren();
    openSelectedResultSection();
    renderStage();
    return;
  }
  if (artifact.schema_version === "2.0.0") {
    element("download-report").hidden = true;
    element("download-report-pdf").hidden = true;
    element("download-table").hidden = true;
    const metrics = element("metrics");
    const conclusionTitle = document.querySelector(".conclusion-card b");
    const conclusionBody = document.querySelector(".conclusion-card p");
    const analysis = artifact.analysis;
    if (artifact.status === "completed" && analysis) {
      const interval = analysis.estimates.ci_lower !== undefined && analysis.estimates.ci_upper !== undefined
        ? `${formatNumber(analysis.estimates.ci_lower)}–${formatNumber(analysis.estimates.ci_upper)}`
        : "—";
      conclusionTitle.textContent = state.language === "zh" ? "本地 MIMIC 队列分析已完成" : "Local MIMIC cohort analysis completed";
      conclusionBody.textContent = state.language === "zh" ? "结果来自已配置的本地只读档案；请结合队列定义、诊断和局限性解释。" : "Results come from the configured read-only local archive; interpret them with the cohort definition, diagnostics, and limitations.";
      metrics.replaceChildren(
        metric(text().total, String(analysis.counts.total ?? artifact.cohort?.complete_rows ?? "—")),
        metric(state.language === "zh" ? "完整病例" : "Complete cases", String(analysis.counts.complete ?? artifact.cohort?.complete_rows ?? "—")),
        metric(state.language === "zh" ? "结局事件" : "Events", String(analysis.counts.events ?? "—")),
        metric(state.language === "zh" ? "效应估计" : "Effect estimate", analysis.estimates.estimate === undefined ? "—" : formatNumber(analysis.estimates.estimate), `${text().confidenceInterval}: ${interval}`),
      );
    } else {
      conclusionTitle.textContent = state.language === "zh" ? "真实数据执行已阻断" : "Real-data execution was blocked";
      conclusionBody.textContent = artifact.blockers.map(({ stage, code, message }) => `${stage}/${code}: ${message}`).join("；");
      metrics.replaceChildren(metric(state.language === "zh" ? "执行状态" : "Run status", artifact.status));
    }
    setText("integrity-value", artifact.integrity_id);
    setText("report-content", state.run.report_markdown);
    element("analysis-figure").hidden = true;
    element("sensitivity-figure").hidden = true;
    element("download-report").hidden = true;
    element("download-report-pdf").hidden = true;
    element("download-table").hidden = true;
    element("data-evidence").replaceChildren(
      field(text().dataSource, `${artifact.data_provenance.data_source_id} · ${artifact.data_provenance.data_source_version}`),
      field(text().evidenceClass, artifact.evidence_level),
      field(state.language === "zh" ? "档案指纹" : "Archive digest", artifact.data_provenance.archive_sha256),
      field(state.language === "zh" ? "诊断结论" : "Diagnostic decision", artifact.diagnostic_decision),
    );
    element("calculation-notes").replaceChildren(
      field(state.language === "zh" ? "统计方法" : "Statistical method", analysis?.method ?? "—"),
      field(state.language === "zh" ? "分析单位" : "Analysis units", String(artifact.cohort?.analysis_units ?? "—")),
      field(state.language === "zh" ? "排除记录" : "Excluded rows", String(artifact.cohort?.excluded_rows ?? "—")),
    );
    element("contingency-table").replaceChildren();
    openSelectedResultSection();
    renderStage();
    return;
  }
  element("download-report").hidden = false;
  element("download-report-pdf").hidden = false;
  element("download-table").hidden = false;
  element("download-report").hidden = false;
  element("download-report-pdf").hidden = false;
  element("download-table").hidden = false;
  const { counts, estimates } = artifact.analysis;
  const metrics = element("metrics");
  const conclusionTitle = document.querySelector(".conclusion-card b");
  const conclusionBody = document.querySelector(".conclusion-card p");
  if (artifact.analysis.analysis_kind === "binary_prediction") {
    conclusionTitle.textContent = state.language === "zh" ? "模型具有内部区分度，尚未完成外部验证" : "The model discriminates internally but lacks external validation";
    conclusionBody.textContent = state.language === "zh" ? "当前性能来自合成数据的固定内部验证，不可用于患者级决策。" : "Performance comes from fixed internal validation on synthetic data and cannot support patient-level decisions.";
    metrics.replaceChildren(
      metric(text().total, String(counts.total)), metric(state.language === "zh" ? "验证集" : "Validation", String(counts.validation), `${counts.validation_events} events`),
      metric("AUROC", formatNumber(estimates.auroc)), metric(state.language === "zh" ? "Brier 评分" : "Brier score", formatNumber(estimates.brier_score)),
      metric(state.language === "zh" ? "校准斜率" : "Calibration slope", formatNumber(estimates.calibration_slope)),
    );
  } else if (artifact.analysis.analysis_kind === "propensity_weighted_treatment_effect") {
    conclusionTitle.textContent = state.language === "zh" ? "加权后观察到风险差异，但不能排除未测量混杂" : "A weighted risk difference remains, but unmeasured confounding cannot be excluded";
    conclusionBody.textContent = state.language === "zh" ? "这是合成数据上的 IPTW 流程验证，不构成治疗建议或临床因果结论。" : "This synthetic IPTW workflow is not a treatment recommendation or clinical causal conclusion.";
    metrics.replaceChildren(
      metric(text().total, String(counts.total)), metric(state.language === "zh" ? "治疗组" : "Treated", String(counts.treated), `${counts.treated_events} events`),
      metric(state.language === "zh" ? "对照组" : "Untreated", String(counts.untreated), `${counts.untreated_events} events`),
      metric(text().riskDifference, formatNumber(estimates.risk_difference), `${text().confidenceInterval}: ${formatNumber(estimates.risk_difference_ci_95[0])}–${formatNumber(estimates.risk_difference_ci_95[1])}`),
      metric(state.language === "zh" ? "风险比" : "Risk ratio", formatNumber(estimates.risk_ratio)),
    );
  } else {
    conclusionTitle.textContent = text().evidenceInsufficient;
    conclusionBody.textContent = text().conclusionBoundary;
    metrics.replaceChildren(
      metric(text().total, String(counts.total)), metric(text().exposed, String(counts.exposed), eventSummary(counts.exposed_events, text().exposedEvents)),
      metric(text().unexposed, String(counts.unexposed), eventSummary(counts.unexposed_events, text().unexposedEvents)), metric(text().riskDifference, formatNumber(estimates.risk_difference)),
      metric(text().oddsRatio, formatNumber(estimates.odds_ratio), `${text().confidenceInterval}: ${formatNumber(estimates.odds_ratio_ci_95[0])}–${formatNumber(estimates.odds_ratio_ci_95[1])}`),
    );
  }
  setText("integrity-value", artifact.integrity_id);
  setText("report-content", localizeReport(state.run.report_markdown));
  const figure = artifact.analysis.publication_outputs?.figures?.[0];
  element("analysis-figure").hidden = !figure;
  if (figure) {
    if (state.chartUrl) URL.revokeObjectURL(state.chartUrl);
    state.chartUrl = URL.createObjectURL(new Blob([figure.content], { type: figure.mime_type }));
    element("analysis-chart").src = state.chartUrl;
    element("analysis-chart").alt = figure.title;
  }
  document.querySelector("#analysis-figure figcaption b").textContent = figure?.title ?? text().chartTitle;
  const sensitivityFigure = artifact.analysis.publication_outputs?.figures?.[1];
  element("sensitivity-figure").hidden = !sensitivityFigure;
  if (sensitivityFigure) {
    if (state.sensitivityChartUrl) URL.revokeObjectURL(state.sensitivityChartUrl);
    state.sensitivityChartUrl = URL.createObjectURL(new Blob([sensitivityFigure.content], { type: sensitivityFigure.mime_type }));
    element("sensitivity-chart").src = state.sensitivityChartUrl;
    element("sensitivity-chart").alt = sensitivityFigure.title;
    document.querySelector("#sensitivity-figure figcaption b").textContent = sensitivityFigure.title;
  }
  element("data-evidence").replaceChildren(
    field(text().preflightStatus, artifact.preflight.status),
    field(text().dataSource, `${artifact.preflight.data_source.id} · ${artifact.preflight.data_source.version} · ${artifact.preflight.data_source.data_mode}`),
    field(text().evidenceClass, artifact.preflight.evidence_class),
    field(text().capability, artifact.preflight.capability_id ?? "—"),
  );
  renderCalculation(artifact.analysis);
  renderStage();
};

const renderCalculation = (analysis) => {
  const { counts, estimates, method } = analysis;
  if (analysis.analysis_kind === "binary_prediction") {
    element("contingency-table").replaceChildren(
      field(state.language === "zh" ? "开发/验证" : "Development/validation", `${counts.development} / ${counts.validation}`),
      field(state.language === "zh" ? "验证集事件" : "Validation events", String(counts.validation_events)),
    );
    element("calculation-notes").replaceChildren(
      statisticsHeading(state.language === "zh" ? "方法选择" : "Method selection", state.language === "zh" ? "先说明为什么使用该方法，再看结果。" : "Why this method was used, before interpreting its results."),
      field(state.language === "zh" ? "分析目标" : "Analysis objective", state.language === "zh" ? "估计 ICU 入科后 24 小时内发生有创机械通气的个体概率。" : "Estimate an individual's probability of invasive ventilation within 24 hours after ICU admission."),
      field(state.language === "zh" ? "选择 Logistic 回归的理由" : "Why logistic regression", state.language === "zh" ? "结局为二分类事件；Logistic 回归可直接输出预测概率，参数可解释，适合作为预设的基准预测模型。" : "The outcome is binary. Logistic regression returns interpretable event probabilities and is suitable as a prespecified baseline prediction model."),
      field(state.language === "zh" ? "模型与验证设定" : "Model and validation specification", state.language === "zh" ? "预设入科时预测变量；完整病例分析；固定 70/30 开发-验证划分；Youden 阈值仅在开发集选择，再在验证集评价。" : "Prespecified admission predictors; complete-case analysis; fixed 70/30 development-validation split; Youden threshold selected in development and evaluated in validation."),
      statisticsHeading(state.language === "zh" ? "前提与数据要求" : "Assumptions and data requirements", state.language === "zh" ? "这些条件需要在接入真实数据库后逐项核对。" : "These conditions must be checked against the real database."),
      field(state.language === "zh" ? "时间顺序与独立性" : "Temporality and independence", state.language === "zh" ? "预测变量必须早于结局；每位患者只保留一条符合规则的记录；不得包含结局发生后的信息。" : "Predictors must precede the outcome; retain one eligible record per patient; exclude post-outcome information."),
      field(state.language === "zh" ? "模型假设" : "Model assumptions", state.language === "zh" ? "连续变量与 logit 近似线性，无严重多重共线性，事件数足以支持参数数量，开发集与验证集来自同一目标人群。" : "Continuous predictors are approximately linear on the logit scale, severe collinearity is absent, event counts support the fitted parameters, and both splits represent the same target population."),
      statisticsHeading(state.language === "zh" ? "诊断与解释" : "Diagnostics and interpretation"),
      field(state.language === "zh" ? "数据充分性" : "Data adequacy", `${analysis.diagnostics.model_converged ? (state.language === "zh" ? "模型已收敛" : "Model converged") : (state.language === "zh" ? "模型未收敛" : "Model did not converge")}；${state.language === "zh" ? "每参数事件数" : "events per parameter"} ${formatNumber(analysis.diagnostics.events_per_parameter)} (${state.language === "zh" ? "常用经验参考值约为 10 或以上" : "a common rule-of-thumb target is about 10 or more"})`),
      field("AUROC / Brier", `${formatNumber(estimates.auroc)} / ${formatNumber(estimates.brier_score)}`),
      field(state.language === "zh" ? "校准截距 / 斜率" : "Calibration intercept / slope", `${formatNumber(estimates.calibration_intercept)} / ${formatNumber(estimates.calibration_slope)}`),
      field(state.language === "zh" ? "阈值表现" : "Threshold performance", `${state.language === "zh" ? "阈值" : "Threshold"} ${formatNumber(estimates.probability_threshold)}；${state.language === "zh" ? "敏感度 / 特异度" : "sensitivity / specificity"} ${formatNumber(estimates.sensitivity)} / ${formatNumber(estimates.specificity)}`),
      field(state.language === "zh" ? "解释边界" : "Interpretation boundary", state.language === "zh" ? "AUROC反映区分度，Brier评分反映总体概率误差，校准指标反映预测风险与观察风险的一致性；这些指标不能替代外部验证、临床效用或决策曲线分析。" : "AUROC measures discrimination, Brier score measures overall probabilistic error, and calibration assesses agreement between predicted and observed risk. They do not replace external validation, clinical-utility assessment, or decision-curve analysis."),
      field(text().technicalDetails, `R ${analysis.runtime?.version ?? "—"} · ${method.id} · v${method.version}`),
    ); return;
  }
  if (analysis.analysis_kind === "propensity_weighted_treatment_effect") {
    element("contingency-table").replaceChildren(field(state.language === "zh" ? "治疗/对照" : "Treated/untreated", `${counts.treated} / ${counts.untreated}`));
    element("calculation-notes").replaceChildren(
      statisticsHeading(state.language === "zh" ? "方法选择" : "Method selection", state.language === "zh" ? "目标是估计边际平均治疗效果，而不是简单比较两组粗风险。" : "The target is a marginal average treatment effect, not a crude group comparison."),
      field(state.language === "zh" ? "选择 IPTW 的理由" : "Why IPTW", state.language === "zh" ? "倾向评分逆概率加权利用治疗前协变量构建加权伪总体，使已测量混杂因素在两组间更接近平衡，并估计目标人群的边际治疗效果。" : "Inverse-probability weighting uses pretreatment covariates to create a weighted pseudo-population with improved measured-confounder balance and estimates a marginal treatment effect."),
      field(state.language === "zh" ? "模型与不确定性设定" : "Model and uncertainty specification", state.language === "zh" ? "Logistic 倾向评分模型；稳定化权重；第 1 与第 99 百分位截尾；百分位 Bootstrap 置信区间。" : "Logistic propensity model; stabilized weights; 1st/99th percentile truncation; percentile-bootstrap confidence interval."),
      statisticsHeading(state.language === "zh" ? "因果识别前提" : "Causal-identification assumptions", state.language === "zh" ? "只有这些前提基本成立时，结果才可讨论因果解释。" : "Causal interpretation requires these conditions to be reasonably satisfied."),
      field(state.language === "zh" ? "必要前提" : "Required conditions", state.language === "zh" ? "治疗一致性、无干扰、治疗前协变量定义正确、给定已测量混杂后的条件交换性、阳性假设以及倾向评分模型设定充分。" : "Consistency, no interference, correctly timed pretreatment covariates, conditional exchangeability given measured confounders, positivity, and adequate propensity-model specification."),
      field(state.language === "zh" ? "未测量混杂" : "Unmeasured confounding", state.language === "zh" ? "IPTW只能平衡已纳入模型的变量；未测量或测量不准确的混杂因素仍可能造成偏倚。" : "IPTW balances only modeled variables; unmeasured or poorly measured confounders can still bias the estimate."),
      statisticsHeading(state.language === "zh" ? "平衡与稳定性诊断" : "Balance and stability diagnostics"),
      field(state.language === "zh" ? "最大 SMD 加权前/后" : "Maximum SMD before/after", `${formatNumber(analysis.diagnostics.maximum_smd_before)} / ${formatNumber(analysis.diagnostics.maximum_smd_after)}`),
      field(state.language === "zh" ? "平衡判断" : "Balance assessment", state.language === "zh" ? `加权后最大绝对 SMD 为 ${formatNumber(analysis.diagnostics.maximum_smd_after)}；常用实践目标为低于 0.10。` : `Maximum absolute SMD after weighting is ${formatNumber(analysis.diagnostics.maximum_smd_after)}; a commonly used practical target is below 0.10.`),
      field(state.language === "zh" ? "有效样本量与极端权重" : "Effective sample size and extreme weights", `${formatNumber(analysis.diagnostics.effective_sample_size)}；${state.language === "zh" ? "极端权重比例" : "extreme-weight fraction"} ${formatNumber(analysis.diagnostics.extreme_weight_fraction)}`),
      field(state.language === "zh" ? "解释边界" : "Interpretation boundary", state.language === "zh" ? "风险差和风险比应连同 Bootstrap 区间、平衡诊断和阳性评估一起解释；合成数据结果不能形成治疗建议。" : "Interpret risk difference and risk ratio together with bootstrap uncertainty, balance diagnostics, and positivity assessment. Synthetic results cannot support treatment recommendations."),
      field(text().technicalDetails, `R ${analysis.runtime?.version ?? "—"} · ${method.id} · v${method.version}`),
    ); return;
  }
  const exposedNonEvents = counts.exposed - counts.exposed_events;
  const unexposedNonEvents = counts.unexposed - counts.unexposed_events;
  const table = element("contingency-table");
  table.replaceChildren(
    field(text().exposed, `${counts.exposed_events} events + ${exposedNonEvents} non-events = ${counts.exposed}`),
    field(text().unexposed, `${counts.unexposed_events} events + ${unexposedNonEvents} non-events = ${counts.unexposed}`),
  );
  const rules = element("calculation-notes");
  const exposedRisk = `${counts.exposed_events} / ${counts.exposed} = ${formatNumber(estimates.exposed_risk)}`;
  const unexposedRisk = `${counts.unexposed_events} / ${counts.unexposed} = ${formatNumber(estimates.unexposed_risk)}`;
  const rule = state.language === "zh"
    ? `风险差 = 暴露组风险 − 非暴露组风险；OR = (暴露事件 × 非暴露非事件) / (暴露非事件 × 非暴露事件)。零格时使用 Haldane–Anscombe 0.5 校正。`
    : `Risk difference = exposed risk − unexposed risk; OR = (exposed events × unexposed non-events) / (exposed non-events × unexposed events). A Haldane–Anscombe 0.5 correction is used for zero cells.`;
  rules.replaceChildren(
    statisticsHeading(state.language === "zh" ? "方法选择" : "Method selection", state.language === "zh" ? "同时报告绝对风险差和相对关联强度。" : "Report both the absolute risk difference and relative association strength."),
    field(state.language === "zh" ? "选择 2×2 分析的理由" : "Why a 2x2 analysis", state.language === "zh" ? "预设暴露对比和结局均为二分类；列联表可以直接给出两组风险、风险差和粗比值比，次要 Logistic 模型用于有限调整。" : "Both the prespecified exposure contrast and outcome are binary. A contingency table directly yields group risks, risk difference, and crude odds ratio; a secondary logistic model provides limited adjustment."),
    statisticsHeading(state.language === "zh" ? "前提与数据要求" : "Assumptions and data requirements"),
    field(state.language === "zh" ? "必要条件" : "Required conditions", state.language === "zh" ? "一人一条符合规则的记录、暴露早于结局、二分类定义可靠、观察相互独立、格数足够，并在进行因果解释前充分控制混杂。" : "One eligible record per patient, exposure before outcome, reliable binary classification, independent observations, adequate cell counts, and sufficient confounding control before any causal interpretation."),
    statisticsHeading(state.language === "zh" ? "计算与诊断" : "Calculation and diagnostics"),
    field(text().exposedRisk, exposedRisk),
    field(text().unexposedRisk, unexposedRisk),
    field(text().method, text().methodPlain),
    field(text().technicalDetails, `R ${analysis.runtime?.version ?? "—"} · ${method.id} · v${method.version}`),
    field(text().calculationRule, rule),
  );
  openSelectedResultSection();
};

const applyLanguage = () => {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  for (const node of document.querySelectorAll("[data-text]")) {
    node.textContent = text()[node.dataset.text];
  }
  element("question").placeholder = text().questionExample;
  element("language-button").textContent = text().language;
  document.querySelector(".design-panel .panel-kicker").textContent = text().decisionCounter;
  document.querySelector(".result-panel .panel-kicker").textContent = text().completedAnalysis;
  renderGuide();
  renderDesign();
  renderRun();
};

const renderGuide = () => {
  const confirmed = Boolean(state.confirmed);
  const needsPurpose = Boolean(state.design?.clarifying_questions?.length);
  setText("guide-number", confirmed ? "2" : "1");
  setText("guide-title", confirmed ? text().confirmAndRun : needsPurpose ? localizeStudyText(state.design.clarifying_questions[0].prompt) : text().reviewDefinition);
  setText("guide-body", confirmed ? text().confirmAndRunHelp : needsPurpose ? text().clarificationReason : text().reviewDefinitionHelp);
};

const updateRecoveryUrl = (sessionId, runId, jobId) => {
  const url = new URL(window.location.href);
  if (sessionId) url.searchParams.set("session_id", sessionId); else url.searchParams.delete("session_id");
  if (runId) url.searchParams.set("run_id", runId); else url.searchParams.delete("run_id");
  if (jobId) url.searchParams.set("job_id", jobId); else url.searchParams.delete("job_id");
  window.history.replaceState(null, "", url);
};

const runIdentifier = (run) => run?.artifact?.run_id ?? run?.artifact?.report_id ?? null;

const waitForRunJob = async (jobId) => {
  for (;;) {
    const job = await researchApi.getRunJob(jobId);
    if (job.status === "completed" && job.result) return job.result;
    if (job.status === "failed") {
      throw new ResearchApiError(job.error?.code ?? "LOCAL_RUN_FAILED", job.error?.message ?? "The local research run did not complete.");
    }
    const seconds = Math.max(0, Math.floor((job.elapsed_ms ?? 0) / 1000));
    const phase = {
      queued: state.language === "zh" ? "任务已保存，等待执行" : "Job saved and queued",
      initializing: state.language === "zh" ? "正在准备本地执行环境" : "Preparing the local execution environment",
      mapping_and_execution: state.language === "zh" ? "正在核对映射并扫描完整 MIMIC-IV 数据" : "Checking mappings and scanning the full MIMIC-IV archive",
      finalizing: state.language === "zh" ? "统计已完成，正在保存统一报告" : "Statistics completed; saving the unified report",
    }[job.phase] ?? (state.language === "zh" ? "正在执行本地统计" : "Running local statistics");
    element("activity").textContent = `${phase} · ${seconds}s`;
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
  }
};

const resetWorkspace = () => {
  stopProgramPolling();
  state.program = null;
  updateProgramRecoveryUrl();
  state.design = null;
  state.confirmed = null;
  state.plan = null;
  state.mappings = null;
  state.run = null;
  state.view = "home";
  state.editing = false;
  if (state.chartUrl) URL.revokeObjectURL(state.chartUrl);
  if (state.sensitivityChartUrl) URL.revokeObjectURL(state.sensitivityChartUrl);
  state.chartUrl = null;
  state.sensitivityChartUrl = null;
  state.pendingFallback = null;
  state.reviewedReusedDecisions.clear();
  updateRecoveryUrl();
  element("question-form").reset();
  element("error-panel").hidden = true;
  renderDesign();
  renderRun();
  renderProgram();
};

const downloadText = (name, content, type) => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  document.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 1_000);
};

const downloadBinary = async (url, fallbackName) => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ResearchApiError(
      body?.error?.code ?? "DOWNLOAD_FAILED",
      body?.error?.message ?? text().retry,
    );
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const matchedName = /filename="([^"]+)"/u.exec(disposition)?.[1];
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await response.blob());
  link.download = matchedName ?? fallbackName;
  document.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 1_000);
};

const reportError = (error) => {
  const message = error instanceof ResearchApiError
    ? `${text().apiErrors?.[error.code] ?? error.message} (${error.code})`
    : text().retry;
  setText("error-message", message);
  element("error-panel").hidden = false;
};

const renderFallbackAuthorization = (error) => {
  const details = error instanceof ResearchApiError && Array.isArray(error.details) ? error.details : [];
  const fallbackModel = details.find((detail) => detail.startsWith("fallback_model="))?.slice("fallback_model=".length) ?? "gpt-4o-mini";
  const attempts = details.filter((detail) => detail.startsWith("attempt=")).map((detail) => detail.replaceAll(";", " · "));
  state.pendingFallback = { question: questionElement().value.trim(), fallbackModel };
  setText("fallback-model", fallbackModel);
  setText("fallback-attempts", attempts.length ? attempts.join("\n") : text().fallbackAttemptsUnavailable);
  element("fallback-authorization-card").hidden = false;
};

const clearFallbackAuthorization = () => {
  state.pendingFallback = null;
  element("fallback-authorization-card").hidden = true;
};

element("language-button").addEventListener("click", () => {
  state.language = state.language === "zh" ? "en" : "zh";
  applyLanguage();
});

element("new-study-button").addEventListener("click", resetWorkspace);
element("back-button").addEventListener("click", resetWorkspace);
element("fallback-cancel-button").addEventListener("click", () => {
  clearFallbackAuthorization();
  setText("error-message", text().fallbackCancelled);
  element("error-panel").hidden = false;
});
element("fallback-authorize-button").addEventListener("click", async () => {
  if (state.busy || !state.pendingFallback) return;
  const pending = state.pendingFallback;
  if (questionElement().value.trim() !== pending.question) {
    clearFallbackAuthorization();
    setText("error-message", text().fallbackQuestionChanged);
    element("error-panel").hidden = false;
    return;
  }
  clearFallbackAuthorization();
  setBusy(true);
  element("error-panel").hidden = true;
  try {
    state.reviewedReusedDecisions.clear();
    state.design = await researchApi.start(pending.question, true);
    state.confirmed = null; state.plan = null; state.mappings = null; state.run = null; state.view = "design";
    updateRecoveryUrl(state.design.session_id); renderDesign(); renderRun(); await loadVariableMappings(false);
  } catch (error) { reportError(error); }
  finally { setBusy(false); }
});
element("recent-study-title").closest("button").addEventListener("click", () => {
  if (state.design) {
    state.view = state.run ? "analysis" : "design";
    renderStage();
  }
});
element("edit-design-button").addEventListener("click", () => {
  const spec = state.design?.study_spec;
  if (!spec) return;
  state.editing = true;
  renderDesign();
});
element("cancel-edit-button").addEventListener("click", () => {
  state.editing = false;
  renderDesign();
});
element("edit-design-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.design) return;
  setBusy(true);
  element("error-panel").hidden = true;
  try {
    state.design = await researchApi.continue(state.design.session_id, state.design.revision, {
      population: element("edit-population").value.trim(),
      index_event: element("edit-index-event").value.trim(),
      selection_rule: element("edit-selection-rule").value.trim(),
      exposure: element("edit-exposure").value.trim(),
      outcome: element("edit-outcome").value.trim(),
      summary_measure: element("edit-summary-measure").value.trim(),
    });
    state.confirmed = null;
    state.plan = null;
    state.mappings = null;
    state.run = null;
    state.view = "design";
    state.editing = false;
    renderDesign();
    renderRun();
    void loadVariableMappings(false).catch(reportError);
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
});
for (const stepButton of document.querySelectorAll("[data-workflow-step]")) {
  stepButton.addEventListener("click", () => {
    const step = stepButton.dataset.workflowStep;
    if ((step === "data" || step === "analysis" || step === "report") && !state.run) return;
    if (step === "question") {
      state.view = "question";
      renderStage();
      element("workspace-question").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    state.view = step;
    renderStage();
    if (step === "data") element("data-transparency").open = true;
    if (step === "analysis") element("analysis-transparency").open = true;
    if (step === "report") element("report-transparency").open = true;
    const target = step === "design" ? element("design-content") : element(`${step}-transparency`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
for (const starter of document.querySelectorAll("[data-question]")) {
  starter.addEventListener("click", () => {
    element("question").value = starter.dataset.question;
    element("question-form").requestSubmit();
  });
}
element("download-chart-svg").addEventListener("click", () => {
  const figure = state.run?.artifact.analysis?.publication_outputs?.figures?.[0];
  if (figure) downloadText(`${figure.id}.svg`, figure.content, figure.mime_type);
});
element("download-chart").addEventListener("click", async () => {
  const figure = state.run?.artifact.analysis?.publication_outputs?.figures?.[0];
  if (!figure) return;
  const image = new Image();
  const url = URL.createObjectURL(new Blob([figure.content], { type: figure.mime_type }));
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1400;
    canvas.height = 840;
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) downloadText("group-risks.png", blob, "image/png");
      URL.revokeObjectURL(url);
    }, "image/png");
  };
  image.src = url;
});
element("download-report-markdown").addEventListener("click", () => {
  if (state.run) downloadText("analysis-report.md", localizeReport(state.run.report_markdown), "text/markdown;charset=utf-8");
});
element("download-report").addEventListener("click", async () => {
  if (!state.run) return;
  try {
    await downloadBinary(
      researchApi.reportExportUrl(runIdentifier(state.run), "docx", state.language),
      "clinical-analysis-report.docx",
    );
  } catch (error) {
    reportError(error);
  }
});
element("download-report-pdf").addEventListener("click", async () => {
  if (!state.run) return;
  try {
    await downloadBinary(
      researchApi.reportExportUrl(runIdentifier(state.run), "pdf", state.language),
      "clinical-analysis-report.pdf",
    );
  } catch (error) {
    reportError(error);
  }
});
element("download-table").addEventListener("click", () => {
  const tables = state.run?.artifact.analysis?.publication_outputs?.tables ?? [];
  const table = tables.find((item) => item.id === "table_1") ?? tables[0];
  if (!table) return;
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = [table.columns, ...table.rows].map((row) => row.map(quote).join(",")).join("\r\n");
  downloadText("table-1.csv", `\ufeff${csv}`, "text/csv;charset=utf-8");
});

// Every submission — whatever the researcher happens to type — goes through the generic staged
// multi-objective pipeline (objective decomposition, per-objective compile/map/execute, report),
// never a fixed question. The input is preserved on failure so the researcher can retry as-is.
element("question-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy || isQuestionComposing || !questionElement().value.trim()) return;
  const originalQuestion = element("question").value.trim();
  clearFallbackAuthorization();
  element("error-panel").hidden = true;
  setBusy(true);
  try {
    await startProgram(originalQuestion, false);
  } catch (error) {
    if (error?.code === "DESIGN_MODEL_FALLBACK_AUTHORIZATION_REQUIRED") {
      reportError(error);
      renderFallbackAuthorization(error);
    } else reportError(error);
  } finally {
    setBusy(false);
  }
});

element("question").addEventListener("compositionstart", () => {
  isQuestionComposing = true;
});

element("question").addEventListener("compositionend", () => {
  isQuestionComposing = false;
});

element("question").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  if (event.isComposing || isQuestionComposing || event.shiftKey) return;
  if (state.busy) return;
  if (!questionElement().value.trim()) return;
  event.preventDefault();
  element("question-form").requestSubmit();
});

element("search-variable-mappings").addEventListener("click", async () => {
  state.mappingSearchStatus = "mappingSearching"; renderVariableMappings();
  setBusy(true); element("error-panel").hidden = true;
  try {
    await loadVariableMappings(true);
    state.mappingSearchStatus = state.mappings.status === "ready" ? "mappingSearchReady" : state.mappings.status === "needs_confirmation" ? "mappingSearchReview" : "mappingSearchBlocked";
    renderVariableMappings();
  } catch (error) {
    state.mappingSearchStatus = "mappingSearchFailed"; renderVariableMappings(); reportError(error);
  } finally { setBusy(false); }
});

element("confirm-button").addEventListener("click", async () => {
  if (!reusedReviewComplete()) return;
  setBusy(true);
  element("error-panel").hidden = true;
  try {
    state.confirmed = await researchApi.confirm(state.design.session_id, state.design.revision);
    state.mappingSearchStatus = "mappingSearching";
    renderDesign();
    state.plan = await researchApi.analysisPlan(state.design.session_id);
    await loadVariableMappings(true);
    state.mappingSearchStatus = state.mappings.status === "ready" ? "mappingSearchReady" : state.mappings.status === "needs_confirmation" ? "mappingSearchReview" : "mappingSearchBlocked";
    renderDesign();
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
});

element("run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  element("error-panel").hidden = true;
  try {
    const started = await researchApi.run(state.design.session_id, Number(element("threshold").value));
    if (started.job_id) updateRecoveryUrl(state.design.session_id, null, started.job_id);
    state.run = started.job_id ? await waitForRunJob(started.job_id) : started;
    state.view = "report";
    updateRecoveryUrl(state.design.session_id, runIdentifier(state.run));
    renderRun();
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
});

await loadRuntimeMode();
const workspaceDraftKey = "mimic-research-workspace-draft";
const developerLink = element("developer-status-link");
const currentWorkspacePath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
developerLink.href = `/developer?return_to=${encodeURIComponent(currentWorkspacePath)}`;
developerLink.addEventListener("click", () => {
  window.sessionStorage.setItem(workspaceDraftKey, element("question").value);
});
element("question").addEventListener("input", () => {
  window.sessionStorage.setItem(workspaceDraftKey, element("question").value);
});
const initialize = async () => {
  await loadRuntimeMode();
  applyLanguage();
  const parameters = new URLSearchParams(window.location.search);
  const programJobId = parameters.get("program_job_id");
  if (programJobId) {
    try {
      await resumeProgram(programJobId, parameters.get("program_question") ?? "");
    } catch (error) {
      reportError(error);
    }
    return;
  }
  const sessionId = parameters.get("session_id");
  if (!sessionId) {
    element("question").value = window.sessionStorage.getItem(workspaceDraftKey) ?? "";
    return;
  }
  try {
    const snapshot = await researchApi.getSession(sessionId);
    state.design = {
      assistant_message: state.language === "zh" ? "已恢复保存的研究设计。" : "The saved research design was restored.",
      warnings: [], clarifying_questions: [], suggestions: [], allowed_actions: [],
      ...snapshot,
    };
    state.confirmed = state.design.confirmed ?? null;
    state.mappingSearchStatus = state.confirmed ? "mappingSearching" : null;
    state.view = "design";
    renderDesign();
    renderRun();
    state.mappings = await researchApi.variableMappings(sessionId, false);
    if (state.confirmed) state.mappingSearchStatus = state.mappings.status === "ready" ? "mappingSearchReady" : state.mappings.status === "needs_confirmation" ? "mappingSearchReview" : "mappingSearchBlocked";
    renderVariableMappings();
    state.plan = state.confirmed ? await researchApi.analysisPlan(sessionId) : null;
    const runId = parameters.get("run_id");
    const jobId = parameters.get("job_id");
    state.run = runId ? await researchApi.getRun(runId) : jobId ? await waitForRunJob(jobId) : null;
    if (state.run) updateRecoveryUrl(sessionId, runIdentifier(state.run));
    state.view = state.run ? "report" : "design";
    renderDesign();
    renderRun();
  } catch (error) { reportError(error); }
};

void initialize();
