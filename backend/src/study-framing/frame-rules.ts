import { deriveStudyType, requiredSlots, type FrameAmbiguity, type FrameExtraction, type FrameSlot, type FramingAim, type SlotAggregation, type SlotCategory, type StudyFrame } from "./domain/study-frame.js";

// Language rules that hold for any clinical question; none of them names a specific concept.
const NEGATION_PREFIX = /^(?:不使用|不用|未使用|未用|没有使用|没用|未服用|不服用|未接受|不接受|未给予|非|无|no\s+|without\s+|not\s+using\s+|non[-\s]?)/iu;
const USE_PREFIX = /^(?:使用|服用|应用|接受|给予|用|use\s+of\s+|using\s+|treated\s+with\s+)/iu;
const VAGUE_OUTCOME = /^(?:疗效|效果|影响|结局|预后|作用|药物疗效|治疗效果|effect|efficacy|outcome|prognosis)$/iu;

const MODIFICATION_CUE = /是否(?:会)?改变|修饰|交互作用|interaction|modif(?:y|ies|ied|ication)/iu;
const DIFFERENCE_CUE = /(?:之间|不同|而异|差异|differ(?:s|ent|ence)?\s+(?:by|between|across))/iu;
const EFFECT_WORD = /关联|效应|作用|影响|疗效|association|effect/iu;
const MEDIATION_CUE = /中介|介导|贡献度|贡献|mediat|explained\s+by/iu;
const HORIZON_PREFIX = /^(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:小时|天|日|周|月|年)(?:内)?|^\d+\s*-?\s*(?:hour|day|week|month|year)s?\s*/iu;
// Subgroup or stratum wording asks whether an effect differs between groups, as modification wording does.
const SUBGROUP_CUE = /亚组|分层|subgroup|stratif/iu;
// A clause naming what the analysis is adjusted for ("校正年龄、性别和SOFA评分后", "在控制年龄的情况下", "经年龄校正后",
// "adjusted for age and sex"): the variables in it are confounders, never effect modifiers. An English clause runs to the end of
// its sentence part, through a list's commas, and stops before a word that starts the rest of the question.
const ADJUSTMENT_CLAUSE = /(?:调整|校正|矫正|控制)了?[^，,。；;？?！!\n]{1,30}(?:后|的情况下)|经[^，,。；;？?！!\n]{1,30}?(?:调整|校正|矫正)(?:之?后)?|\b(?:adjust(?:ed|ing|ment)?|control(?:led|ling)?)\s+for\b[^.;:?!\n]*?(?=\s*,?\s*\b(?:in|among|within|across|between|does|do|did|is|are|was|were|how|what|whether|when|which|compared|versus|vs)\b|[.;:?!\n]|$)/giu;
const withoutAdjustmentClauses = (text: string): string => text.replace(ADJUSTMENT_CLAUSE, " ");
const hasModificationWording = (text: string): boolean => MODIFICATION_CUE.test(text) || SUBGROUP_CUE.test(text);

/**
 * Explicit wording decides the aim when present; otherwise the model's aim stands. A difference between groups
 * is only effect modification when it concerns an effect or association, not an outcome itself. An adjustment clause lists
 * confounders, so a sub-question with one keeps a modification aim only with modification or subgroup wording, or a difference
 * in an effect stated outside the clause.
 */
export const aimFromCues = (subQuestion: string, modelAim: FramingAim): FramingAim => {
  if (MEDIATION_CUE.test(subQuestion)) return "mediation";
  const asked = withoutAdjustmentClauses(subQuestion);
  if (MODIFICATION_CUE.test(subQuestion) || (DIFFERENCE_CUE.test(asked) && EFFECT_WORD.test(asked) && modelAim === "effect_modification")) return "effect_modification";
  if (modelAim === "effect_modification" && asked !== subQuestion && !SUBGROUP_CUE.test(subQuestion)) return "main";
  return modelAim === "effect_modification" && !EFFECT_WORD.test(subQuestion) ? "main" : modelAim;
};

/** "28天全因死亡", "90天全因死亡" → core "全因死亡" with horizon "90天"; undefined when no horizon prefix. */
export const splitHorizon = (outcome: string): { core: string; horizon: string } | undefined => {
  const match = outcome.match(HORIZON_PREFIX);
  const core = match ? outcome.slice(match[0].length).trim() : "";
  return match && core ? { core, horizon: match[0].trim() } : undefined;
};

// Chinese clinical shorthand "降X疗效" (lowering effect) names a change in the measured quantity X.
const LOWERING_EFFECT: Array<[RegExp, string, string]> = [[/降压|降低血压|血压降低|血压下降/u, "血压", "Blood pressure"], [/降糖/u, "血糖", "Blood glucose"], [/降脂/u, "血脂", "Lipids"], [/降温|退热/u, "体温", "Body temperature"], [/降心率|控制心率/u, "心率", "Heart rate"], [/镇痛|止痛/u, "疼痛评分", "Pain score"]];
const LOWERING_WORDING = /^(?:.*?)(?:降压|降低血压|血压降低|降糖|降脂|降温|退热|降心率|控制心率|镇痛|止痛)(?:疗效|效果|作用|幅度|程度|速度|速率|稳定度|稳定性)?$/u;
// "降压速度、降压幅度、降压稳定度": a list whose every item is a lowering-effect aspect names the same measured quantity.
const LIST_SEPARATOR = /[、，,;；]|和|及/u;

/** "降压疗效" → measured concept "血压" analysed as change over time; undefined for other outcomes. */
export const loweringEffectConcept = (outcome: string): string | undefined => loweringEffect(outcome)?.zh;

/** Measured quantity of a lowering-effect phrase in both languages; a parenthetical list of aspects is ignored. */
export const loweringEffect = (phrase: string): { zh: string; en: string } | undefined => {
  const text = phrase.replaceAll(/[（(][^）)]*[）)]/gu, "").replaceAll(/\s+/gu, "");
  const parts = text.split(LIST_SEPARATOR).filter(Boolean);
  if (!parts.length || !parts.every((part) => LOWERING_WORDING.test(part))) return undefined;
  const match = LOWERING_EFFECT.find(([pattern]) => pattern.test(parts[0]!));
  return match ? { zh: match[1], en: match[2] } : undefined;
};

const compact = (value: string): string => value.replaceAll(/\s+/gu, "");
const clean = (value: string): string => value.trim().replace(/^[，,。.;；:：、\s]+|[，,。.;；:：、\s]+$/gu, "");
const stripUse = (value: string): string => { const stripped = value.replace(USE_PREFIX, "").trim(); return stripped || value; };

const slot = (text: string, question: string): FrameSlot | undefined => {
  const value = clean(text);
  return value ? { text: value, verbatim: compact(question).includes(compact(value)) } : undefined;
};

// Words that name a group of people rather than the condition defining it.
const PEOPLE_WORDS = /(?:患者|病人|病患|人群|群体|人士|者|\b(?:patients?|population|cohort|subjects?|people|individuals|adults?|with|in)\b)/giu;
/**
 * A population restricts the whole analysis, so one the model inferred must still be stated in the question: its
 * core wording (without people words) must appear there, or for Latin script every word must share a stem with a
 * question word. A population derived from other parts of the question (for example from the outcome) is not.
 */
export const populationGrounded = (population: string, question: string): boolean => {
  const core = compact(population.replace(PEOPLE_WORDS, " ")).toLocaleLowerCase();
  const text = compact(question).toLocaleLowerCase();
  if (!core || text.includes(core)) return true;
  if (/[\u3400-\u9fff]/u.test(core)) return false;
  const questionWords = question.toLocaleLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length >= 4);
  const words = population.replace(PEOPLE_WORDS, " ").toLocaleLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length >= 4);
  return words.length > 0 && words.every((word) => questionWords.some((other) => other.slice(0, 4) === word.slice(0, 4)));
};

// Names that contain an aggregation word as part of the concept itself.
const PROTECTED_NAMES = /平均动脉压|mean arterial pressure|总胆红素|total bilirubin|总蛋白|total protein|总胆固醇|total cholesterol|first-degree|末次月经/iu;
// Time words already covered by the study's exposure window (0–24 h after time zero).
const TIME_WORDS = /(?:入\s*ICU|入院|住院)?\s*(?:首日|第一天|第1天|24\s*小时内|后24小时内?|时)|早期|基线|\b(?:on|during|within|in|at)?\s*(?:the\s+)?(?:first\s+(?:24\s*h(?:ours?)?|icu\s+day|day)|day\s*1|icu\s+admission(?:\s+day)?|admission(?:\s+day)?|first\s+24\s*hours\s+of\s+icu\s+admission)\b|\bearly\b|\bbaseline\b/giu;
const AGGREGATION_WORDS: Array<[RegExp, SlotAggregation]> = [
  [/最高|最大|峰值|\b(?:highest|maximum|max|peak)\b/iu, "maximum"],
  [/最低|最小|\b(?:lowest|minimum|min|nadir)\b/iu, "minimum"],
  [/平均|\b(?:mean|average)\b/iu, "mean"],
  [/首次|第一次|\b(?:first|initial)\b/iu, "first"],
  [/末次|最后一次|\b(?:last|final)\b/iu, "last"],
  [/累计|\b(?:cumulative|total)\b/iu, "sum"],
];

/**
 * Splits aggregation and time words off a measured concept: "入ICU首日最高乳酸" → 乳酸 (maximum); "Early Propofol Infusion
 * Rate" → Propofol Infusion Rate. Time words are covered by the exposure window; the aggregation is kept on the slot.
 * Names that contain such a word (平均动脉压, total bilirubin) are left intact.
 */
