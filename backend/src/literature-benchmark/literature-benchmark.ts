/**
 * End-to-end benchmark against published MIMIC-IV studies: each case's question is run through the platform and the
 * result is compared with the paper's reported cohort size and primary estimate. Agreement is graded, not assumed:
 * published studies define cohorts and variables in ways the platform may only approximate.
 */

export interface PublishedResult {
  cohort_n: number | null;
  primary_estimate: { measure: string; value: number | null; ci_low: number | null; ci_high: number | null };
}
export interface BenchmarkCase { id: string; study_type: string; question_zh: string; citation: { title: string; year: number; doi?: string }; results: PublishedResult }

/** The parts of a platform run the scorer reads (a QuestionRunResult or a failed run's status). */
export interface RunSummary {
  status: "completed" | "failed" | "missing";
  error?: string;
  plans: Array<{
    plan_id: string; status: string; blockers?: Array<{ code: string; message: { en: string } }>;
    cohort?: { rows: number };
    quality?: { status: string };
    result?: { status: string; estimates: Array<{ measure: string; estimate: number | null; ci_low: number | null; ci_high: number | null; label: string }> };
  }>;
  unanswered?: number;
}

export type Grade = "agrees" | "same_direction" | "differs" | "not_comparable" | "did_not_run";
export interface CaseScore {
  case_id: string; study_type: string; title: string;
  ran: boolean; plans_completed: number; plans_total: number; first_blocker?: string;
  published: { n: number | null; measure: string; value: number | null; ci: [number | null, number | null] };
  platform?: { plan_id: string; n: number; measure: string; value: number | null; ci: [number | null, number | null]; quality?: string };
  cohort_ratio?: number;
  grade: Grade;
}

const MEASURE: Record<string, string> = { OR: "odds_ratio", HR: "hazard_ratio", RR: "risk_ratio", RD: "risk_difference", AUC: "auc", MD: "mean_difference" };
const RATIO = new Set(["odds_ratio", "hazard_ratio", "risk_ratio", "rate_ratio"]);

/** Published RDs are sometimes in percentage points; the platform reports proportions. The estimate decides the scale. */
const rdScale = (measure: string, estimate: number | null): number => measure === "risk_difference" && estimate !== null && Math.abs(estimate) > 1 ? 100 : 1;

export const scoreCase = (item: BenchmarkCase, run: RunSummary): CaseScore => {
  const published = item.results.primary_estimate;
  const measure = MEASURE[published.measure] ?? "other";
  const base = {
    case_id: item.id, study_type: item.study_type, title: item.citation.title,
    plans_completed: run.plans.filter(({ status }) => status === "completed").length, plans_total: run.plans.length,
    published: { n: item.results.cohort_n, measure: published.measure, value: published.value, ci: [published.ci_low, published.ci_high] as [number | null, number | null] },
  };
  const blocker = run.plans.flatMap(({ blockers }) => blockers ?? [])[0];
  const firstBlocker = run.error ?? (blocker ? `${blocker.code}: ${blocker.message.en}` : run.unanswered ? "the question needs clarification" : undefined);
  const completed = run.plans.filter((plan) => plan.status === "completed" && plan.result?.status === "completed");
  if (!completed.length) return { ...base, ran: false, ...(firstBlocker ? { first_blocker: firstBlocker.slice(0, 240) } : {}), grade: "did_not_run" };
  // The plan whose main estimate has the published measure; otherwise the first completed plan.
  const candidates = completed.map((plan) => ({ plan, estimate: plan.result!.estimates.find((row) => row.measure === measure) ?? plan.result!.estimates[0] }));
  const chosen = candidates.find(({ estimate }) => estimate?.measure === measure) ?? candidates[0]!;
  const estimate = chosen.estimate;
  const platform = { plan_id: chosen.plan.plan_id, n: chosen.plan.cohort?.rows ?? 0, measure: estimate?.measure ?? "none", value: estimate?.estimate ?? null,
    ci: [estimate?.ci_low ?? null, estimate?.ci_high ?? null] as [number | null, number | null], ...(chosen.plan.quality ? { quality: chosen.plan.quality.status } : {}) };
  const cohortRatio = item.results.cohort_n ? Number((platform.n / item.results.cohort_n).toFixed(2)) : undefined;
  const scored = { ...base, ran: true, platform, ...(cohortRatio !== undefined ? { cohort_ratio: cohortRatio } : {}), ...(firstBlocker && base.plans_completed < base.plans_total ? { first_blocker: firstBlocker.slice(0, 240) } : {}) };
  const scale = rdScale(measure, published.value);
  const onPlatformScale = (value: number | null): number | null => value === null ? null : value / scale;
  const publishedValue = onPlatformScale(published.value);
  if (measure === "other" || platform.measure !== measure || publishedValue === null || platform.value === null) return { ...scored, grade: "not_comparable" };
  if (measure === "auc") return { ...scored, grade: Math.abs(platform.value - publishedValue) <= 0.05 ? "agrees" : Math.abs(platform.value - publishedValue) <= 0.1 ? "same_direction" : "differs" };
  const null_ = RATIO.has(measure) ? 1 : 0;
  const side = (value: number): number => Math.sign(RATIO.has(measure) ? Math.log(value) : value - null_);
  const sameDirection = side(platform.value) === side(publishedValue) || (Math.abs(platform.value - null_) < 1e-9 && Math.abs(publishedValue - null_) < 1e-9);
  const low = onPlatformScale(published.ci_low); const high = onPlatformScale(published.ci_high);
  const overlaps = low !== null && high !== null && platform.ci[0] !== null && platform.ci[1] !== null && platform.ci[0] <= high && low <= platform.ci[1];
  return { ...scored, grade: sameDirection && overlaps ? "agrees" : sameDirection ? "same_direction" : "differs" };
};

