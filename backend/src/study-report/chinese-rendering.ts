import type { PlanOutcome, QuestionRunResult } from "../question-pipeline/index.js";

/**
 * Deterministic Chinese wording for the parts of the report that the study spec holds in English.
 * Nothing here calls a model: Chinese labels come from the user's own words in the study frames, then from a small
 * static glossary, and English is the fallback so no information is ever dropped.
 */

type Frame = QuestionRunResult["frame_set"]["frames"][number];
type Spec = PlanOutcome["study_spec"];
type Variable = NonNullable<Spec["covariates"]>[number];
type Window = NonNullable<Spec["time_windows"]>[number];

export type ZhLabeler = (englishName: string) => string | undefined;

const GLOSSARY: Record<string, string> = {
  "age": "年龄", "sex": "性别", "gender": "性别", "charlson comorbidity index": "Charlson 合并症指数", "emergency admission": "急诊入院",
  "vasopressors": "血管活性药物", "invasive mechanical ventilation": "有创机械通气", "creatinine": "肌酐", "lactate": "乳酸",
  "all-cause death": "全因死亡", "all-cause mortality": "全因死亡", "death": "死亡", "mortality": "死亡", "pain score": "疼痛评分", "blood pressure": "血压",
  "systolic blood pressure": "收缩压", "diastolic blood pressure": "舒张压", "mean arterial pressure": "平均动脉压", "heart rate": "心率",
  "length of stay": "住院时长", "icu length of stay": "ICU 住院时长", "hospital length of stay": "住院时长", "n": "N（人数）",
  "hypertension": "高血压", "diabetes": "糖尿病", "sepsis": "脓毒症", "acute kidney injury": "急性肾损伤",
  "average causal mediation effect": "平均因果中介效应", "average direct effect": "平均直接效应", "total effect": "总效应", "proportion mediated": "中介比例",
  "propensity score overlap": "倾向评分重叠度",
};
const ROLE: Record<string, string> = { population: "人群", exposure: "暴露", outcome: "结局", covariate: "协变量", index_time: "时间零点", predictor: "预测变量", comparator: "对照", characteristic: "描述特征", grouping: "分组" };
const MAPPING_STATUS: Record<string, string> = { resolved: "已确定", needs_confirmation: "待确认", unresolved: "未确定" };
const UNIT: Record<string, string> = { minute: "分钟", hour: "小时", day: "天", week: "周", month: "个月", year: "年" };
const AGGREGATION: Record<string, string> = { maximum: "最高", minimum: "最低", mean: "平均", first: "首次", last: "末次", median: "中位数", sum: "累计" };
const COMPARISON: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤" };
const TABLE_CAPTION: Record<string, string> = { balance: "协变量平衡", number_at_risk: "风险人数", median_survival: "中位生存时间", selected_predictors: "入选预测变量" };

const key = (text: string): string => text.trim().toLowerCase();
const listZh = (items: string[]): string => items.join("、");

/** Chinese words the user wrote for each English concept name, taken from the frames' slots. */
export const buildLabeler = (frames: Frame[]): ZhLabeler => {
  const book = new Map<string, string>();
  const remember = (english: string | undefined, chinese: string | undefined): void => { if (english && chinese && !book.has(key(english))) book.set(key(english), chinese); };
  for (const frame of frames) {
    const slots = [frame.population, frame.exposure, frame.outcome, ...(frame.modifiers ?? []), ...(frame.mediators ?? []), ...(frame.predictors ?? []), ...(frame.characteristics ?? [])];
    for (const slot of slots) {
      if (!slot) continue;
      remember(slot.normalized?.label_en, slot.text);
      for (const item of slot.categories_normalized ?? []) remember(item.label_en, item.text);
      for (const item of slot.components_normalized ?? []) remember(item.label_en, item.text);
      // components_resolved is deliberately not used: a component can be replaced by the closest measurable concept (cardiovascular death → all-cause death), and that concept must not borrow the replaced component's Chinese words.
    }
  }
  return (name) => {
    const found = book.get(key(name)) ?? GLOSSARY[key(name)];
    if (found) return found;
    const baseline = name.match(/^Baseline (.+)$/u);
    const baselineOf = baseline ? (book.get(key(baseline[1]!)) ?? GLOSSARY[key(baseline[1]!)]) : undefined;
    if (baselineOf) return `基线${baselineOf}`;
    const change = name.match(/^(.+) change$/iu);
    const base = change ? (book.get(key(change[1]!)) ?? GLOSSARY[key(change[1]!)]) : undefined;
    if (base) return `${base}变化`;
    const composite = name.match(/^(.+) \((.+ or .+)\)$/u);
    if (composite) {
      const head = book.get(key(composite[1]!)) ?? GLOSSARY[key(composite[1]!)];
      const parts = composite[2]!.split(" or ").map((part) => book.get(key(part)) ?? GLOSSARY[key(part)]);
      if (head && parts.every(Boolean)) return `${head}（${parts.join("或")}）`;
    }
    return undefined;
  };
};