export const splitQualifiers = (phrase: string): { core: string; aggregation?: SlotAggregation } => {
  if (PROTECTED_NAMES.test(phrase)) return { core: phrase };
  let core = phrase.replace(TIME_WORDS, " ");
  let aggregation: SlotAggregation | undefined;
  for (const [pattern, kind] of AGGREGATION_WORDS) if (pattern.test(core)) { aggregation ??= kind; core = core.replace(pattern, " "); }
  // "的" / "之" are removed only as connectors left at the edges ("…首日的乳酸"), never inside a name (氢化可的松).
  core = core.replace(/\b(?:the|of|on|in|at|during|within|value|level)\b/giu, " ").replace(/\s+/gu, " ").replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, "").trim().replace(/^[的之\s]+|[的之\s]+$/gu, "");
  return core.length >= 2 && core !== phrase.trim() ? { core, ...(aggregation ? { aggregation } : {}) } : { core: phrase.trim() };
};

const qualifiedSlot = (text: string, question: string): FrameSlot | undefined => {
  const base = slot(text, question);
  if (!base) return undefined;
  const { core, aggregation } = splitQualifiers(base.text);
  return core === base.text ? base : { ...base, text: core, qualified_text: base.text, ...(aggregation ? { aggregation } : {}) };
};

/** "RDW/白蛋白", "BUN:creatinine", "ratio of lactate to albumin" → numerator and denominator; undefined otherwise. */
export const ratioParts = (level: string): { numerator: string; denominator: string } | undefined => {
  const hadRatioWord = /比值|比率|\bratio\b/iu.test(level);
  const text = level.replace(/(?:的)?(?:比值|比率)$|\s*\bratio\b$/iu, "").trim();
  const match = text.match(/^(.+?)\s*[/／:：]\s*(.+)$/u) ?? text.match(/^ratio of (.+?) to (.+)$/iu) ?? (hadRatioWord ? text.match(/^(.+?)[\s-]+to[\s-]+(.+)$/iu) : null);
  const numerator = match?.[1]?.trim(); const denominator = match?.[2]?.trim();
  return numerator && denominator ? { numerator, denominator } : undefined;
};

/**
 * Levels written as a bracketed list inside the exposure phrase ("降压药（ACEI、ARB）", "its ratios (RDW/albumin,
 * RDW/platelets)") when the model listed none; "X 及其 … (list)" / "X and its … (list)" also keeps X itself.
 */
export const bracketLevels = (phrase: string): string[] => {
  const groups = [...phrase.matchAll(/[（(]([^（）()]+)[）)]/gu)].map((match) => ({ start: match.index ?? 0, items: match[1]!.split(/[、,，;；]|\band\b|和/u).map((item) => item.trim()).filter(Boolean) }));
  const list = groups.find(({ items }) => items.length >= 2);
  if (!list) return [];
  const before = phrase.slice(0, list.start);
  const connector = before.match(/及其|以及其|\band its\b/iu);
  const head = connector ? splitQualifiers(before.slice(0, connector.index).replace(/[（(][^（）()]*[）)]/gu, " ")).core.replace(/^[的\s]+|[的\s]+$/gu, "") : "";
  return [...new Set([...(head.length >= 2 ? [head] : []), ...list.items])];
};

/** Splits a list on separators that are outside brackets, so a gloss such as "（普利类药物）" stays with its item. */
const splitOutsideBrackets = (text: string): string[] => {
  const items: string[] = [];
  let depth = 0; let current = "";
  for (const char of text) {
    if ("（(".includes(char)) depth += 1;
    if ("）)".includes(char)) depth = Math.max(0, depth - 1);
    if (depth === 0 && "、,，;；".includes(char)) { items.push(current); current = ""; } else current += char;
  }
  items.push(current);
  return items.map(clean).filter(Boolean);
};

/**
 * Levels the question defines on a separate line or clause of the form "降压药：ACEI、ARB、β受体阻滞剂" whose label is
 * the exposure phrase. Each item keeps its head term (a bracketed gloss such as "（普利类药物）" is dropped).
 */
/**
 * "血管活性药：去甲肾上腺素、血管加压素…" names the drugs of "血管活性药"; when the extraction took one of the listed items as the
 * exposure, the list's own label is the exposure and the items are its levels.
 */
export const listContaining = (question: string, item: string): { label: string; items: string[] } | undefined => {
  const wanted = compact(clean(item)).toLocaleLowerCase();
  if (wanted.length < 2) return undefined;
  for (const segment of question.split(/[\n。]|[;；](?=[^；;\n]*[：:])/u)) {
    const match = segment.match(/^\s*([^：:\n]{2,30})[：:](.+)$/u);
    if (!match) continue;
    const items = splitOutsideBrackets(match[2]!).map((entry) => clean(entry.replaceAll(/[（(][^（）()]*[）)]/gu, ""))).filter((entry) => entry.length >= 2);
    if (items.length >= 2 && items.some((entry) => { const other = compact(entry).toLocaleLowerCase(); return other === wanted || (other.length >= 2 && wanted.length >= 2 && (other.includes(wanted) || wanted.includes(other))); })) return { label: clean(match[1]!), items: [...new Set(items)] };
  }
  return undefined;
};

export const definedLevels = (question: string, label: string): string[] => {
  const target = compact(clean(label)).toLocaleLowerCase();
  if (target.length < 2) return [];
  for (const segment of question.split(/[\n。]|[;；](?=[^；;\n]*[：:])/u)) {
    const match = segment.match(/^\s*([^：:\n]{2,30})[：:](.+)$/u);
    if (!match || compact(clean(match[1]!)).toLocaleLowerCase() !== target) continue;
    const items = splitOutsideBrackets(match[2]!).map((item) => clean(item.replaceAll(/[（(][^（）()]*[）)]/gu, ""))).filter((item) => item.length >= 2);
    if (items.length >= 2) return [...new Set(items)];
  }
  return [];
};

/** Components written right after an outcome phrase: "主要心血管事件（包括：心肌梗死，中风）", "MACE (including death, MI)". */
export const includedComponents = (question: string, outcome: string): string[] => {
  const phrase = clean(outcome);
  if (compact(phrase).length < 2) return [];
  const escaped = phrase.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  const match = question.match(new RegExp(`${escaped}\\s*[（(]\\s*(?:包括|包含|含|including|includes?)\\s*[:：]?\\s*([^）)]+)[）)]`, "iu"));
  if (!match) return [];
  const items = splitOutsideBrackets(match[1]!.replaceAll(/\s+(?:and|or)\s+|和|及|以及|或/giu, "、")).map((item) => clean(item.replaceAll(/等+$/gu, ""))).filter((item) => item.length >= 2);
  return items.length >= 2 ? [...new Set(items)] : [];
};

const MACE_PHRASE = /^(?:MACE(?:\s*事件)?|主要(?:不良)?心(?:脑)?血管(?:不良)?事件|major adverse (?:cardiovascular|cardiac) events?)$/iu;
/** The standard three-point MACE, used when a question names "MACE" without saying what it includes. */
const CARDIO_GROUP = /^(?:心血管(?:系统)?|心脏)不良(?:结局|事件)$|^(?:adverse )?cardiovascular (?:outcomes?|events?)$/iu;
const CEREBRO_GROUP = /^(?:脑血管|脑)不良(?:结局|事件)$|^(?:adverse )?cerebrovascular (?:outcomes?|events?)$/iu;
const RENAL_GROUP = /^(?:肾脏|肾)不良(?:结局|事件)$|^(?:adverse )?(?:renal|kidney) (?:outcomes?|events?)$/iu;
export const standardComponents = (outcome: string, chinese: boolean): string[] => {
  const text = clean(outcome);
  if (MACE_PHRASE.test(text)) return chinese ? ["心血管死亡", "心肌梗死", "中风"] : ["cardiovascular death", "myocardial infarction", "stroke"];
  if (CARDIO_GROUP.test(text)) return chinese ? ["心肌梗死", "心力衰竭", "心血管死亡"] : ["myocardial infarction", "heart failure", "cardiovascular death"];
  if (CEREBRO_GROUP.test(text)) return chinese ? ["卒中", "短暂性脑缺血发作", "脑出血"] : ["stroke", "transient ischemic attack", "intracerebral hemorrhage"];
  if (RENAL_GROUP.test(text)) return chinese ? ["急性肾损伤", "终末期肾病"] : ["acute kidney injury", "end-stage kidney disease"];
  return [];
};

const LEVEL_CUE = /^(?:具体(?:到|为|是|指)|每(?:一)?种|各(?:种|个)|分别|即|如|例如|包括|包含|主要(?:是|为|包括|有)|including|specifically|namely|each|such as)/iu;
/** Drops words that introduce a list ("具体到每种药物，肝素、…") so only the listed items remain as levels. */
export const levelItems = (items: string[]): string[] => items.map((item) => clean(item)).filter((item) => item.length >= 2 && !(LEVEL_CUE.test(item) && /(?:药物|药|类|种|each|drug)$/iu.test(item))).map((item) => clean(item.replace(LEVEL_CUE, ""))).filter((item) => item.length >= 2);

/**
 * "不同他汀（主要是阿托伐他汀、瑞舒伐他汀…）", "different statins (mainly atorvastatin, rosuvastatin…)": the drugs listed in brackets after
 * "different X" are the treatments to compare with each other. Returns [] when the question has no such list.
 */
export const parentheticalLevels = (question: string): string[] => {
  const match = question.match(/(?:不同|各种|各类|different|various)[^（(，,。；;\n]{0,24}?[（(]\s*(?:主要是|主要为|主要包括|主要有|包括|包含|如|例如|including|such as|mainly|mostly)?\s*[:：]?\s*([^）)]+)[）)]/iu);
  if (!match) return [];
  const items = levelItems(splitOutsideBrackets(match[1]!.replaceAll(/\s+(?:and|or)\s+|和|及|以及|或|，/giu, "、")).map((item) => item.replaceAll(/等+$/gu, "")));
  return items.length >= 2 ? [...new Set(items)] : [];
};

