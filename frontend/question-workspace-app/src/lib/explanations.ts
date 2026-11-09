/**
 * Plain-language explanations shown when a reader clicks "why is this here" on a section, number or check.
 * Static, reviewed text (never model-generated) so the same wording can be audited and reused in reports.
 * Keys are the platform's own identifiers: check ids, estimate measures, method ids and section ids.
 */
export interface Bilingual { zh: string; en: string }
export interface Explanation { title: Bilingual; what: Bilingual; why: Bilingual; read: Bilingual }

const e = (title: Bilingual, what: Bilingual, why: Bilingual, read: Bilingual): Explanation => ({ title, what, why, read });

export const EXPLANATIONS: Record<string, Explanation> = {
  // Result checks
  variables_vary: e(
    { zh: "变量变异", en: "Variable variation" },
    { zh: "检查每个分析变量是否至少有两个不同的取值。", en: "Checks that every analysis variable takes at least two different values." },
    { zh: "取值全都相同的变量（例如所有人都用了药）无法比较，也会让模型无法拟合。", en: "A variable that is the same for everyone (for example, all patients took the drug) cannot be compared and breaks the model." },
    { zh: "通过：变量可以用来比较。未通过：需要重新定义或去掉该变量。", en: "Pass: the variable can be compared. Fail: redefine or drop it." },
  ),
  group_sizes: e(
    { zh: "组别规模", en: "Group sizes" },
    { zh: "检查比较的两组各自的人数，以及用药（暴露）者所占比例。", en: "Checks how many patients are in each compared group and what share is exposed." },
    { zh: "组太小，估计会很不稳定；暴露比例极端（低于约 2% 或高于约 98%）意味着几乎找不到可比的对照。", en: "Very small groups give unstable estimates, and an extreme exposed share (below about 2% or above about 98%) leaves almost no comparable patients." },
    { zh: "通过：每组至少 50 人且比例在 2%–98%。未通过：结果不应被信赖。", en: "Pass: at least 50 per group and an exposed share of 2%–98%. Fail: do not rely on the result." },
  ),
  outcome_events: e(
    { zh: "结局事件数", en: "Outcome events" },
    { zh: "数一数结局（例如死亡）实际发生了多少次，并与模型里的变量个数比较。", en: "Counts how many times the outcome (for example death) actually happened and compares it with the number of variables in the model." },
    { zh: "事件太少时，模型容易过拟合，置信区间会很宽，结论不可靠。", en: "With too few events the model overfits and the confidence interval becomes very wide." },
    { zh: "通过：至少 20 个事件，且每个模型参数至少 10 个事件。", en: "Pass: at least 20 events and at least 10 events per model parameter." },
  ),
  outcome_rate_plausible: e(
    { zh: "结局发生率", en: "Outcome rate" },
    { zh: "把结局的发生率与 MIMIC-IV 中同类结局的常见范围比较（例如住院死亡约 0.3%–15%）。", en: "Compares the outcome rate with the usual range for that outcome in MIMIC-IV (for example in-hospital death, about 0.3%–15%)." },
    { zh: "发生率远离常见范围，往往说明结局或人群定义出了问题，而不是真有差异。", en: "A rate far outside the usual range usually means the outcome or population was defined wrongly, not that there is a real difference." },
    { zh: "通过：在常见范围内。注意：请复核结局定义。", en: "Pass: within the usual range. Warning: re-check the outcome definition." },
  ),
  extreme_values: e(
    { zh: "极端值", en: "Extreme values" },
    { zh: "检查连续变量中是否有远离常见范围的数值（可能是录入或设备误差）。", en: "Looks for continuous values far outside the usual range, which may be recording or device errors." },
    { zh: "个别极端值会把平均数和回归结果拉偏。", en: "A few extreme values can pull averages and regression results off." },
    { zh: "注意：列出的变量有极端值，相关估计可能失真，需要复核。", en: "Warning: the listed variables have extreme values and related estimates may be distorted; review them." },
  ),
  missing_data: e(
    { zh: "缺失数据", en: "Missing data" },
    { zh: "统计因变量缺失而被排除的患者比例。", en: "Shows the share of patients excluded because a variable was missing." },
    { zh: "排除太多时，结果只代表被测过的患者，可能有偏。", en: "If too many are excluded, the result only describes the patients who were measured and may be biased." },
    { zh: "通过：被排除的不超过 30%。注意：需说明结果适用的人群。", en: "Pass: no more than 30% excluded. Warning: say which patients the result applies to." },
  ),
  covariate_balance: e(
    { zh: "协变量平衡", en: "Covariate balance" },
    { zh: "加权或匹配之后，两组在各个校正变量上的差异大小，用标准化均差（SMD）表示。", en: "How different the two groups remain on each adjusted variable after weighting or matching, shown as the standardised mean difference (SMD)." },
    { zh: "观察性数据里，用药组和未用药组本来就不同（病情、年龄等）。只有校正后两组足够相似，比较才接近随机分组。", en: "In observational data, treated and untreated patients differ at the start (illness, age and so on). Only if they are similar after adjustment does the comparison resemble randomisation." },
    { zh: "最大 SMD 越小越好，0.1 以下算均衡；高于 0.1 说明仍有差异，结果要谨慎。", en: "The smaller the largest SMD the better; below 0.1 is balanced. Above 0.1 differences remain, so read the result with caution." },
  ),
  weight_stability: e(
    { zh: "权重稳定性", en: "Weight stability" },
    { zh: "加权后的“有效样本量”占实际人数的比例。", en: "The share of patients that remains as the effective sample size after weighting." },
    { zh: "如果少数人的权重特别大，结果就被这几个人左右。", en: "If a few patients get very large weights, the result is driven by those few." },
    { zh: "通过：有效样本量不低于 30%。", en: "Pass: the effective sample size is at least 30%." },
  ),
  effect_size_plausible: e(
    { zh: "效应量", en: "Effect size" },
    { zh: "检查比值比或风险比是否落在常见范围（约 0.33–3）。", en: "Checks that the odds or hazard ratio falls in a usual range (about 0.33–3)." },
    { zh: "过大的效应通常来自混杂或数据问题，而不是药物本身。", en: "A very large effect usually comes from confounding or a data problem, not from the drug itself." },
    { zh: "通过：在常见范围内。注意：优先怀疑设计或数据。", en: "Pass: within the usual range. Warning: suspect the design or the data first." },
  ),
  severity_adjustment: e(
    { zh: "病情严重度校正", en: "Severity adjustment" },
    { zh: "检查分析是否校正了至少一个病情严重度指标（急诊入院、血管活性药、机械通气、肌酐、乳酸等）。", en: "Checks that the analysis adjusts for at least one measure of illness severity (emergency admission, vasopressors, ventilation, creatinine, lactate and so on)." },
    { zh: "病情越重的人越常用某些药，也越容易死亡。不校正严重度，药物可能被错误地看成有害。", en: "Sicker patients get certain drugs more often and also die more often. Without adjusting for severity a drug can wrongly look harmful." },
    { zh: "通过：已校正。注意：结果可能受适应证混杂影响。", en: "Pass: adjusted. Warning: the result may be affected by confounding by indication." },
  ),
  prediction_coverage: e(
    { zh: "模型适用的患者", en: "Who the model describes" },
    { zh: "预测模型只用了每个预测因子都有记录的患者。这里显示他们占队列的比例。", en: "A prediction model uses only patients with a record of every predictor. This shows their share of the cohort." },
    { zh: "只有一部分患者测过全部指标，而测得多的往往是病更重的人；模型在其他患者身上的表现是未知的。", en: "Only some patients have every measurement taken, and those measured most are usually the sicker ones; how the model performs in the others is unknown." },
    { zh: "通过：至少一半的队列有全部预测因子。出现“注意”时，不要把性能读作适用于所有患者。", en: "Pass: at least half the cohort has every predictor. When it shows a note, do not read the performance as applying to all patients." },
  ),
  outcome_timing: e(
    { zh: "结局发生时间", en: "Outcome timing" },
    { zh: "检查结局是否有发生日期。诊断编码属于整次住院，没有日期。", en: "Checks whether the outcome has a date. A diagnosis code belongs to the whole admission and has none." },
    { zh: "没有日期就无法证明事件发生在用药之后；它可能早已存在，甚至是用药的原因。", en: "Without a date the event cannot be shown to follow the drug; it may have existed before, or even be the reason for the drug." },
    { zh: "出现“注意”时，请把结果读作“与该诊断的关联”，不要读作“药物导致新发事件”。", en: "When it shows a note, read the result as an association with that diagnosis, not as the drug causing a new event." },
  ),
  mapping_confirmed: e(
    // pilot-1: report notices. "Pass" means nothing is waiting for confirmation, not that a person checked every mapping.
    { zh: "待确认的变量对应", en: "Variable mappings awaiting confirmation" },
    { zh: "检查是否还有变量对应的 MIMIC-IV 项目在等待确认。", en: "Checks whether the MIMIC-IV item behind any variable is still waiting for confirmation." },
    { zh: "对应错了项目，整个分析就是在回答另一个问题。", en: "If a variable points at the wrong item, the whole analysis answers a different question." },
    { zh: "通过：没有等待确认的变量，但这不代表对应一定正确。注意：先在“设计与变量”里核对。", en: "Pass: no variable is waiting for confirmation, which does not mean every mapping is right. Warning: check it in Design and variables first." },
  ),
  proportional_hazards: e(
    { zh: "比例风险假设", en: "Proportional hazards" },
    { zh: "检查风险比是否随时间保持不变（Cox 回归的前提）。", en: "Checks that the hazard ratio stays constant over time, which Cox regression assumes." },
    { zh: "假设不成立时，一个风险比会掩盖前期和后期的不同。", en: "When it does not hold, one hazard ratio hides different early and late effects." },
    { zh: "通过：可使用单一风险比。注意：应分时段报告。", en: "Pass: a single hazard ratio is fine. Warning: report by time period." },
  ),

  // Effect measures
  mean_difference: e(
    { zh: "均值差", en: "Mean difference" },
    { zh: "两组（或每增加一个单位的暴露）结局平均值的差。", en: "The difference in the average outcome between two groups, or per unit of exposure." },
    { zh: "结局是连续数值（血压变化、疼痛评分变化）时，差值最直观。", en: "When the outcome is a number (a change in blood pressure or pain score), a difference is the most direct summary." },
    { zh: "负值表示用药组更低；若 95% 置信区间包含 0，则没有明确差异。", en: "A negative value means the treated group is lower; if the 95% confidence interval includes 0 there is no clear difference." },
  ),
  odds_ratio: e(
    { zh: "比值比（OR）", en: "Odds ratio (OR)" },
    { zh: "用药组发生结局的“几率”除以对照组的几率。", en: "The odds of the outcome in the treated group divided by the odds in the comparison group." },
    { zh: "结局是“发生/不发生”（如死亡）时的标准效应量。", en: "The standard effect size when the outcome is yes or no, such as death." },
    { zh: "小于 1 表示风险较低，大于 1 较高，等于 1 无差异；区间包含 1 则不确定。", en: "Below 1 means lower risk, above 1 higher, 1 no difference; an interval that includes 1 is uncertain." },
  ),
  risk_difference: e(
    { zh: "风险差", en: "Risk difference" },
    { zh: "两组结局发生率的绝对差。", en: "The absolute difference in outcome rates between the two groups." },
    { zh: "比值比不好理解，风险差直接说“多（少）了几个百分点”。", en: "Odds ratios are hard to picture; a risk difference says how many percentage points higher or lower." },
    { zh: "负值表示用药组发生率更低，例如 −0.03 即低 3 个百分点。", en: "A negative value means a lower rate in the treated group; −0.03 is 3 percentage points lower." },
  ),
  hazard_ratio: e(
    { zh: "风险比（HR）", en: "Hazard ratio (HR)" },
    { zh: "比较两组在随访期间任一时刻发生结局的相对速度。", en: "Compares how fast the outcome occurs in the two groups at any moment of follow-up." },
    { zh: "结局与时间有关（生存分析）时使用，能利用被截尾的随访。", en: "Used when timing matters (survival analysis); it makes use of patients who were followed only part of the time." },
    { zh: "小于 1 表示风险更低；区间包含 1 则不确定。", en: "Below 1 means lower risk; an interval that includes 1 is uncertain." },
  ),
  total_effect: e(
    { zh: "总效应", en: "Total effect" },
    { zh: "暴露对结局的全部影响，等于直接效应加间接效应。", en: "The whole effect of the exposure on the outcome: the direct plus the indirect effect." },
    { zh: "中介分析先给出总效应，再拆成两部分。", en: "A mediation analysis starts from the total effect and then splits it in two." },
    { zh: "与前面的疗效分析方向应一致。", en: "It should point the same way as the main effect analysis." },
  ),
  direct_effect: e(
    { zh: "直接效应", en: "Direct effect" },
    { zh: "暴露不经过所研究的中介变量而产生的影响。", en: "The part of the effect that does not pass through the mediator under study." },
    { zh: "与间接效应对照，才能看出中介变量解释了多少。", en: "Set against the indirect effect, it shows how much the mediator explains." },
    { zh: "与间接效应方向相反时，说明不是简单的“经由中介”。", en: "If it points the opposite way to the indirect effect, the pathway is not a simple one through the mediator." },
  ),
  indirect_effect: e(
    { zh: "间接效应（中介效应）", en: "Indirect (mediated) effect" },
    { zh: "暴露经由中介变量（例如降压幅度）传递到结局的那部分影响。", en: "The part of the effect that travels through the mediator (for example the size of the blood-pressure drop)." },
    { zh: "用来回答“某个作用在整体疗效中贡献了多少”。", en: "It answers how much a particular mechanism contributes to the overall effect." },
    { zh: "数值很小或区间包含 0，说明中介贡献很少。", en: "A very small value or an interval including 0 means the mediator contributes little." },
  ),
  proportion_mediated: e(
    { zh: "中介比例", en: "Proportion mediated" },
    { zh: "间接效应占总效应的比例。", en: "The share of the total effect that is indirect." },
    { zh: "给出一个“贡献度”的直观数字。", en: "Gives one intuitive number for the contribution." },
    { zh: "只有直接与间接效应同向时才可解释；方向相反（不一致中介）时该比例无意义。", en: "It is only interpretable when the direct and indirect effects point the same way; with opposite signs (inconsistent mediation) it is meaningless." },
  ),
  p_interaction: e(
    { zh: "交互作用 P 值", en: "Interaction P value" },
    { zh: "检验药物的效应在亚组之间（例如男性与女性）是否不同。", en: "Tests whether the drug's effect differs between subgroups such as men and women." },
    { zh: "回答“性别（或年龄）是否改变疗效”。", en: "It answers whether sex, age or another factor changes the effect." },
    { zh: "P 小于 0.05 提示效应不同；不小于 0.05 只表示证据不足，不等于证明没有差异。", en: "Below 0.05 suggests the effect differs; otherwise there is not enough evidence, which is not proof of no difference." },
  ),

  // Methods
  "treatment.iptw": e(
    { zh: "逆概率加权（IPTW）", en: "Inverse probability weighting (IPTW)" },
    { zh: "根据每个患者“被分到所在组”的概率给他加权，使两组的背景变得相似。", en: "Weights each patient by the probability of being in his or her group so the two groups look alike at baseline." },
    { zh: "观察性数据里不能随机分组，加权是常用的替代办法，并且保留了全部患者。", en: "Patients cannot be randomised in observational data; weighting is a common substitute and keeps every patient." },
    { zh: "先看“协变量平衡”和“权重稳定性”两项检查，再读效应值。", en: "Read the covariate-balance and weight-stability checks before the effect." },
  ),
  "treatment.psm": e(
    { zh: "倾向性评分匹配", en: "Propensity-score matching" },
    { zh: "为每个用药患者找一个背景最相似的对照患者配成一对。", en: "Pairs every treated patient with the most similar comparison patient." },
    { zh: "直观，容易向临床医生解释；代价是没配上的患者被丢弃。", en: "Easy to explain to clinicians, at the price of discarding unmatched patients." },
    { zh: "注意匹配后保留了多少人，以及平衡是否达标。", en: "Check how many patients remain after matching and whether balance is reached." },
  ),
  "regression.adjusted": e(
    { zh: "多因素回归校正", en: "Adjusted regression" },
    { zh: "把可能的混杂因素直接放进回归模型里一起估计。", en: "Puts the likely confounders straight into the regression model." },
    { zh: "简单、透明，常作为对照方法交叉验证主要结果。", en: "Simple and transparent; often used to cross-check the main result." },
    { zh: "结果依赖模型形式；与加权/匹配结果方向一致更可信。", en: "It depends on the model form; agreement with weighting or matching makes the result more credible." },
  ),
  "regression.rcs": e(
    { zh: "受限立方样条回归", en: "Restricted cubic spline regression" },
    { zh: "允许剂量与结局之间是弯曲的关系，而不只是一条直线。", en: "Lets the dose-outcome relation bend instead of forcing a straight line." },
    { zh: "剂量-反应关系常常不是直线；样条给出总体趋势和“是否非线性”的检验。", en: "Dose-response is rarely a straight line; a spline gives the overall trend and a test for non-linearity." },
    { zh: "非线性 P 值很小时，只用单一斜率会掩盖真实曲线，请看曲线图。", en: "When the non-linearity P value is small a single slope hides the real curve; look at the curve figure." },
  ),
  "modification.iptw_interaction": e(
    { zh: "倾向性加权交互作用分析", en: "Propensity-weighted interaction analysis" },
    { zh: "在每个亚组（如男、女）内分别做逆概率加权，给出该亚组内的效应；效应差异检验比较这些亚组效应是否相同（稳健标准误）。", en: "Weights patients within each subgroup, such as men and women, and reports the effect inside it; the test for a difference compares those subgroup effects (robust standard errors)." },
    { zh: "治疗比较要在每个亚组内都平衡背景，才能比较亚组之间的效应。", en: "A treatment comparison needs balanced backgrounds inside each subgroup before the subgroups can be compared." },
    { zh: "先看效应差异检验 P，再看两个亚组的估计和区间；检验比较的正是这两个估计。", en: "Read the P for difference first, then the two subgroup estimates and intervals; the test compares exactly those estimates." },
  ),
  "modification.interaction": e(
    { zh: "交互作用检验与分层估计", en: "Interaction test with stratified estimates" },
    { zh: "在模型里加入“药物×亚组”项，并分别给出每个亚组内的效应。", en: "Adds a treatment-by-subgroup term and reports the effect inside each subgroup." },
    { zh: "回答“效应在不同亚组（如性别）是否不同”。", en: "Answers whether the effect differs between subgroups such as sex." },
    { zh: "先看交互 P 值，再看各亚组的估计和区间是否重叠。", en: "Read the interaction P value first, then see whether subgroup estimates and intervals overlap." },
  ),
  "mediation.mediate": e(
    { zh: "因果中介分析", en: "Causal mediation analysis" },
    { zh: "把总效应拆成“经由中介变量的间接效应”和“直接效应”。", en: "Splits the total effect into an indirect effect through the mediator and a direct effect." },
    { zh: "用来回答“某个作用（如降压）在疗效中贡献了多少”。", en: "Used to answer how much one mechanism, such as blood-pressure lowering, contributes to the effect." },
    { zh: "依赖较强的假设，结果只作机制线索，不是证明。", en: "It rests on strong assumptions, so treat it as a clue about mechanism, not proof." },
  ),
  "survival.cox": e(
    { zh: "Cox 比例风险回归", en: "Cox proportional-hazards regression" },
    { zh: "考虑事件发生的时间，估计两组的风险比。", en: "Takes the timing of events into account and estimates the hazard ratio between groups." },
    { zh: "随访时间长短不同的患者都能被利用。", en: "Patients with different follow-up lengths all contribute." },
    { zh: "同时核对“比例风险假设”检查。", en: "Check the proportional-hazards check beside it." },
  ),

  // Report sections
  patient_flow: e(
    { zh: "患者流程", en: "Patient flow" },
    { zh: "从评估的全部住院（或 ICU 入住）开始，逐步列出排除的人数与原因，直到进入分析的人数。", en: "Starts from every admission (or ICU stay) assessed and lists who was excluded and why, down to the patients analysed." },
    { zh: "让读者知道结论适用于哪些人，以及排除是否可能带来偏倚。", en: "It tells the reader who the conclusion applies to and whether exclusions could bias it." },
    { zh: "留意“进入队列”与“模型实际纳入”的差别：后者是完整数据的人数。", en: "Note the gap between the cohort and the patients the model actually used (those with complete data)." },
  ),
  baseline_table: e(
    { zh: "基线表（Table 1）", en: "Baseline table (Table 1)" },
    { zh: "列出各组患者在开始时的特征（年龄、性别、病情等）及组间差异。", en: "Lists the starting characteristics of each group (age, sex, severity and so on) and how they differ." },
    { zh: "先看两组本来是否可比，才能判断后面的比较是否公平。", en: "You need to see whether the groups were comparable before judging whether the comparison is fair." },
    { zh: "SMD 是标准化均差：绝对值越大，两组在该特征上越不同。", en: "SMD is the standardised mean difference: the larger its absolute value, the more the groups differ on that feature." },
  ),
  figures: e(
    { zh: "图表", en: "Figures" },
    { zh: "把表格里的数字画成图，便于一眼看出模式。", en: "Draws the table numbers as pictures so patterns are visible at a glance." },
    { zh: "每张图对应一项检查或结果。", en: "Each figure supports one check or result." },
    { zh: "图只是辅助，结论以表格数字和置信区间为准。", en: "Figures are an aid; conclusions rest on the table numbers and intervals." },
  ),
  "ps_overlap.png": e(
    { zh: "倾向评分重叠度", en: "Propensity-score overlap" },
    { zh: "两组患者“被分到用药组的概率”的分布。", en: "The distribution of each patient's probability of being in the treated group, for both groups." },
    { zh: "两条曲线只有大面积重叠，才有可比的对照患者。", en: "Comparable patients exist only where the two curves overlap substantially." },
    { zh: "几乎不重叠说明两组本质不同，结果不可靠。", en: "Almost no overlap means the groups differ fundamentally and the result is unreliable." },
  ),
  "balance.png": e(
    { zh: "加权前后协变量平衡", en: "Covariate balance before and after weighting" },
    { zh: "每个校正变量在加权前后的标准化均差（Love 图）。", en: "The standardised mean difference of each adjusted variable before and after weighting (a Love plot)." },
    { zh: "直接展示加权是否让两组变得相似。", en: "Shows directly whether weighting made the groups alike." },
    { zh: "加权后的点应靠近 0，并落在 0.1 的界线内。", en: "After weighting the points should sit near 0 and inside the 0.1 limit." },
  ),
  "estimates.png": e(
    { zh: "效应估计图", en: "Effect estimates" },
    { zh: "把各方法或各亚组的效应值与置信区间画在同一张图上。", en: "Plots the effect and its confidence interval for each method or subgroup together." },
    { zh: "便于比较不同方法的结论是否一致。", en: "Makes it easy to see whether different methods agree." },
    { zh: "区间跨过无效线（比值比 1 或差值 0）表示没有明确差异。", en: "An interval crossing the no-effect line (1 for a ratio, 0 for a difference) means no clear difference." },
  ),
  "dose_response.png": e(
    { zh: "剂量-反应曲线", en: "Dose-response curve" },
    { zh: "结局随剂量变化的曲线，阴影为置信区间。", en: "How the outcome changes with dose; the shaded band is the confidence interval." },
    { zh: "能看出关系是直线、弯曲，还是在某个剂量后趋平。", en: "Shows whether the relation is straight, curved or flattens beyond some dose." },
    { zh: "曲线弯曲时，单一斜率会误导。", en: "When the curve bends, a single slope misleads." },
  ),
  "effect_modification.png": e(
    { zh: "亚组效应", en: "Subgroup effects" },
    { zh: "每个亚组（如男、女）的效应值和置信区间。", en: "The effect and interval within each subgroup, such as men and women." },
    { zh: "直观比较效应在亚组之间是否不同。", en: "A direct way to compare whether the effect differs between subgroups." },
    { zh: "两个区间大面积重叠时，交互 P 值通常也不显著。", en: "When the two intervals overlap widely the interaction P value is usually not significant." },
  ),
  "quartiles.png": e(
    { zh: "剂量四分位比较", en: "Dose quartile comparison" },
    { zh: "把剂量分成四等份，每一份与最低剂量组比较。", en: "Splits dose into four equal parts and compares each with the lowest-dose group." },
    { zh: "不依赖曲线形状，便于向临床解释。", en: "Does not depend on a fitted curve and is easy to explain clinically." },
    { zh: "区间包含 0 的组与最低组没有明确差异。", en: "A group whose interval includes 0 does not clearly differ from the lowest group." },
  ),
  design_variables: e(
    { zh: "设计与变量", en: "Design and variables" },
    { zh: "列出每个变量在 MIMIC-IV 里怎么定义、取自哪张表、在哪个时间窗内取值。", en: "Lists how each variable is defined in MIMIC-IV, which table it comes from and which time window it is taken from." },
    { zh: "别人才能复核并复现这项分析，也能发现定义是否与原意相符。", en: "It lets others check and reproduce the analysis and see whether the definition matches the intent." },
    { zh: "重点核对暴露、结局和时间窗；这里的备选方法还可重新分析。", en: "Check the exposure, outcome and time windows; other methods listed here can be re-run." },
  ),
};