/** The concept names of the frames' demographic slots (age, sex…): recorded for the patient, so no time window is stated for them. */
export const buildDemographicNames = (frames: Frame[]): Set<string> => {
  const names = new Set<string>();
  for (const frame of frames) {
    for (const slot of [frame.exposure, ...(frame.characteristics ?? [])]) if (slot?.normalized?.category === "demographic") names.add(key(slot.normalized.label_en ?? slot.text));
  }
  return names;
};

const label = (name: string, zh: ZhLabeler): string => zh(name) ?? name;
const labelList = (names: string[], zh: ZhLabeler): string => listZh(names.map((name) => label(name, zh)));
/** "中文（English）" for the mapping table; the English term alone when no Chinese is known. */
export const variableLabel = (name: string, zh: ZhLabeler): string => { const found = zh(name); return found && found !== name ? `${found}（${name}）` : name; };
/**
 * Replaces the study's English variable names inside a Chinese sentence (the protocol table's emulation text, written by another
 * module) with their Chinese labels; a name with no known Chinese label is left as it is.
 */
export const localizeNames = (text: string, names: string[], zh: ZhLabeler): string => {
  const ordered = [...new Set(names)].filter((name) => name && zh(name) && zh(name) !== name).sort((a, b) => b.length - a.length);
  let result = text;
  for (const name of ordered) {
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    result = result.replaceAll(new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, "gu"), zh(name)!);
  }
  return result;
};
export const roleLabel = (role: string): string => ROLE[role] ?? role;
export const mappingStatusLabel = (status: string): string => MAPPING_STATUS[status] ?? status;
export const tableCaption = (name: string): string => TABLE_CAPTION[name] ?? name.replaceAll("_", " ");

const DEMOGRAPHIC_ZH = (name: string): string => `患者记录的${name}（人口学属性，不按时间窗读取）`;
const windowOf = (spec: Spec, purpose: Window["purpose"]): Window | undefined => spec.time_windows?.find((window) => window.purpose === purpose);
const span = (window: Window | undefined, fallback: string): string => !window ? fallback : "end_event" in window ? "随访期间（至住院结束）" : `时间零点后 ${window.start_offset}–${window.end_offset} ${UNIT[window.unit] ?? window.unit}内`;
const followUp = (window: Window | undefined): string => !window || "end_event" in window ? "随访期间" : `时间零点后 ${window.end_offset} ${UNIT[window.unit] ?? window.unit}内`;

/** Exposure or predictor: "名称：…" from its contrast and aggregation. */
export const exposureDefinition = (variable: Variable, spec: Spec, zh: ZhLabeler, demographic?: Set<string>): string => {
  const name = label(variable.name, zh); const when = span(windowOf(spec, "exposure"), "时间零点后 0–24 小时内");
  const contrast = variable.contrast;
  if (demographic?.has(key(variable.name)) && contrast?.kind !== "threshold" && contrast?.kind !== "binary_presence" && !variable.aggregation) return `${name}：${DEMOGRAPHIC_ZH(name)}`;
  if (contrast?.kind === "threshold") return `${name}：${when}${name}${COMPARISON[contrast.operator]}${contrast.value}${contrast.unit ?? ""}`;
  if (contrast?.kind === "binary_presence" || variable.aggregation === "any") return `${name}：${when}有任何${name}记录`;
  if (variable.aggregation === "sum") return `${name}：${when}${name}的累计量`;
  if (variable.aggregation && AGGREGATION[variable.aggregation]) return `${name}：${when}${AGGREGATION[variable.aggregation]}${name}记录值`;
  if (variable.aggregation === "count") return `${name}：${when}${name}记录次数`;
  return `${name}：${when}的${name}（按变量定义汇总）`;
};