/**
 * Levels written as a bare list with no brackets ("收缩压、舒张压和心率", "systolic and diastolic blood pressure and
 * heart rate") when the model listed none: each item becomes a separate level instead of the whole phrase being
 * searched as one term (which previously matched only one of the named measurements and silently dropped the rest).
 * Every item must be a substantive phrase (2+ letters/characters), the same bar bracketLevels uses, so a single
 * concept whose own name happens to contain "and" or "、" is not mistaken for a list.
 */
export const bareListLevels = (phrase: string): string[] => {
  const items = [...new Set(phrase.split(/[、,，;；]|\band\b|和/u).map((item) => item.trim()).filter(Boolean))];
  return items.length >= 2 && items.every((item) => item.replace(/[^\p{L}\p{N}]/gu, "").length >= 2) ? items : [];
};

// Default first-day features for prediction questions that name only "data", "vital signs" or "laboratory values";
// each is a concept of the validated library (names in the question's language).
const DEFAULT_VITALS = { zh: ["心率", "平均动脉压", "呼吸频率", "血氧饱和度", "体温"], en: ["Heart rate", "Mean arterial pressure", "Respiratory rate", "Oxygen saturation", "Body temperature"] };
const DEFAULT_LABS = { zh: ["乳酸", "肌酐", "尿素氮", "白细胞计数", "血红蛋白", "血小板", "血钠", "血钾", "血糖", "总胆红素"],
  en: ["Lactate", "Creatinine", "Blood urea nitrogen", "White blood cell count", "Hemoglobin", "Platelet count", "Sodium", "Potassium", "Blood glucose", "Total bilirubin"] };
const GENERIC_VITALS = /^(?:生命体征|体征|vital\s*signs?|vitals)$/iu;
const GENERIC_LABS = /^(?:实验室(?:指标|检查|数据|检验|结果)?|化验(?:指标|结果)?|检验(?:指标|结果)?|laboratory(?:\s+(?:values|tests|data|results))?|lab(?:\s+(?:values|tests|data|results))?)$/iu;
const GENERIC_ALL = /^(?:数据|资料|指标|变量|特征|临床(?:数据|指标|变量|特征)|(?:clinical\s+)?(?:data|variables|features|predictors|measurements))$/iu;

const LIPID_PHRASE = /^(?:血脂(?:水平|指标|谱|四项|检查)?|血脂各项指标|lipids?(?:\s+(?:levels?|profile|panel|measures?))?)$/iu;
const ANTIHYPERTENSIVE_PHRASE = /^(?:降压药(?:物)?|抗高血压药(?:物)?|antihypertensive(?:\s+(?:drugs?|medications?|agents?|classes))?)$/iu;
const WHICH_CLASS = /哪[类种个]|哪一类|which\s+(?:class|type|kind|category)/iu;
/**
 * A group named by one word stands for its usual members: a lipid panel is its four measurements, and "which class of
 * antihypertensive" compares the five main classes. Returns [] for any other phrase.
 */
export const expandExposureSet = (phrase: string, question: string): string[] => {
  const core = splitQualifiers(phrase).core.trim();
  const zh = /\p{Script=Han}/u.test(question);
  // "心率水平及心率变异性" / "heart rate level and variability": the level and the variability are two exposures.
  const chinese = core.match(/^(.{1,12}?)(?:水平)?\s*(?:及|和|与|以及|、)\s*(?:其|该)?(?:\1)?(?:变异性|变异度|波动)$/u);
  if (chinese) return [`${chinese[1]}水平`, `${chinese[1]}变异性`];
  const english = core.match(/^(.{2,40}?)\s+(?:levels?\s+)?(?:and|&)\s+(?:its\s+)?variability$/iu);
  if (english) return [`${english[1]} level`, `${english[1]} variability`];
  if (LIPID_PHRASE.test(core)) return zh ? ["总胆固醇", "低密度脂蛋白胆固醇", "高密度脂蛋白胆固醇", "甘油三酯"] : ["Total cholesterol", "LDL cholesterol", "HDL cholesterol", "Triglycerides"];
  if (ANTIHYPERTENSIVE_PHRASE.test(core) && WHICH_CLASS.test(question)) return zh ? ["血管紧张素转换酶抑制剂", "血管紧张素II受体拮抗剂", "β受体阻滞剂", "钙通道拮抗剂", "利尿剂"] : ["ACE inhibitors", "Angiotensin receptor blockers", "Beta blockers", "Calcium channel blockers", "Diuretics"];
  return [];
};

/** Expands a generic predictor phrase to the default first-day features; other phrases are returned as they are. */
export const expandGenericPredictor = (phrase: string, zh: boolean): string[] => {
  // "first-24-hour laboratory values" leaves "-24-hour laboratory values" once the time word is gone: the window is not part of the name.
  const core = splitQualifiers(phrase.replace(/(?:入?ICU)?[首前]?\s*\d+\s*(?:小时|天|日)(?:内)?的?/u, "")).core.replace(/^[\s-]*(?:\d+(?:\.\d+)?[\s-]*(?:hours?|hrs?|h|days?|d)\b[\s-]*)/iu, "").replace(/^icu\s*/iu, "").replace(/^ICU/u, "").replace(/^首?\d+\s*(?:小时|天|日)(?:内)?的?/u, "").trim();
  const language = zh ? "zh" : "en";
  if (GENERIC_VITALS.test(core)) return DEFAULT_VITALS[language];
  if (GENERIC_LABS.test(core)) return DEFAULT_LABS[language];
  if (GENERIC_ALL.test(core)) return [...DEFAULT_VITALS[language], ...DEFAULT_LABS[language]];
  return [phrase];
};

const THRESHOLD = /(≥|>=|≧|大于等于|不少于|不低于|至少|at\s+least|≤|<=|≦|小于等于|不超过|不高于|at\s+most|>|大于|超过|多于|高于|more\s+than|greater\s+than|longer\s+than|over|above|<|小于|少于|低于|less\s+than|shorter\s+than|under|below)\s*(\d+(?:\.\d+)?)\s*(小时|h(?:ours?|rs?)?|天|日|days?|d|周|weeks?|mmol\/L|mg\/dL|%)?/iu;
const OPERATOR: Array<[RegExp, "gte" | "lte" | "gt" | "lt"]> = [
  [/^(?:≥|>=|≧|大于等于|不少于|不低于|至少|at\s+least)$/iu, "gte"], [/^(?:≤|<=|≦|小于等于|不超过|不高于|at\s+most)$/iu, "lte"],
  [/^(?:>|大于|超过|多于|高于|more\s+than|greater\s+than|longer\s+than|over|above)$/iu, "gt"], [/^(?:<|小于|少于|低于|less\s+than|shorter\s+than|under|below)$/iu, "lt"],
];
const UNIT: Array<[RegExp, string]> = [[/^(?:小时|h(?:ours?|rs?)?)$/iu, "hour"], [/^(?:天|日|days?|d)$/iu, "day"], [/^(?:周|weeks?)$/iu, "week"]];

/** "ICU住院时间≥75小时" → ICU住院时间 with gte 75 hour; undefined when the phrase has no cut-off. */
// "5 days or more", "at 75 hours or longer", "48小时及以上": the number comes first and the direction after it.
const THRESHOLD_AFTER = /(\d+(?:\.\d+)?)\s*(小时|h(?:ours?|rs?)?|天|日|days?|d|周|weeks?|mmol\/L|mg\/dL|%)?\s*(or\s+more|or\s+longer|or\s+above|or\s+higher|or\s+greater|and\s+above|and\s+over|及以上|或以上|以上|或更长|or\s+less|or\s+fewer|or\s+shorter|or\s+below|or\s+lower|and\s+below|及以下|或以下|以下|或更短|以内)/iu;
const AFTER_DIRECTION: Array<[RegExp, "gte" | "lte"]> = [[/^(?:or\s+(?:more|longer|above|higher|greater)|and\s+(?:above|over)|及以上|或以上|以上|或更长)$/iu, "gte"], [/^(?:or\s+(?:less|fewer|shorter|below|lower)|and\s+below|及以下|或以下|以下|或更短|以内)$/iu, "lte"]];

export const parseThreshold = (phrase: string): { core: string; operator: "gt" | "gte" | "lt" | "lte"; value: number; unit?: string } | undefined => {
  const match = phrase.match(THRESHOLD);
  if (!match) {
    const after = phrase.match(THRESHOLD_AFTER);
    const direction = after ? AFTER_DIRECTION.find(([pattern]) => pattern.test(after[3]!.trim()))?.[1] : undefined;
    const rest = after ? clean(phrase.replace(after[0], " ").replace(/[（(]\s*[）)]/gu, " ").replace(/\s+/gu, " ")) : "";
    if (!after || !direction || rest.length < 2) return undefined;
    const unit = after[2] ? UNIT.find(([pattern]) => pattern.test(after[2]!))?.[1] ?? after[2] : undefined;
    return { core: rest, operator: direction, value: Number(after[1]), ...(unit ? { unit } : {}) };
  }
  const operator = OPERATOR.find(([pattern]) => pattern.test(match[1]!.trim()))?.[1];
  const core = clean(phrase.replace(match[0], " ").replace(/\s+/gu, " "));
  if (!operator || core.length < 2) return undefined;
  const unit = match[3] ? UNIT.find(([pattern]) => pattern.test(match[3]!))?.[1] ?? match[3] : undefined;
  return { core, operator, value: Number(match[2]), ...(unit ? { unit } : {}) };
};

// Words that state only the care setting or that patients are adults (MIMIC-IV contains adults only).
const SETTING_WORDS = /入住\s*ICU\s*的?|ICU|重症监护(?:病房|室)?|重症|危重症?|成人|成年|住院|患者|病人|病患|人群|\b(?:adults?|patients?|inpatients?|hospitali[sz]ed|critically ill|intensive care(?: units?)?|in-hospital|admitted|with|in|the|of|receiving an?|people|subjects?)\b/giu;