export const summarize = (scores: CaseScore[]): Record<Grade | "total" | "ran" | "cohort_within_2x", number> => ({
  total: scores.length, ran: scores.filter(({ ran }) => ran).length,
  cohort_within_2x: scores.filter(({ cohort_ratio }) => cohort_ratio !== undefined && cohort_ratio >= 0.5 && cohort_ratio <= 2).length,
  agrees: scores.filter(({ grade }) => grade === "agrees").length, same_direction: scores.filter(({ grade }) => grade === "same_direction").length,
  differs: scores.filter(({ grade }) => grade === "differs").length, not_comparable: scores.filter(({ grade }) => grade === "not_comparable").length,
  did_not_run: scores.filter(({ grade }) => grade === "did_not_run").length,
});

const GRADE: Record<Grade, { en: string; zh: string }> = {
  agrees: { en: "agrees (same direction, CIs overlap)", zh: "一致（方向相同且置信区间重叠）" }, same_direction: { en: "same direction", zh: "方向一致" },
  differs: { en: "opposite direction", zh: "方向相反" }, not_comparable: { en: "not comparable (different measure)", zh: "不可比（指标不同）" }, did_not_run: { en: "did not run", zh: "未能运行" },
};
const fmt = (value: number | null | undefined): string => value === null || value === undefined ? "–" : Math.abs(value) >= 100 ? value.toFixed(0) : Number(value.toPrecision(3)).toString();

/** Bilingual Markdown report of the benchmark. */
export const benchmarkReport = (scores: CaseScore[], language: "en" | "zh", runDate: string): string => {
  const s = summarize(scores); const zh = language === "zh";
  const lines = [
    zh ? `# 文献基准：端到端评估（${runDate}）` : `# Literature benchmark: end-to-end (${runDate})`, "",
    zh ? "每个病例的问题以默认设置（推荐方法、24 小时界标、病情严重度校正）运行，结果与论文报告的队列人数和主要估计比较。已发表研究的队列与变量定义往往更具体，因此“一致”指方向相同且置信区间重叠，并不代表复现了论文。"
      : "Each case's question ran with the default settings (recommended method, 24-hour landmark, severity adjustment) and was compared with the paper's cohort size and primary estimate. Published studies often define cohorts and variables more narrowly, so \"agrees\" means same direction with overlapping confidence intervals, not a reproduction.", "",
    zh ? `运行成功 ${s.ran}/${s.total}；队列人数在论文的 0.5–2 倍内 ${s.cohort_within_2x}/${s.ran}；一致 ${s.agrees}，方向一致 ${s.same_direction}，方向相反 ${s.differs}，不可比 ${s.not_comparable}，未能运行 ${s.did_not_run}。`
      : `Ran ${s.ran}/${s.total}; cohort within 0.5–2× of the paper ${s.cohort_within_2x}/${s.ran}; agrees ${s.agrees}, same direction ${s.same_direction}, opposite ${s.differs}, not comparable ${s.not_comparable}, did not run ${s.did_not_run}.`, "",
    zh ? "| 病例 | 类型 | 论文 n | 平台 n | 论文估计 | 平台估计 | 核查 | 结论 |" : "| Case | Type | Paper n | Platform n | Paper estimate | Platform estimate | Checks | Grade |",
    "|---|---|---|---|---|---|---|---|",
    ...scores.map((score) => `| ${score.case_id} | ${score.study_type} | ${fmt(score.published.n)} | ${score.platform ? fmt(score.platform.n) : "–"} | ${score.published.measure} ${fmt(score.published.value)} (${fmt(score.published.ci[0])}–${fmt(score.published.ci[1])}) | ${score.platform ? `${score.platform.measure} ${fmt(score.platform.value)} (${fmt(score.platform.ci[0])}–${fmt(score.platform.ci[1])})` : "–"} | ${score.platform?.quality ?? "–"} | ${GRADE[score.grade][language]} |`),
    "", zh ? "## 未能运行或部分未完成的原因" : "## Why cases did not run or ran partly", "",
    ...scores.filter(({ first_blocker }) => first_blocker).map((score) => `- ${score.case_id}: ${score.first_blocker}`),
    "", zh ? "受限内容：结果来自 MIMIC-IV 汇总数据，仅可分享给具有 PhysioNet 认证访问权限的人员。" : "Restricted: results are MIMIC-IV-derived aggregates; share only with PhysioNet-credentialed people.",
  ];
  return `${lines.join("\n")}\n`;
};