const differenceText = (variable: Variable, zhName: ZhLabeler): string | undefined => {
  const derivation = variable.derivation; if (!derivation) return undefined;
  const source = label(derivation.source_concept, zhName); const how = AGGREGATION[derivation.aggregation] ?? "";
  const win = (window: Window): string => "end_event" in window ? "随访结束" : `${window.start_offset}–${window.end_offset} ${UNIT[window.unit] ?? window.unit}`;
  return `时间零点后 ${win(derivation.follow_up)}的${how}${source}减去 ${win(derivation.baseline)}的${how}${source}`;
};

/** Outcome: composite, time to event, change, threshold, count, mean or presence, each in Chinese. */
export const outcomeDefinition = (variable: Variable, spec: Spec, zh: ZhLabeler): string => {
  const name = label(variable.name, zh); const contrast = variable.contrast; const window = windowOf(spec, "outcome");
  const difference = differenceText(variable, zh);
  if (difference) return `${name}：${difference}`;
  const operands = variable.definition?.kind === "any" ? variable.definition.operands.flatMap((operand) => "concept" in operand ? [operand.concept] : []) : [];
  if (operands.length) return `${name}：以下任一事件${variable.aggregation === "first" ? "首次发生的时间" : "发生"}：${labelList(operands, zh)}`;
  if (contrast?.kind === "threshold") return `${name}：${followUp(window)}${name}${COMPARISON[contrast.operator]}${contrast.value}${contrast.unit ?? ""}`;
  if (variable.aggregation === "first") return `${name}：从时间零点到${name}的时间，随访结束时删失`;
  if (variable.aggregation === "count") return `${name}：${followUp(window)}${name}记录次数`;
  if (variable.aggregation === "mean") return `${name}：${followUp(window)}${name}的均值（已记录值）`;
  return `${name}：${followUp(window)}发生任何${name}`;
};

/** A described characteristic: read in the first 24 hours, or over the outcome window when it is an outcome-type concept. */
export const characteristicDefinition = (variable: Variable, spec: Spec, zh: ZhLabeler, demographic?: Set<string>): string => {
  const name = label(variable.name, zh); const contrast = variable.contrast;
  const fixed = Boolean(demographic?.has(key(variable.name)));
  if (fixed && contrast?.kind !== "threshold") return `${name}：${DEMOGRAPHIC_ZH(name)}`;
  const when = fixed ? "患者记录的" : variable.role === "outcome" ? followUp(windowOf(spec, "outcome")) : span(windowOf(spec, "baseline"), "时间零点后 0–24 小时内");
  if (contrast?.kind === "threshold") return `${name}：${when}${name}${COMPARISON[contrast.operator]}${contrast.value}${contrast.unit ?? ""}的比例`;
  if (variable.aggregation && AGGREGATION[variable.aggregation]) return `${name}：${when}${AGGREGATION[variable.aggregation]}${name}记录值`;
  return `${name}：${when}的${name}（按变量定义；是/否特征为有无记录）`;
};

export const covariateList = (variables: Variable[] | undefined, zh: ZhLabeler): string => variables?.length ? labelList(variables.map(({ name }) => name), zh) : "–";

export const timeZeroText = (index: NonNullable<Spec["index_time"]>): string => {
  const event = { "hospital admission": "入院", "ICU admission": "ICU 入住" }[index.event];
  const rule = { "first hospital admission per patient": "每位患者的首次住院", "first ICU stay per patient": "每位患者的首次 ICU 入住" }[index.selection_rule];
  return event && rule ? `${event}（${rule}）` : `${index.event} (${index.selection_rule})`;
};