/** The condition a population phrase names, without setting and age words; "" when it names none. */
const FEMALE = "女性|女士|女患者|女病人|妇女|females?|women|woman";
const MALE = "男性|男士|男患者|男病人|males?|men|man";
// Only a sex word at an edge of the phrase restricts the population ("高血压女性", "女性高血压患者"), not one inside a condition name.
const sexEdge = (words: string): RegExp => new RegExp(`^(?:${words})(?=[\\p{Script=Han}\\s])|(?:^|(?<=[\\p{Script=Han}\\s]))(?:${words})(?:患者|病人|人群)?$`, "iu");
/** The sex a population phrase restricts to ("高血压女性患者" → F), or undefined when it names none or both. */
export const populationSex = (phrase: string): "F" | "M" | undefined => {
  const text = phrase.trim();
  const female = sexEdge(FEMALE).test(text); const male = sexEdge(MALE).test(text);
  return female === male ? undefined : female ? "F" : "M";
};
export const populationCore = (phrase: string): string => {
  const core = (populationSex(phrase) ? phrase.trim().replace(sexEdge(populationSex(phrase) === "F" ? FEMALE : MALE), " ") : phrase).replace(SETTING_WORDS, " ").replace(/\s+/gu, " ").replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, "").trim().replace(/^[的之,，、\s]+|[的之,，、\s]+$/gu, "");
  return core.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 ? core : "";
};

/** Splits "不用美托洛尔" into its negation and core concept; returns undefined when not negated. */
export const negatedConcept = (text: string): string | undefined => {
  const value = clean(text);
  const core = value.replace(NEGATION_PREFIX, "").trim();
  return core && core !== value ? stripUse(core) : undefined;
};

// "未使用者", "不用的患者", "non-users": a negation followed only by a word for people means non-users of the exposure.
const PEOPLE_ONLY = /^(?:的)?(?:者|患者|病人|人|人群|组|users?|patients?|group)$/iu;
// A comparator that only says "none" ("neither", "untreated", "对照组") is the absence of the exposure.
const ABSENCE_ONLY = /^(?:neither|none|no\s*treatment|untreated|non-?treated|controls?|control\s*group|对照|对照组|未治疗(?:者|组)?|不使用(?:者|组)?|未使用(?:者|组)?|不用(?:药)?|没用|没有使用|未用药|不服用|未服用|非使用者|non-?users?|non-?use|no\s+use|not\s+(?:treated|used|using))$/iu;
const sameConcept = (left: string, right: string): boolean => compact(stripUse(left)).toLocaleLowerCase() === compact(stripUse(right)).toLocaleLowerCase();

/**
 * Turns one model extraction into one frame per outcome (independent outcomes are separate analyses;
 * a named composite stays one outcome with components). Applies negation, comparator and
 * missing-slot rules, and records every server-made assumption explicitly.
 */
const SEX_ONLY = /^(?:性别|男女|男性与女性|男女性别|sex|gender)$/iu;
const SEX_EFFECT_QUESTION = /效果|疗效|效应|反应|获益|effect|response|efficacy|benefit/iu;
const USERS_SUFFIX = /(?:使用者|用药者|服用者|使用人群|用药人群|users?)$/iu;
/**
 * "X的性别差异": sex is the modifier of X's effect, never the exposure. A small model sometimes puts sex in the exposure
 * slot and X in the population ("X使用者"); this puts them back, and leaves the exposure empty (a blocking, explained gap)
 * when X cannot be recovered.
 */