/** Estimate labels such as "Drug (IPTW)" or "Drug in Gender = F": the concept is translated, the method tag stays. */
const LEVEL: Record<string, string> = { yes: "是", no: "否" };
const TAG: Record<string, string> = { "risk difference": "风险差", overall: "总体" };
/** "Sex: F" (one level of a categorical variable) keeps the level and translates the variable. */
const levelled = (text: string, zh: ZhLabeler): string => { const level = text.match(/^(.+): (.+)$/u); return level && zh(level[1]!) ? `${label(level[1]!, zh)}：${LEVEL[level[2]!] ?? level[2]}` : label(text, zh); };
export const estimateLabel = (text: string, zh: ZhLabeler): string => {
  const whole = zh(text); if (whole) return whole;
  const stratum = text.match(/^(.+) in (.+) = (.+)$/u);
  if (stratum) return `${levelled(stratum[1]!, zh)}（${label(stratum[2]!, zh)} = ${LEVEL[stratum[3]!] ?? stratum[3]}）`;
  const tagged = text.match(/^(.+?) \((.+)\)$/u);
  if (tagged) return `${levelled(tagged[1]!, zh)}（${TAG[tagged[2]!] ?? tagged[2]}）`;
  // A description's group column ("Administrative sex = F").
  const group = text.match(/^(.+) = (.+)$/u);
  if (group && zh(group[1]!)) return `${label(group[1]!, zh)} = ${LEVEL[group[2]!] ?? group[2]}`;
  return levelled(text, zh);
};

export const figureCaption = (title: string, zh: ZhLabeler): string => {
  if (title === "Covariate balance before and after weighting") return "加权前后协变量平衡";
  const effect = title.match(/^Effect of (.+?)(?: by (.+))?$/u);
  if (effect) return effect[2] ? `${label(effect[1]!, zh)}的效应（按${label(effect[2], zh)}分层）` : `${label(effect[1]!, zh)}的效应`;
  return label(title, zh);
};

type Template = [RegExp, (match: string[], zh: ZhLabeler) => string];
const UNIT_TEXT = (unit: string): string => UNIT[unit] ?? unit;
const REASON: Array<[RegExp, string]> = [[/^An event defined only by diagnosis codes of the index admission .*such components are not used as outcomes\.$/u, "仅由本次住院诊断编码定义的事件（如心肌梗死或中风），无法证明其发生在暴露之后，因为诊断编码在出院时才赋予且包含入院原因；此类成分不作为结局。"]];

const ASSUMPTIONS: Template[] = [
  [/^The analysis unit is each patient's first (hospital admission|ICU stay) that meets the population definition; if it lacks the exposure or the outcome, the patient is excluded rather than analysed at a later (?:admission|ICU stay); time zero is (hospital admission|ICU admission)\.$/u, (m) => `分析单位为每位患者符合人群定义的首次${m[1] === "ICU stay" ? " ICU 入住" : "住院"}；若该次缺少暴露或结局，则排除该患者，不以其后续${m[1] === "ICU stay" ? " ICU 入住" : "住院"}替代；时间零点为${m[2] === "ICU admission" ? " ICU 入住" : "入院"}。`],
  [/^The analysis unit is each patient's first eligible (hospital admission|ICU stay): one that meets the population definition and, when follow-up starts after time zero \(a landmark or a prediction time\), is still in (?:hospital|the ICU) and without the outcome then; if it lacks the exposure or the outcome, the patient is excluded rather than analysed at a later (?:admission|ICU stay); time zero is (hospital admission|ICU admission)\.$/u, (m) => `分析单位为每位患者首次符合条件的${m[1] === "ICU stay" ? " ICU 入住" : "住院"}：符合人群定义，且随访起点晚于时间零点（界标或预测时间点）时，在随访起点${m[1] === "ICU stay" ? "仍在 ICU" : "仍在院"}、尚未发生结局；若该次缺少暴露或结局，则排除该患者，不以其后续${m[1] === "ICU stay" ? " ICU 入住" : "住院"}替代；时间零点为${m[2] === "ICU admission" ? " ICU 入住" : "入院"}。`],
  [/^The analysis unit is each patient's first (hospital admission|ICU stay) that meets the population definition; time zero is (hospital admission|ICU admission)\.$/u, (m) => `分析单位为每位患者符合人群定义的首次${m[1] === "ICU stay" ? " ICU 入住" : "住院"}；时间零点为${m[2] === "ICU admission" ? " ICU 入住" : "入院"}。`],
  [/^Exposures and baseline factors are taken from the first (\d+(?:\.\d+)?) hours after time zero, so later treatment cannot be counted as exposure\.$/u, (m) => `暴露和基线因素取自时间零点后最初 ${m[1]} 小时，因此之后的治疗不会被计为暴露。`],
  [/^Outcomes are followed for (\d+(?:\.\d+)?) (\w+)\(s\) after time zero\.$/u, (m) => `结局在时间零点后随访 ${m[1]} ${UNIT_TEXT(m[2]!)}。`],
  [/^Outcomes are followed until the end of the index encounter because no horizon was stated\.$/u, () => "未说明随访期限，因此结局随访至本次住院结束。"],
  [/^The change is measured from (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?) hours after time zero; the question states (\d+(?:\.\d+)?) (\w+)\(s\)\.$/u, (m) => `变化量在时间零点后 ${m[1]}–${m[2]} 小时测量；问题所述为 ${m[3]} ${UNIT_TEXT(m[4]!)}。`],
  [/^Predictions are made at (\d+) hours after time zero, when the predictor window ends \(a landmark\): (units discharged or dead|units whose ICU stay ended \(transfer out of the ICU, discharge or death\)) before then, or with the outcome (recorded between time zero and then|already recorded then \(after time zero, or earlier in the same admission\)), are excluded, and the outcome is counted from \d+ hours (?:to (\d+(?:\.\d+)?) (\w+)\(s\) after time zero|after time zero to the end of the index encounter)\.$/u,
    (m) => `预测时间点为时间零点后 ${m[1]} 小时，即预测因子窗口结束时（界标）：此前${m[2]!.includes("ICU") ? " ICU 入住已结束（转出 ICU、出院或死亡）" : "已出院或死亡"}、或${m[3]!.startsWith("already") ? "此前已记录结局（时间零点后，或同次住院更早时）" : "在时间零点至该时间点之间已记录结局"}的患者不纳入；结局自时间零点后 ${m[1]} 小时起计算，${m[4] ? `至时间零点后 ${m[4]} ${UNIT_TEXT(m[5]!)}` : "至本次住院结束"}。`],
  [/^The stated horizon of (\d+(?:\.\d+)?) hour\(s\) ends inside the predictor window, so it is counted from the prediction time\.$/u, (m) => `所述 ${m[1]} 小时时限在预测因子窗口内结束，因此从预测时间点起计算。`],
  [/^Age, sex and the Charlson comorbidity index \(Quan (\d+) ICD coding\) are the default adjustment variables \(compiler ([\d.]+)\)\.$/u, (m) => `年龄、性别和 Charlson 合并症指数（Quan ${m[1]} ICD 编码）为默认校正变量（编译器 ${m[2]}）。`],
  [/^No population was stated; all adult patients in MIMIC-IV are analysed\.$/u, () => "未说明研究人群；分析 MIMIC-IV 中的全部成年患者。"],
  [/^A description reports the number of patients, Table 1 and each characteristic's proportion or mean with its 95% confidence interval, in the whole cohort and in each group; nothing is adjusted, so a difference between groups is not an effect\. Each characteristic is described among the patients in whom it is recorded \(compiler ([\d.]+)\)\.$/u,
    (m) => `描述性研究报告患者人数、基线表以及每个特征的比例或均值及其 95% 置信区间（整个队列及各组）；不做任何校正，组间差异不是效应。每个特征在有记录的患者中描述（编译器 ${m[1]}）。`],
  [/^The population “(.+)” was inferred but is not stated in the question, so it is not applied; state a population to restrict the analysis\.$/u, (m) => `人群“${m[1]}”是推断得出、问题中并未提及，因此未应用；如需限定人群请明确说明。`],
  [/^“(.+)” states only the care setting or age group; no further population restriction is applied \(MIMIC-IV contains adults only\)\.$/u, (m) => `“${m[1]}”仅说明了诊疗场所或年龄组；不再增加人群限制（MIMIC-IV 仅包含成年人）。`],
  [/^“(.+)” only repeats part of the exposure “(.+)”, so it is not used as a population restriction\.$/u, (m) => `“${m[1]}”只是重复了暴露“${m[2]}”的一部分，因此不作为人群限制。`],
  [/^“(.+)” was read as the levels of the effect modifier, because this aim asks whether an effect differs between them\.$/u, (m) => `“${m[1]}”被理解为效应修饰因素的各个水平，因为本目标询问效应在它们之间是否不同。`],
  [/^“(.+)” was read as the comparator group for “(.+)”\.$/u, (m) => `“${m[1]}”被理解为“${m[2]}”的对照组。`],
  [/^No comparator was stated; patients without “(.+)” are assumed as the comparison group\.$/u, (m) => `未说明对照；假定没有“${m[1]}”的患者为对照组。`],
  [/^“(.+)” is the mediator, so it cannot also be the exposure; “(.+)” was read as the exposure\.$/u, (m) => `“${m[1]}”是中介变量，不能同时作为暴露；“${m[2]}”被理解为暴露。`],
  [/^The comparator “(.+)” names a different concept than the exposure “(.+)”\. The analysis compares patients with “(.+)” against all other patients \(which may include users of “(.+)”\), not against non-users of “(.+)”\.$/u, (m) => `对照“${m[1]}”与暴露“${m[2]}”是不同的概念。分析将有“${m[3]}”的患者与所有其他患者（可能包含“${m[4]}”的使用者）比较，而不是与“${m[5]}”的非使用者比较。`],
  [/^The question defines “(.+)” as (\d+) classes; each is analysed separately: (.+)\.$/u, (m) => `问题将“${m[1]}”定义为 ${m[2]} 类；每类单独分析：${m[3]}。`],
  [/^“(.+)” lists (\d+) (?:levels|measurements); each is analysed separately: (.+)\.$/u, (m) => `“${m[1]}”列出 ${m[2]} 项；每项单独分析：${m[3]}。`],
  [/^“(.+)” names (\d+) (?:levels|measurements) with no comparator stated; each is analysed separately: (.+)\.$/u, (m) => `“${m[1]}”包含 ${m[2]} 项且未说明对照；每项单独分析：${m[3]}。`],
  [/^“(.+)” names no specific variables; the default first-day features are used: (.+)\.$/u, (m, zh) => `“${m[1]}”未指明具体变量；使用默认的第一天特征：${listZh(m[2]!.split(/、|, /u).map((name) => label(name, zh)))}。`],
  [/^“(.+)” names no measurement; because the question concerns (.+), it is read as improvement in (.+)\.$/u, (m, zh) => `“${m[1]}”未指明测量指标；因问题涉及${m[2]}，将其理解为${label(m[3]!, zh)}的改善。`],
  [/^“(.+)” is analysed as the change in (.+) from the first (\d+(?:\.\d+)?) hours to the end of follow-up\.$/u, (m, zh) => `“${m[1]}”按${label(m[2]!, zh)}从最初 ${m[3]} 小时到随访结束的变化进行分析。`],
  [/^“(.+)” ask about the same event at several horizons, so it is analysed as time to event with follow-up to (.+); the other horizons are reported as survival at those times\.$/u, (m) => { const confirmed = m[2]!.match(/^(\d+(?:\.\d+)?) (\w+)\(s\)$/u); return `“${m[1]}”询问同一事件在多个时间点的情况，因此按生存时间分析，随访至${confirmed ? `${confirmed[1]} ${UNIT_TEXT(confirmed[2]!)}` : m[2]}；其他时间点报告为相应时间的生存率。`; }],
  [/^The question defines “(.+)” as including (.+); it is analysed as one composite outcome\.$/u, (m) => `问题将“${m[1]}”定义为包含${m[2]}；作为一个复合结局分析。`],
  [/^The aim “(.+)” asks the same analysis and is answered here\.$/u, (m) => `目标“${m[1]}”与本分析相同，在此一并回答。`],
  [/^Outcome component “(.+)” is analysed as (.+), the closest outcome MIMIC-IV records\.$/u, (m, zh) => `结局成分“${m[1]}”按${label(m[2]!, zh)}分析，即 MIMIC-IV 中最接近的已记录结局。`],
  [/^Outcome component “(.+)” is not used: (.+)$/u, (m) => `结局成分“${m[1]}”未采用：${REASON.find(([pattern]) => pattern.test(m[2]!))?.[1] ?? m[2]}`],
  [/^Mediator “(.+)” is analysed as the magnitude of change \(mean (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) h minus mean 0–(\d+(?:\.\d+)?) h\); speed and stability of the change are not derived\.$/u, (m) => `中介变量“${m[1]}”按变化幅度分析（${m[2]}–${m[3]} 小时均值减 0–${m[4]} 小时均值）；变化的速度和稳定性未推导。`],
  [/^“(.+)” is computed per patient as (.+), each part taken from the first (\d+(?:\.\d+)?) hours after time zero\.$/u, (m) => `“${m[1]}”按每位患者计算为 ${m[2]}，各部分均取自时间零点后最初 ${m[3]} 小时。`],
  [/^The outcome is a change from baseline, so the baseline value \((.+), mean of the first (\d+(?:\.\d+)?) hours\) is adjusted for\.$/u, (m, zh) => `结局是相对基线的变化，因此校正基线值（${label(m[1]!, zh)}，最初 ${m[2]} 小时的均值）。`],
  [/^“(.+)” is computed per patient as (.+) ÷ (.+), each taken from the first (\d+(?:\.\d+)?) hours after time zero\.$/u, (m, zh) => `“${m[1]}”按每位患者计算为${label(m[2]!, zh)} ÷ ${label(m[3]!, zh)}，二者均取自时间零点后最初 ${m[4]} 小时。`],
  [/^Active comparator: the population is patients who received any of (.+) in the first (\d+(?:\.\d+)?) hours; “(.+)” is compared with patients who received (.+) but not “(.+)”\. Patients receiving several listed classes count as exposed to each of them\.$/u, (m) => `活性对照：人群为最初 ${m[2]} 小时内使用过 ${m[1]} 中任意一类的患者；将“${m[3]}”与使用${m[4]}但未使用“${m[5]}”的患者比较。同时使用多个所列类别的患者，对每一类都计为暴露。`],
];

/** One assumption sentence in Chinese when its shape is known; the original English sentence otherwise. */
export const assumptionText = (sentence: string, zh: ZhLabeler): string => {
  for (const [pattern, render] of ASSUMPTIONS) { const match = sentence.match(pattern); if (match) return render(match, zh); }
  return sentence;
};

const WARNINGS: Template[] = [
  [/^([\d,]+) of ([\d,]+) rows with missing model variables were excluded \(complete-case analysis\)\.$/u, (m) => `${m[2]} 行中有 ${m[1]} 行因模型变量缺失被排除（完整病例分析）。`],
  [/^Direct and indirect effects have opposite signs \(inconsistent mediation\); the proportion mediated is not interpretable\.$/u, () => "直接效应与间接效应方向相反（不一致中介）；中介比例无法解释。"],
  [/^Mediation effects for a binary outcome are on the probability \(risk difference\) scale\.$/u, () => "二分类结局的中介效应以概率（风险差）尺度表示。"],
  [/^The total effect's confidence interval includes zero, so the proportion mediated is not interpretable\.$/u, () => "总效应的置信区间包含零，因此中介比例无法解释。"],
];
export const warningText = (sentence: string, zh: ZhLabeler): string => {
  for (const [pattern, render] of WARNINGS) { const match = sentence.match(pattern); if (match) return render(match, zh); }
  return sentence;
};

/** Observed value / rule text of an automatic check; unknown shapes stay as written. */
const CHECK_TEXT: Template[] = [
  [/^(\d+) variables$/u, (m) => `${m[1]} 个变量`],
  [/^every variable takes at least two values$/u, () => "每个变量至少有两个不同取值"],
  [/^none$/u, () => "无"],
  [/^SD ≤ (.+)× the SD implied by the IQR$/u, (m) => `SD ≤ 由四分位距推算 SD 的 ${m[1]} 倍`],
  [/^([<\d,]+) of ([\d,]+) excluded \((.+)\)$/u, (m) => `${m[2]} 例中 ${m[1]} 例被排除（${m[3]}）`],
  [/^≤ (.+) excluded for missing values$/u, (m) => `≤ ${m[1]} 因缺失被排除`],
  [/^([<\d,]+) exposed \/ ([<\d,]+) unexposed \((.+) exposed\)$/u, (m) => `暴露 ${m[1]} / 未暴露 ${m[2]}（暴露占 ${m[3]}）`],
  [/^each group ≥ (\d+); exposed share (.+)$/u, (m) => `每组 ≥ ${m[1]}；暴露比例 ${m[2]}`],
  [/^([<\d,]+) of ([\d,]+) \((.+?)\)(?:; (.+) events per parameter)?$/u, (m) => `${m[2]} 中 ${m[1]}（${m[3]}）${m[4] ? `；每个参数 ${m[4]} 个事件` : ""}`],
  [/^≥ (\d+) events; ≥ (.+) events per parameter$/u, (m) => `≥ ${m[1]} 个事件；每个参数 ≥ ${m[2]} 个事件`],
  [/^(.+%–.+%) for death during the admission in MIMIC-IV$/u, (m) => `MIMIC-IV 中住院期间死亡的常见范围 ${m[1]}`],
  [/^max SMD (.+)$/u, (m) => `最大 SMD ${m[1]}`],
  [/^max SMD ≤ (.+)$/u, (m) => `最大 SMD ≤ ${m[1]}`],
  [/^effective sample ([\d,]+) of ([\d,]+) \((.+)\)$/u, (m) => `有效样本量 ${m[1]} / ${m[2]}（${m[3]}）`],
  [/^≥ (.+) of patients$/u, (m) => `≥ ${m[1]} 的患者`],
  [/^global P (.+)$/u, (m) => `全局 P ${m[1]}`],
  [/^ratio between (.+) and (.+)$/u, (m) => `比值介于 ${m[1]} 与 ${m[2]} 之间`],
  [/^at least one severity measure \(for example SOFA, vasopressors, ventilation, lactate\)$/u, () => "至少一项病情严重度指标（如 SOFA、血管活性药物、机械通气、乳酸）"],
  [/^every variable resolved to a confirmed MIMIC-IV definition$/u, () => "每个变量均对应已确认的 MIMIC-IV 定义"],
  [/^each group ≥ (\d+) for a usable description$/u, (m) => `每组 ≥ ${m[1]} 例方可较准确地描述`],
  [/^(\d+) characteristics$/u, (m) => `${m[1]} 个特征`],
  [/^each recorded for at least (.+) of patients$/u, (m) => `每个特征至少在 ${m[1]} 的患者中有记录`],
];
export const checkText = (text: string, zh: ZhLabeler): string => {
  for (const [pattern, render] of CHECK_TEXT) { const match = text.match(pattern); if (match) return render(match, zh); }
  const tails = text.split("; ").map((part) => part.match(/^(.+): SD (.+), IQR (.+) to (.+)$/u));
  if (tails.every(Boolean)) return tails.map((m) => `${label(m![1]!, zh)}：SD ${m![2]}，四分位距 ${m![3]} 至 ${m![4]}`).join("；");
  const recorded = text.split("; ").map((part) => part.match(/^(.+): (.+%) recorded$/u));
  if (recorded.every(Boolean)) return recorded.map((m) => `${label(m![1]!, zh)}：${m![2]} 有记录`).join("；");
  const effect = text.match(/^(.+): (-?[\d.]+)$/u);
  if (effect) return `${estimateLabel(effect[1]!, zh)}：${effect[2]}`;
  const names = text.split(", ");
  if (names.every((name) => zh(name))) return labelList(names, zh);
  return text;
};