const sexAsModifier = (extraction: FrameExtraction, question: string, assumptions: string[]): FrameExtraction => {
  const sex = clean(extraction.exposure);
  if (!SEX_ONLY.test(sex) || !SEX_EFFECT_QUESTION.test(question)) return extraction;
  const population = clean(extraction.population);
  const treatment = USERS_SUFFIX.test(population) ? clean(population.replace(USERS_SUFFIX, "")) : "";
  assumptions.push(treatment ? `“${sex}” was read as the modifier of the effect of “${treatment}”, not as the exposure.` : `“${sex}” was read as the modifier of the effect; the treatment whose effect is compared was not found in the question, so it has to be stated.`);
  return { ...extraction, goal: "evaluate_treatment", exposure: treatment, population: treatment ? "" : extraction.population, modifiers: [sex, ...extraction.modifiers.filter((text) => !SEX_ONLY.test(clean(text)))] };
};
/** Whether a phrase is written in a text: as a whole word in Latin script ("age" is not in "stage"), as written otherwise. */
const mentions = (text: string, phrase: string): boolean => {
  const value = clean(phrase);
  if (!value) return false;
  if (/\p{Script=Han}/u.test(value)) return compact(text).toLocaleLowerCase().includes(compact(value).toLocaleLowerCase());
  const pattern = value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`).replaceAll(/\s+/gu, String.raw`\s+`);
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu").test(text);
};
/**
 * "校正年龄、性别和SOFA评分后，使用氢化可的松与不使用相比…", "adjusted for age and sex": a variable the question names only inside an
 * adjustment clause is what the analysis is adjusted for. A small model files such variables as effect modifiers, which turned a
 * treatment question into an effect-modification one; they are removed from the modifiers unless the sub-question also asks about
 * modification or subgroups.
 */
const adjustedNotModifiers = (extraction: FrameExtraction, question: string, subQuestion: string, assumptions: string[]): FrameExtraction => {
  if (!extraction.modifiers.length || hasModificationWording(subQuestion || question)) return extraction;
  const text = `${question}\n${subQuestion}`;
  const clauses = [...text.matchAll(ADJUSTMENT_CLAUSE)].map(([clause]) => clause);
  if (!clauses.length) return extraction;
  const outside = withoutAdjustmentClauses(text);
  const adjusted = extraction.modifiers.filter((modifier) => clauses.some((clause) => mentions(clause, modifier)) && !mentions(outside, modifier));
  if (!adjusted.length) return extraction;
  const names = adjusted.map(clean);
  const several = names.length > 1;
  assumptions.push(`${names.map((name) => `“${name}”`).join(", ")} ${several ? "are" : "is"} named as what the analysis is adjusted for, so ${several ? "they are" : "it is"} taken as adjustment, not as ${several ? "effect modifiers" : "an effect modifier"}; the plan lists the variables it adjusts for, and one named here that is not among them is not added. （${names.map((name) => `“${name}”`).join("、")}是问题要求校正的变量，按校正处理，而非效应修饰因素；实际校正的变量见分析方案，此处所列但不在方案中的变量不会自动加入。）`);
  return { ...extraction, modifiers: extraction.modifiers.filter((modifier) => !adjusted.includes(modifier)) };
};

const PREDICT_WORDS = /预测|\bpredict(?:s|ed|ion|ive|or)?\b|prognos/iu;
/**
 * "Can age, heart rate and lactate predict death?": the listed variables are predictors. A small model may file them as
 * effect modifiers when nothing is the exposure; with predict wording and no exposure they are put back as predictors.
 */
const predictionAsPredictors = (extraction: FrameExtraction, question: string, assumptions: string[]): FrameExtraction => {
  if (!PREDICT_WORDS.test(question) || clean(extraction.exposure) || extraction.mediators.length) return extraction;
  const listed = [...extraction.predictors, ...extraction.modifiers].map(clean).filter(Boolean);
  if (!listed.length || (extraction.goal === "predict" && !extraction.modifiers.length)) return extraction;
  assumptions.push(`The question asks to predict the outcome, so ${listed.map((text) => `“${text}”`).join(", ")} ${listed.length > 1 ? "are" : "is"} read as predictor${listed.length > 1 ? "s" : ""}, not as effect modifiers.`);
  return { ...extraction, goal: "predict", predictors: [...new Set(listed)], modifiers: [] };
};

const OBSERVATION_EN = /(?:first|initial)[\s-]*(\d+(?:\.\d+)?)[\s-]*(hours?|hrs?|h|days?)\b/iu;
const OBSERVATION_ZH = /(?:首|前|头|最初)\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(小时|h|天|日)|(?:入|在)?(?:ICU|院|住院|入院)?(首日|第一天|第1天|头一天)|(?:入ICU|入院|入住ICU|ICU入住|住院)(?:后)?\s*(\d+(?:\.\d+)?)\s*(小时|天)(?:内)?/iu;
/**
 * The window in which predictors or exposures are read ("lactate in the first 24 hours", "first 6 hours of vital signs",
 * 入ICU首日的肌酐): hours from time zero, or undefined when the question does not state one next to them. The window is not
 * the outcome horizon, which is stated with "within", "N天内" and the like.
 */
export const observationWindowHours = (text: string, subjects: string[], force = false): number | undefined => {
  const english = text.match(OBSERVATION_EN);
  const chinese = english ? undefined : text.match(OBSERVATION_ZH);
  const match = english ?? chinese; if (!match || match.index === undefined) return undefined;
  const hours = english ? Number(english[1]) * (/^d/iu.test(english[2]!) ? 24 : 1)
    : chinese![3] ? 24
    : chinese![1] ? Number(chinese![1]) * (/^[天日]/u.test(chinese![2]!) ? 24 : 1)
    : Number(chinese![4]) * (chinese![5] === "天" ? 24 : 1);
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  const around = text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40).toLocaleLowerCase();
  const attached = subjects.map((subject) => subject.trim().toLocaleLowerCase()).filter((subject) => subject.length >= 2).some((subject) => around.includes(subject));
  return force || attached ? hours : undefined;
};
const IS_OBSERVATION_PHRASE = (text: string): boolean => OBSERVATION_EN.test(text) || OBSERVATION_ZH.test(text);
const OPIOID_OR_ANALGESIC = /阿片|吗啡|芬太尼|氢吗啡酮|羟考酮|opioid|morphine|fentanyl|analges|镇痛药/iu;

// ---- Description: a population, an optional grouping and the characteristics to describe; no outcome to relate. ----
const DESCRIBE_CUE = /描述|描绘|\bdescri(?:be|bed|bes|bing|ption)\b|\bcharacteri[sz]e\b|\bcharacteristics\b|基线特征|临床特征|人口学特征|一般特征/iu;
// Characteristics named as what is adjusted, matched or weighted for ("adjusting for baseline characteristics", "调整基线特征后")
// ask for no description: they are the adjustment of another aim.
const ADJUSTED_CHARACTERISTICS = /(?:调整|校正|矫正|控制|匹配|平衡|加权)[^，,。；;？?！!]{0,12}?(?:特征|特点)|\b(?:adjust(?:s|ed|ing|ment)?|control(?:s|led|ling)?|match(?:es|ed|ing)?|balanc(?:e|es|ed|ing)|weight(?:s|ed|ing)?|account(?:s|ed|ing)?)\s+(?:for|on|by)?\s*(?:the\s+|their\s+)?(?:[a-z-]+\s+){0,3}?characteristics\b/giu;
/** The question without characteristics named only as what is adjusted for. */
const withoutAdjustedCharacteristics = (text: string): string => text.replace(ADJUSTED_CHARACTERISTICS, " ");
// Words that relate, compare, predict, size a treatment's effect, follow a course over time or ask for a dose response: with any of
// them the model's aim stands, whatever else the question says.
const KEEP_AIM_CUE = /关联|相关|关系|效应|影响|疗效|效果|作用|差异|比较|对比|预测|危险因素|风险|降低|减少|改善|获益|增加|升高|预防|保护|预后|识别|剂量|趋势|随时间|变化|生存|中介|associat|relat(?:e|ed|es|ion)|effect|impact|compar|differ|predict|prognos|versus|\bvs\b|\brisk\b|\breduc|\blower|\bdecreas|\bincreas|\bimprov|\bbenefit|\bprevent|\bprotect|\bharm|\bidentif|\bdos(?:e|es|ing|age)\b|\bresponse|\befficacy|\btrend|\bover\s+time\b|\bchange|\bsurviv|\bmediat/iu;
/**
 * A sub-question that asks to describe and names no relation, comparison, prediction, treatment effect, course over time or dose is
 * a description, even when the model read it as a group comparison or an association. A treatment or prediction aim, a modifier or
 * mediator, a dose question, or a time-to-event or change outcome keeps the model's aim: a description reports none of them.
 */
export const goalFromCues = (subQuestion: string, extraction: Pick<FrameExtraction, "goal" | "outcome_kind" | "dose_question" | "modifiers" | "mediators">, aim: FramingAim = "main"): FrameExtraction["goal"] => {
  const { goal } = extraction;
  if (goal !== "compare_groups" && goal !== "relate_factor") return goal;
  if (aim === "mediation" || extraction.modifiers.length || extraction.mediators.length || extraction.dose_question || extraction.outcome_kind === "time_to_event" || extraction.outcome_kind === "change_over_time") return goal;
  const asked = withoutAdjustedCharacteristics(subQuestion);
  return DESCRIBE_CUE.test(asked) && !KEEP_AIM_CUE.test(asked) ? "describe" : goal;
};
// A phrase that asks only for the number of patients: every description reports the cohort count and each group's count.
const COUNT_ONLY = /^(?:(?:the\s+)?(?:count|number|numbers|total)\s+of\s+(?:patients?|people|persons?|cases?|admissions?|subjects?|individuals?)|patient\s+counts?|how\s+many(?:\s+patients?)?|(?:患者|病人|病例|人)?(?:人数|例数|总数|数量|数目|个数)|多少(?:人|例|名|位)?(?:患者)?)$/iu;
// A characteristics phrase that names no variable ("基线特征", "baseline characteristics"): Table 1 describes the default set.
const GENERIC_CHARACTERISTICS = /^(?:(?:基线|基本|一般|临床|人口学)?(?:特征|特点|情况|资料)|(?:baseline|clinical|patient|demographic|general)?\s*(?:characteristics|features|profile))$/iu;
const ASKS_CHARACTERISTICS = /基线特征|基本特征|一般特征|临床特征|人口学特征|(?:their|the|baseline|clinical|patient)\s+characteristics|\bcharacteristics\s+of\b|\bcharacteri[sz]e\b/iu;
/**
 * Default characteristics of a description that names none: first-day severity markers, vital signs and laboratory values, each a
 * concept of the validated library; age, sex and the Charlson index are always in Table 1. Named in the question's language, with
 * the English concept and data category fixed by rule so no model call translates them.
 */
const DEFAULT_CHARACTERISTICS: Array<{ zh: string; en: string; category: SlotCategory }> = [
  { zh: "急诊入院", en: "Emergency admission", category: "encounter" }, { zh: "血管活性药物", en: "Vasopressors", category: "medication" }, { zh: "有创机械通气", en: "Invasive mechanical ventilation", category: "intervention" },
  ...DEFAULT_VITALS.zh.map((zh, index) => ({ zh, en: DEFAULT_VITALS.en[index]!, category: "vital_sign" as const })),
  ...DEFAULT_LABS.zh.map((zh, index) => ({ zh, en: DEFAULT_LABS.en[index]!, category: "laboratory" as const })),
];
/**
 * The groupings of a description: the exposure slot and every phrase the model filed as a modifier ("按性别和年龄组描述…" gives sex
 * and age group). A question that relates, compares or predicts has none, so its modifiers stay effect modifiers; so does one with a
 * mediator.
 */
const descriptionGroupings = (extraction: FrameExtraction, subQuestion: string): string[] =>
  extraction.goal !== "describe" || extraction.mediators.length || KEEP_AIM_CUE.test(withoutAdjustedCharacteristics(subQuestion)) ? []
    : [...new Set([clean(extraction.exposure), ...extraction.modifiers.map(clean)].filter(Boolean))];
/** "按性别描述…": a description's one grouping the model filed as a modifier is the grouping (the exposure slot), not an effect modifier. */
const descriptionGrouping = (extraction: FrameExtraction, groupings: string[], assumptions: string[]): FrameExtraction => {
  if (groupings.length !== 1 || clean(extraction.exposure) || !extraction.modifiers.length) return extraction;
  const grouping = groupings[0]!;
  assumptions.push(`“${grouping}” is the grouping of the description: each characteristic is described in every group, not as an effect modifier. （“${grouping}”是描述的分组：每个特征按组分别描述，而非作为效应修饰因素。）`);
  return { ...extraction, exposure: grouping, modifiers: [] };
};
/**
 * The characteristics of a description: every phrase the model listed as an outcome or predictor, except one that asks only for a
 * patient count (always reported) or repeats the grouping. A phrase that names no variable, or a question asking for "characteristics"
 * without naming any, gives the default set. Each characteristic is described on its own, so no list is split into separate aims.
 * A composite the model named ("MACE") is described by its parts, the question's own list or the standard one, each on its own;
 * a composite without known parts is described as the one phrase, so it is mapped (or stopped with the reason), never dropped.
 */
const describedCharacteristics = (extraction: FrameExtraction, grouping: string, question: string, subQuestion: string, assumptions: string[]): FrameSlot[] => {
  const zh = /\p{Script=Han}/u.test(question);
  const composite = clean(extraction.composite_outcome);
  const ownParts = composite ? includedComponents(question, composite) : [];
  const parts = ownParts.length >= 2 ? ownParts : composite ? standardComponents(composite, zh) : [];
  if (parts.length >= 2) assumptions.push(`“${composite}” is described by its parts, each on its own: ${parts.join(", ")}; whether a patient had any of them is not combined into one rate. （“${composite}”按其组成部分分别描述：${parts.join("、")}；不合并为“发生任一项”的比例。）`);
  const listed = [...new Set([...extraction.outcomes, ...extraction.predictors, ...(parts.length >= 2 ? parts : composite ? [composite] : [])].map(clean).filter(Boolean))];
  const counts = listed.filter((text) => COUNT_ONLY.test(text.trim()));
  if (counts.length) assumptions.push(`“${counts.join("、")}” asks for the number of patients, which every description reports (the cohort and each group). （“${counts.join("、")}”即患者人数，描述结果总会给出队列及各组人数。）`);
  const named = listed.filter((text) => !COUNT_ONLY.test(text.trim()) && !(grouping && sameConcept(text, grouping)));
  const generic = named.filter((text) => GENERIC_CHARACTERISTICS.test(splitQualifiers(text).core.trim()) || GENERIC_CHARACTERISTICS.test(text.trim()));
  const specific = named.filter((text) => !generic.includes(text));
  const slots = specific.map((text) => {
    const base = qualifiedSlot(text, question); const threshold = parseThreshold(text);
    return base && threshold ? { ...base, text: threshold.core, qualified_text: text, threshold: { operator: threshold.operator, value: threshold.value, ...(threshold.unit ? { unit: threshold.unit } : {}) } } : base;
  }).filter((item): item is FrameSlot => Boolean(item)).filter((item, index, all) => all.findIndex((other) => compact(other.text).toLocaleLowerCase() === compact(item.text).toLocaleLowerCase()) === index);
  if (generic.length || (!slots.length && ASKS_CHARACTERISTICS.test(withoutAdjustedCharacteristics(`${subQuestion} ${question}`)))) {
    const phrase = generic[0] ?? (zh ? "特征" : "characteristics");
    const defaults = DEFAULT_CHARACTERISTICS.filter(({ zh: name, en }) => !slots.some((item) => sameConcept(item.text, name) || sameConcept(item.text, en)));
    assumptions.push(`“${phrase}” names no specific variables; age, sex, the Charlson comorbidity index and the default first-day characteristics are described: ${defaults.map(({ en }) => en).join(", ")}. （“${phrase}”未指明具体变量；描述年龄、性别、Charlson 合并症指数及默认的首日特征：${defaults.map(({ zh: name }) => name).join("、")}。）`);
    slots.push(...defaults.map(({ zh: name, en, category }) => ({ text: zh ? name : en, verbatim: false, normalized: { label_en: en, category, source: "catalog" as const } })));
  }
  return slots;
};

// A dose-response question names an amount or rate of a treatment; without such wording the model's dose reading is
// dropped (it reads "use X, then the change in Y" as a dose question). A rate counts only as a rate of giving the drug (a fall
// rate of blood pressure is an outcome), "cumulative" only next to an amount, and a milligram unit not as part of mg/dL.
// 药量 covers 用药量 and 给药量.
const DOSE_CUE = /剂量|用量|总量|药量|量效|累[积计](?:剂?量|用量)|(?:输注|给药|泵入)(?:速度|速率)|(?<![a-z])mg\b(?!\s*\/\s*dl\b)|毫克(?!\s*(?:\/|每)\s*分升)|\bdos(?:e|es|age|ing)\b|infusion\s+rate|cumulative\s+(?:dose|dosage|amount)/iu;

/** The model's dose reading stands only when the sub-question or the question names a dose, an amount or a rate. */
export const doseFromCues = (extraction: FrameExtraction, subQuestion: string, question: string): FrameExtraction =>
  extraction.dose_question && !DOSE_CUE.test(`${subQuestion} ${question}`) ? { ...extraction, dose_question: false } : extraction;

export const buildFrames = (input: { question: string; sub_question: string; extraction: FrameExtraction; first_id: number; aim?: FramingAim }): StudyFrame[] => {
  const { question } = input;
  const assumptions: string[] = [];
  const dosed = doseFromCues(input.extraction, input.sub_question, question);
  const adjusted = adjustedNotModifiers(dosed, question, input.sub_question, assumptions);
  // Every modifier was only an adjusted-for variable: no modification aim is left either.
  const onlyAdjusted = adjusted !== dosed && !adjusted.modifiers.length;
  const sexRead = sexAsModifier(adjusted, question, assumptions);
  const predicted = predictionAsPredictors(sexRead, question, assumptions);
  const readAsPrediction = predicted !== sexRead;
  const describeGoal = goalFromCues(input.sub_question || question, predicted, input.aim);
  if (describeGoal !== predicted.goal) assumptions.push(`The question asks to describe and names no relation, comparison or prediction, so it is answered as a description. （问题要求描述，未提及关联、比较或预测，因此按描述性研究回答。）`);
  const described = { ...predicted, goal: describeGoal };
  const groupings = descriptionGroupings(described, input.sub_question || question);
  // "按性别和年龄组描述…": one description per grouping, each with its own Table 1; the groupings are not crossed, and none becomes
  // an effect modifier (an interaction test would turn a description into an effect estimate).
  if (groupings.length > 1) {
    const exposureText = clean(described.exposure);
    const named = groupings.map((text) => `“${text}”`).join("、");
    const note = `The description names ${groupings.length} groupings (${named}); each is described in its own Table 1, not crossed with the others. （描述按 ${groupings.length} 种分组（${named}）分别进行，每种分组一个基线表，不做交叉分组。）`;
    let next = input.first_id;
    return groupings.flatMap((grouping) => {
      const own = { ...described, exposure: grouping, modifiers: [], ...(grouping === exposureText ? {} : { comparator: "", exposure_categories: [] }) };
      const frames = framesFor(input, next, own, "main", [...assumptions, note]);
      next += frames.length;
      return frames;
    });
  }
  const extraction = descriptionGrouping(described, groupings, assumptions);
  // A group comparison (or description) labelled as modification without a modifier is a plain group comparison (or description).
  const aim = readAsPrediction || (input.aim === "effect_modification" && !extraction.modifiers.length && (onlyAdjusted || extraction.goal === "compare_groups" || extraction.goal === "describe")) ? "main" : input.aim ?? "main";
  return framesFor(input, input.first_id, extraction, aim, assumptions);
};

/** The frames of one extraction once the model's reading has been corrected: one per outcome (a description has one). */
const framesFor = (input: { question: string; sub_question: string }, firstId: number, extraction: FrameExtraction, aim: FramingAim, assumptions: string[]): StudyFrame[] => {
  const { question } = input;
  const baseAmbiguities: FrameAmbiguity[] = [];

  let exposureText = clean(extraction.exposure);
  let comparatorText = clean(extraction.comparator);
  const modifierTexts = [...extraction.modifiers];
  if (aim === "effect_modification" && !modifierTexts.length && comparatorText && !negatedConcept(comparatorText)) {
    modifierTexts.push(comparatorText);
    assumptions.push(`“${comparatorText}” was read as the levels of the effect modifier, because this aim asks whether an effect differs between them.`);
    comparatorText = "";
  }
  const negatedExposure = negatedConcept(exposureText);
  if (negatedExposure && !comparatorText) {
    comparatorText = exposureText;
    exposureText = negatedExposure;
    assumptions.push(`“${comparatorText}” was read as the comparator group for “${exposureText}”.`);
  }
  if (exposureText) exposureText = stripUse(exposureText);
  // The exposure is one item of a list the question defines ("血管活性药：去甲肾上腺素、血管加压素…"): the list's label is the exposure.
  const container = exposureText ? listContaining(question, exposureText) : undefined;
  if (container && container.label !== exposureText) {
    assumptions.push(`“${exposureText}” is one of the ${container.items.length} items the question lists under “${container.label}”; the whole list is analysed: ${container.items.join("、")}.`);
    if (comparatorText && container.items.some((entry) => sameConcept(entry, comparatorText))) comparatorText = "";
    exposureText = container.label;
  }
  // In a mediation aim the exposure cannot also be the mediator. When the model put the mediator in the exposure slot, the
  // treatment is the only phrase left over (it landed in the modifier slot), so it is read as the exposure.
  if (aim === "mediation" && exposureText && extraction.mediators.some((text) => sameConcept(text, exposureText)) && modifierTexts.length) {
    const treatment = stripUse(modifierTexts.shift()!);
    assumptions.push(`“${exposureText}” is the mediator, so it cannot also be the exposure; “${treatment}” was read as the exposure.`);
    exposureText = treatment;
  }

  const listedInBrackets = exposureText ? parentheticalLevels(question) : [];
  const groupMembers = exposureText ? expandExposureSet(exposureText, question) : [];
  let comparator: StudyFrame["comparator"];
  if (comparatorText && ABSENCE_ONLY.test(comparatorText.trim())) comparator = { kind: "absence", text: comparatorText };
  else if (comparatorText) {
    const negatedCore = negatedConcept(comparatorText);
    if (negatedCore && (sameConcept(negatedCore, exposureText) || PEOPLE_ONLY.test(compact(negatedCore)))) comparator = { kind: "absence", text: comparatorText };
    else if (negatedCore) {
      // The analysis compares users of the exposure with everyone without it, which is not what the stated phrase says, so the
      // stated text is not shown as the comparison group; the assumption below records what was actually compared.
      comparator = { kind: "absence" };
      assumptions.push(`The comparator “${comparatorText}” names a different concept than the exposure “${exposureText}”. The analysis compares patients with “${exposureText}” against all other patients (which may include users of “${negatedCore}”), not against non-users of “${negatedCore}”.`);
      baseAmbiguities.push({ code: "ASYMMETRIC_COMPARATOR", slot: "comparator", message: `The comparator “${comparatorText}” negates “${negatedCore}”, not the exposure “${exposureText}”. Confirm whether the comparison group should be patients without “${exposureText}”.` });
    } else {
      // "A vs B": the comparator is one treatment or a listed group of them; each item is mapped on its own.
      const items = bareListLevels(stripUse(comparatorText));
      comparator = { kind: "active", text: comparatorText, levels: items.length >= 2 ? items : [stripUse(comparatorText)] };
    }
  } else if (exposureText && extraction.goal === "evaluate_treatment" && definedLevels(question, exposureText).length < 2 && extraction.exposure_categories.filter((level) => compact(exposureText).includes(compact(clean(level)))).length < 2 && bracketLevels(exposureText).length < 2 && listedInBrackets.length < 2 && groupMembers.length < 2) {
    comparator = { kind: "absence" };
    assumptions.push(`No comparator was stated; patients without “${exposureText}” are assumed as the comparison group.`);
  } else if (exposureText) comparator = { kind: "unspecified" };

  // A category level is only a level of this exposure when the exposure phrase names it ("降压药（ACEI、ARB…）");
  // comparator drugs or negated phrases the model listed as categories are dropped.
  const listed = [...new Set(extraction.exposure_categories.map(clean).filter((level) => level && !negatedConcept(level) && compact(level) !== compact(exposureText) && compact(exposureText).includes(compact(level))))];
  const defined = listed.length < 2 && exposureText ? definedLevels(question, exposureText) : [];
  if (defined.length >= 2) assumptions.push(`The question defines “${exposureText}” as ${defined.length} classes; each is analysed separately: ${defined.join("、")}.`);
  const fromGroup = listed.length < 2 && defined.length < 2 ? groupMembers : [];
  if (fromGroup.length >= 2) assumptions.push(`“${exposureText}” stands for its usual members, each analysed separately: ${fromGroup.join("、")}.`);
  const fromBrackets = listed.length < 2 && defined.length < 2 && fromGroup.length < 2 ? listedInBrackets : [];
  if (fromBrackets.length >= 2) assumptions.push(`The question lists ${fromBrackets.length} treatments for “${exposureText}”; they are compared with each other among patients who received any of them: ${fromBrackets.join("、")}.`);
  const bracketed = listed.length < 2 && defined.length < 2 && fromGroup.length < 2 && fromBrackets.length < 2 && exposureText ? bracketLevels(exposureText) : [];
  if (bracketed.length >= 2) assumptions.push(`“${exposureText}” lists ${bracketed.length} levels; each is analysed separately: ${bracketed.join("、")}.`);
  // A plain exposure that is itself a ratio ("乳酸/白蛋白比值") is handled below as a single-level ratio, not a list, so
  // bare-list splitting only applies when the phrase is not itself a ratio.
  const bareList = listed.length < 2 && defined.length < 2 && fromGroup.length < 2 && fromBrackets.length < 2 && bracketed.length < 2 && exposureText && !ratioParts(splitQualifiers(exposureText).core) ? bareListLevels(splitQualifiers(exposureText).core) : [];
  if (bareList.length >= 2) assumptions.push(`“${exposureText}” names ${bareList.length} levels with no comparator stated; each is analysed separately: ${bareList.join("、")}.`);
  const categories = defined.length >= 2 ? defined : fromGroup.length >= 2 ? fromGroup : fromBrackets.length >= 2 ? fromBrackets : bracketed.length >= 2 ? bracketed : bareList.length >= 2 ? bareList : listed;
  // A plain exposure that is itself a ratio ("乳酸/白蛋白比值", not a bracketed list) becomes a single-level "categories"
  // exposure so it flows through the same numerator/denominator split as a listed ratio, instead of the whole phrase
  // being searched as one term and silently matching only one side of it.
  const scalarRatio = categories.length < 2 && exposureText ? ratioParts(splitQualifiers(exposureText).core) : undefined;
  const exposure = exposureText
    ? (categories.length >= 2 ? { ...slot(exposureText, question)!, categories }
      : scalarRatio ? { ...slot(exposureText, question)!, categories: [splitQualifiers(exposureText).core] }
      : qualifiedSlot(exposureText, question))
    : undefined;
  const proposedPopulation = slot(extraction.population, question);
  const grounded = proposedPopulation && (proposedPopulation.verbatim || populationGrounded(proposedPopulation.text, question)) ? proposedPopulation : undefined;
  if (proposedPopulation && !grounded) assumptions.push(`The population “${proposedPopulation.text}” was inferred but is not stated in the question, so it is not applied; state a population to restrict the analysis.`);
  // Setting and age words are not a condition to search for: MIMIC-IV is adults only and the ICU setting is read from
  // the question. A population that states only those words adds no restriction.
  const populationConcept = grounded ? populationCore(grounded.text) : "";
  if (grounded && !populationConcept) assumptions.push(`“${grounded.text}” states only the care setting or age group; no further population restriction is applied (MIMIC-IV contains adults only).`);
  // Words that only repeat part of the exposure phrase ("阿片类药物镇痛" in "阿片类药物镇痛剂量") describe the treatment, not who is studied.
  const repeatsExposure = Boolean(grounded && populationConcept && exposureText && compact(exposureText).length > compact(populationConcept).length && compact(exposureText).includes(compact(populationConcept)));
  if (repeatsExposure) assumptions.push(`“${populationConcept}” only repeats part of the exposure “${exposureText}”, so it is not used as a population restriction.`);
  const population = grounded && populationConcept && !repeatsExposure ? (populationConcept === grounded.text ? grounded : { ...grounded, text: populationConcept, qualified_text: grounded.text }) : undefined;
  const modifiers = modifierTexts.map((text) => slot(text, question)).filter((item): item is FrameSlot => Boolean(item) && !sameConcept(item!.text, exposureText));
  const mediators = extraction.mediators.map((text) => slot(text, question)).filter((item): item is FrameSlot => Boolean(item));
  // A description (no modifier, no mediator) relates nothing: what the model listed as outcomes or predictors are its characteristics.
  const describing = extraction.goal === "describe" && !modifiers.length && !mediators.length && aim === "main";
  const characteristics = describing ? describedCharacteristics(extraction, exposureText, question, input.sub_question, assumptions) : [];
  const hanQuestion = /\p{Script=Han}/u.test(question);
  const predictorTexts = describing ? [] : [...new Set(extraction.predictors.flatMap((text) => {
    const expanded = expandGenericPredictor(clean(text), hanQuestion);
    if (expanded.length > 1 || expanded[0] !== clean(text)) assumptions.push(`“${clean(text)}” names no specific variables; the default first-day features are used: ${expanded.join(hanQuestion ? "、" : ", ")}.`);
    return expanded;
  }))];
  // "lactate" and "lactate in the first 24 hours" are one predictor once the time words are split off.
  const predictors = predictorTexts.map((text) => qualifiedSlot(text, question)).filter((item): item is FrameSlot => Boolean(item))
    .filter((item, index, all) => all.findIndex((other) => compact(other.text) === compact(item.text)) === index);
  let outcomeTexts = describing ? [] : [...new Set(extraction.outcomes.map(clean).filter(Boolean))];
  // "发生率" and "新发率" (incidence, new onset) name the same recorded event: the archive cannot tell a new diagnosis from an older one.
  const RATE_WORDS = /(?:新发率|发生率|发病率|新发|发生|incidence(?:\s+rate)?|new[- ]onset)$/iu;
  const withoutRate = outcomeTexts.map((text) => clean(text.replace(RATE_WORDS, "").replace(/^(?:incidence of|new[- ]onset)\s+/iu, "")) || text);
  if (withoutRate.some((text, position) => text !== outcomeTexts[position])) {
    assumptions.push(`Outcomes written as incidence or new-onset (${outcomeTexts.filter((text, position) => text !== withoutRate[position]).join("、")}) are analysed as the recorded event itself; MIMIC-IV diagnosis codes carry no date, so a new diagnosis cannot be told from an earlier one.`);
    outcomeTexts = [...new Set(withoutRate)];
  }
  // "阵痛" means labour pain; next to an opioid or analgesic it is almost surely a slip for "镇痛" (analgesia).
  if (OPIOID_OR_ANALGESIC.test(exposureText) && outcomeTexts.some((text) => text.includes("阵痛"))) {
    assumptions.push("“阵痛” (labour pain) was read as “镇痛” (analgesia), because the exposure is an opioid or analgesic.");
    outcomeTexts = outcomeTexts.map((text) => text.replaceAll("阵痛", "镇痛"));
  }
  let outcomeKind = extraction.outcome_kind;
  // A bare "疗效" names no measurement, but when the question states the treatment's purpose ("镇痛剂量", "降压药") the effect is that
  // purpose's measured quantity (pain score, blood pressure…); the reading is recorded as an assumption.
  if (outcomeTexts.length === 1 && VAGUE_OUTCOME.test(compact(outcomeTexts[0]!))) {
    const purpose = LOWERING_EFFECT.map(([pattern, zh]) => ({ cue: question.match(pattern)?.[0], zh })).find(({ cue }) => cue);
    if (purpose?.cue) {
      assumptions.push(`“${outcomeTexts[0]}” names no measurement; because the question concerns ${purpose.cue}, it is read as improvement in ${purpose.zh}.`);
      outcomeTexts = [`${purpose.cue}疗效`];
    }
  }
  const lowered = outcomeTexts.length === 1 ? loweringEffectConcept(outcomeTexts[0]!) : undefined;
  if (lowered) {
    assumptions.push(`“${outcomeTexts[0]}” is analysed as the change in ${lowered} from the first 24 hours to the end of follow-up.`);
    outcomeTexts = [lowered];
    outcomeKind = "change_over_time";
  }
  let timeWindow = clean(extraction.time_window);
  // "Predict death from lactate in the first 24 hours": the first 24 hours is where the predictors are read, not how long the outcome is followed.
  const subjects = [...predictors.map(({ text }) => text), ...predictorTexts, exposureText, ...(exposure?.categories ?? [])].filter(Boolean);
  const exposureWindow = observationWindowHours(input.sub_question || question, subjects, extraction.goal === "predict") ?? observationWindowHours(question, subjects, extraction.goal === "predict");
  // "in the first 24 hours" next to the exposure or predictors is the window they are read in, never the outcome horizon the model may have copied it into.
  if (exposureWindow !== undefined && timeWindow && IS_OBSERVATION_PHRASE(timeWindow)) timeWindow = "";
  // "24-hour mean blood glucose": the 24 hours belong to the measurement named in the exposure, not to the outcome's follow-up.
  const namedWindow = timeWindow ? /^(\d+(?:\.\d+)?)[\s-]*(hours?|hrs?|h|days?)$/iu.exec(timeWindow.trim()) : null;
  const windowInName = namedWindow && subjects.some((subject) => subject.toLocaleLowerCase().includes(timeWindow.trim().toLocaleLowerCase())) ? Number(namedWindow[1]) * (/^d/iu.test(namedWindow[2]!) ? 24 : 1) : undefined;
  if (windowInName !== undefined) timeWindow = "";
  // The same event asked at several horizons (28-, 90-, 365-day death) is one time-to-event analysis.
  const horizons = outcomeTexts.map(splitHorizon);
  if (outcomeTexts.length > 1 && horizons.every(Boolean) && new Set(horizons.map((item) => item!.core)).size === 1 && outcomeKind !== "change_over_time") {
    const longest = horizons.reduce((best, item) => (parseFloat(item!.horizon) || 0) >= (parseFloat(best!.horizon) || 0) ? item : best)!;
    outcomeTexts = [horizons[0]!.core];
    outcomeKind = "time_to_event";
    timeWindow = longest.horizon;
    assumptions.push(`“${horizons.map((item) => item!.horizon).join("、")}” ask about the same event at several horizons, so it is analysed as time to event with follow-up to ${longest.horizon}; the other horizons are reported as survival at those times.`);
  }
  // An outcome written with a cut-off is whether the cut-off is met; a time window that only repeats it is dropped.
  const thresholds = new Map(outcomeTexts.map((text) => [text, parseThreshold(text)] as const).filter((entry): entry is [string, NonNullable<ReturnType<typeof parseThreshold>>] => Boolean(entry[1])));
  if (thresholds.size && outcomeKind !== "time_to_event") {
    outcomeKind = "event";
    if (timeWindow && [...thresholds.values()].some(({ value }) => timeWindow.includes(String(value)))) timeWindow = "";
  }
  let composite = describing ? "" : clean(extraction.composite_outcome);
  // A composite named by the model with no parts, or a single outcome phrase, takes its components from the question's own
  // "（包括：…）" list when it has one.
  const definedParts = composite && outcomeTexts.length === 0 ? includedComponents(question, composite)
    : !composite && outcomeTexts.length === 1 ? includedComponents(question, outcomeTexts[0]!) : [];
  const standardParts = definedParts.length < 2 ? standardComponents(composite || (outcomeTexts.length === 1 ? outcomeTexts[0]! : ""), /\p{Script=Han}/u.test(question)) : [];
  if (standardParts.length >= 2) {
    const name = composite || outcomeTexts[0]!;
    assumptions.push(`The question names “${name}” without listing its parts; the standard three-point definition is used: ${standardParts.join("、")}.`);
    composite = name;
    outcomeTexts = standardParts;
  }
  if (definedParts.length >= 2) {
    composite = composite || outcomeTexts[0]!;
    assumptions.push(`The question defines “${composite}” as including ${definedParts.join("、")}; it is analysed as one composite outcome.`);
    outcomeTexts = definedParts;
  }
  const outcomes: Array<FrameSlot | undefined> = composite
    ? [{ ...slot(composite, question)!, components: outcomeTexts }]
    : outcomeTexts.length ? outcomeTexts.map((text) => {
      const base = slot(text, question); const threshold = thresholds.get(text);
      return base && threshold ? { ...base, text: threshold.core, qualified_text: base.text, threshold: { operator: threshold.operator, value: threshold.value, ...(threshold.unit ? { unit: threshold.unit } : {}) } } : base;
    }) : [undefined];

  // Several outcomes listed together under "change" are not all changes: "eGFR的变化、急性肾损伤" is one change and one event.
  const mixedKinds = outcomeTexts.length > 1 && outcomeKind === "change_over_time";
  const outcomeKindFor = (text: string | undefined): FrameExtraction["outcome_kind"] => mixedKinds && text && !/变化|改变|变化量|change/iu.test(text) ? "event" : outcomeKind;
  return outcomes.map((outcome, index) => {
    const facets = { goal: extraction.goal, outcome_kind: describing ? "none" as const : outcomeKindFor(outcome?.text), dose_question: extraction.dose_question, has_modifier: modifiers.length > 0 || aim === "effect_modification", has_mediator: mediators.length > 0 || aim === "mediation" };
    const studyType = deriveStudyType(facets);
    const ambiguities = [...baseAmbiguities];
    const present: Record<string, boolean> = { population: Boolean(population), exposure: Boolean(exposure), outcome: Boolean(outcome), modifiers: modifiers.length > 0, mediators: mediators.length > 0, predictors: predictors.length > 0 };
    for (const name of requiredSlots(studyType)) {
      if (!present[name]) ambiguities.push({ code: "SLOT_MISSING", slot: name, message: `A ${studyType.replaceAll("_", " ")} study needs a ${name.replace(/s$/u, "")}, but none was found in the question.` });
    }
    if (outcome && VAGUE_OUTCOME.test(compact(outcome.text))) ambiguities.push({ code: "VAGUE_OUTCOME", slot: "outcome", message: `“${outcome.text}” does not name a measurable outcome; specify which measurement or event defines it.` });
    for (const [name, value] of [["population", population], ["exposure", exposure], ["outcome", outcome]] as const) {
      if (value && !value.verbatim) ambiguities.push({ code: "SLOT_NOT_IN_QUESTION", slot: name, message: `“${value.text}” was inferred and does not appear verbatim in the question; confirm it.` });
    }
    // MIMIC-IV contains adults only, so a question without a population is analysed in all adult patients.
    const frameAssumptions = [...assumptions];
    if (!population) frameAssumptions.push("No population was stated; all adult patients in MIMIC-IV are analysed.");
    const blocking = ambiguities.some(({ code, slot: name }) => (code === "SLOT_MISSING" && name !== "population") || code === "VAGUE_OUTCOME");
    return {
      frame_id: `f${firstId + index}`,
      sub_question: input.sub_question,
      study_type: studyType,
      facets,
      ...(population ? { population } : {}),
      ...(exposure ? { exposure } : {}),
      ...(comparator ? { comparator } : {}),
      ...(outcome ? { outcome } : {}),
      modifiers, mediators, predictors,
      ...(characteristics.length ? { characteristics } : {}),
      ...(timeWindow ? { time_window: timeWindow } : {}),
      ...((exposureWindow ?? windowInName) !== undefined && (exposureWindow ?? windowInName) !== 24 ? { exposure_window_hours: (exposureWindow ?? windowInName)! } : {}),
      assumptions: frameAssumptions,
      ambiguities,
      status: blocking ? "needs_clarification" : "ready",
    } satisfies StudyFrame;
  });
};

/**
 * Merges frames that ask about the same event at different horizons (often split into separate sub-questions)
 * into one time-to-event frame followed to the longest horizon, then renumbers frame ids.
 */
/** The follow-up horizon of a time phrase as "<number> <unit>", or "" when it states none ("早期", "first 24 hours" of exposure). */
const parseHorizonText = (text: string | undefined): string => {
  const match = text?.match(/(\d+(?:\.\d+)?)\s*(小时|天|日|周|月|年|hours?|days?|weeks?|months?|years?)/iu);
  return match && !/内|within|first/iu.test(text ?? "") ? `${match[1]} ${match[2]}` : "";
};

/**
 * Drops an aim that asks exactly what an earlier aim asks once qualifier words are split off (the question split into
 * "early propofol rate and delirium" and "propofol rate and delirium, threshold"); the kept aim notes the duplicate.
 */
export const dropDuplicateFrames = (frames: StudyFrame[]): StudyFrame[] => {
  const seen = new Map<string, StudyFrame>();
  const kept: StudyFrame[] = [];
  for (const frame of frames) {
    const horizon = parseHorizonText(frame.time_window);
    const key = JSON.stringify([frame.study_type, frame.population?.text ?? "", frame.exposure?.text ?? "", frame.exposure?.categories ?? [], frame.outcome?.text ?? "", horizon,
      frame.modifiers.map(({ text }) => text).sort(), frame.mediators.map(({ text }) => text).sort(), frame.predictors.map(({ text }) => text).sort()]);
    const earlier = seen.get(key);
    if (earlier) {
      // Two descriptions of the same patients and grouping are one description of every characteristic either names.
      const added = (frame.characteristics ?? []).filter((item) => !(earlier.characteristics ?? []).some((other) => compact(other.text).toLocaleLowerCase() === compact(item.text).toLocaleLowerCase()));
      if (added.length) earlier.characteristics = [...(earlier.characteristics ?? []), ...added];
      earlier.assumptions.push(`The aim “${frame.sub_question}” asks the same analysis and is answered here.`); continue;
    }
    seen.set(key, frame); kept.push(frame);
  }
  return kept.map((frame, index) => ({ ...frame, frame_id: `f${index + 1}` }));
};

/**
 * A dose question that also asks about a modifier ("剂量-疗效性别差异") is answered in two steps: the overall dose-response first,
 * then whether the modifier changes it. The overall frame is added before the modification frame (a duplicate the model already
 * produced is removed later by dropDuplicateFrames).
 */
export const withOverallDoseResponse = (frames: StudyFrame[]): StudyFrame[] => frames.flatMap((frame) => {
  if (!frame.facets.dose_question || !frame.facets.has_modifier || frame.facets.has_mediator || !frame.exposure) return [frame];
  const facets = { ...frame.facets, has_modifier: false };
  const overall: StudyFrame = {
    ...frame, facets, study_type: deriveStudyType(facets), modifiers: [], ambiguities: frame.ambiguities.map((item) => ({ ...item })),
    assumptions: [...frame.assumptions, `The overall dose-response is analysed first; the next aim asks whether ${frame.modifiers.map(({ text }) => `“${text}”`).join("、")} changes it.`],
  };
  return [overall, frame];
});

export const mergeHorizonFrames = (frames: StudyFrame[]): StudyFrame[] => {
  const groups = new Map<string, StudyFrame[]>();
  const merged: StudyFrame[] = [];
  for (const frame of frames) {
    const horizon = frame.outcome ? splitHorizon(frame.outcome.text) : undefined;
    if (!horizon || frame.facets.outcome_kind === "change_over_time") { merged.push(frame); continue; }
    const key = JSON.stringify([frame.facets.goal, frame.facets.has_mediator, frame.exposure?.text ?? "", frame.population?.text ?? "", horizon.core]);
    const group = groups.get(key);
    if (group) group.push(frame); else { groups.set(key, [frame]); merged.push(frame); }
  }
  return merged.map((frame) => {
    const horizon = frame.outcome ? splitHorizon(frame.outcome.text) : undefined;
    const group = horizon ? groups.get(JSON.stringify([frame.facets.goal, frame.facets.has_mediator, frame.exposure?.text ?? "", frame.population?.text ?? "", horizon.core])) : undefined;
    if (!group || group.length < 2) return frame;
    const horizons = group.map(({ outcome }) => splitHorizon(outcome!.text)!.horizon);
    const days = (text: string): number => (parseFloat(text) || 1) * (/年|year/iu.test(text) ? 365 : /月|month/iu.test(text) ? 30 : /周|week/iu.test(text) ? 7 : /小时|hour/iu.test(text) ? 1 / 24 : 1);
    const longest = horizons.reduce((best, item) => days(item) >= days(best) ? item : best);
    const modifiers = [...new Map(group.flatMap(({ modifiers }) => modifiers).map((slot) => [slot.text, slot])).values()];
    const facets = { ...frame.facets, outcome_kind: "time_to_event" as const, has_modifier: modifiers.length > 0 };
    return {
      ...frame, facets, study_type: deriveStudyType(facets), modifiers, time_window: longest,
      outcome: { ...frame.outcome!, text: horizon!.core, verbatim: compact(frame.sub_question).includes(compact(horizon!.core)) || frame.outcome!.verbatim },
      assumptions: [...frame.assumptions, `“${horizons.join("、")}” ask about the same event at several horizons, so it is analysed as time to event with follow-up to ${longest}; the other horizons are reported as survival at those times.`],
    };
  }).map((frame, index) => ({ ...frame, frame_id: `f${index + 1}` }));
};
