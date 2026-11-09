import * as React from "react";
import { Download } from "lucide-react";
import { useLang } from "@/hooks/use-lang";
import { estimateText, levelLabel, mediationText, notReliablyEstimable, planDirection, planHeadline, planSentence, studyTypeLabel, type Aim } from "@/lib/domain";
import { formatCount, formatNumber, formatPValue } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { headlineOf, TrustBadge } from "./answer-card";
import type { PlanOutcome, QuestionRunResult, StudyFrame } from "@/lib/api-types";

/** The id of an aim's detail card, so a summary line can jump to it. */
export const aimAnchor = (index: number): string => `aim-${index + 1}`;

const contentWords = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length > 2 && !["change", "the", "and", "with"].includes(word)));

/** The outcome actually analysed when it shares no word with the one asked (e.g. MACE analysed as all-cause death). */
const analysedOutcome = (plan: PlanOutcome, frame: StudyFrame | undefined): string | undefined => {
  const asked = frame?.outcome?.normalized?.label_en; const analysed = plan.study_spec.outcome?.name;
  if (!asked || !analysed) return undefined;
  const askedWords = contentWords(asked); const analysedWords = contentWords(analysed);
  return askedWords.size && analysedWords.size && ![...analysedWords].some((word) => askedWords.has(word)) ? analysed : undefined;
};

/**
 * One screen before the details: what was analysed and what came out, aim by aim, with the checks verdict, the
 * Holm-adjusted P values and the reading limits. Uses the same headline rule as the report (lib/domain planHeadline).
 */
export function ResultSummary({ result, aims, downloads }: {
  result: QuestionRunResult;
  aims: Aim<PlanOutcome>[];
  downloads: Array<{ key: string; label: string; href: string }>;
}) {
  const { t, lang } = useLang();
  const text = t.resultSummary;
  const { summary, multiplicity } = result;
  const adjusted = new Map(multiplicity?.adjusted.map((row) => [row.plan_id, row]) ?? []);
  // Counted over distinct analyses: from the run when it carries the counts, else grouped by shared P values (older runs).
  const distinct = [...new Map((multiplicity?.adjusted ?? []).map((row) => [`${row.p_value}|${row.p_adjusted}`, row])).values()];
  const before = multiplicity?.significant_before ?? distinct.filter(({ p_value }) => p_value < 0.05).length;
  const after = multiplicity?.significant_after ?? distinct.filter(({ p_adjusted }) => p_adjusted < 0.05).length;
  const unanswered = result.unanswered_frames ?? [];
  const hasPrediction = result.plans.some((plan) => plan.chosen_method?.startsWith("prediction."));
  const methodOf = (plan: PlanOutcome) => plan.method_options?.find(({ method_id }) => method_id === plan.chosen_method)?.label[lang];

  const line = (plan: PlanOutcome, frame: StudyFrame | undefined, multi: boolean): React.ReactNode => {
    const level = multi && plan.exposure_level ? <span className="mr-2 font-medium">{levelLabel(lang, frame, plan.exposure_level)}:</span> : null;
    if (plan.status !== "completed" || !plan.result) {
      return (
        <div className="min-w-0 flex-1">
          {level}
          <Badge variant={plan.status === "failed" ? "destructive" : "secondary"} className="mr-2">{t[plan.status as "blocked" | "failed"] ?? plan.status}</Badge>
          <span className="text-muted-foreground">{plan.blockers[0]?.message[lang]}</span>
        </div>
      );
    }
    const unreliable = notReliablyEstimable(plan);
    const headline = planHeadline(plan);
    const headP = headline.kind === "modification" ? headline.p_interaction : headline.kind === "estimate" ? headline.estimate?.p_value ?? undefined : undefined;
    // An adjusted P is shown only when it was computed from the P this row headlines (runs before 2026-10-26 adjusted a
    // subgroup estimate's P for effect-modification analyses and included results that are not reliably estimable).
    const family = adjusted.get(plan.plan_id);
    const pAdjusted = family && typeof headP === "number" && family.p_value === headP ? family.p_adjusted : undefined;
    const significantAfterAdjustment = pAdjusted === undefined || pAdjusted < 0.05;
    const dir = planDirection(t, plan, frame);
    // A result that is not reliably estimable is not reported as a number, so no P value, interaction or mediation goes with it.
    const facts = [
      !unreliable && pAdjusted !== undefined ? `${text.adjustedP} ${formatPValue(pAdjusted)}` : !unreliable && headline.kind === "estimate" && typeof headP === "number" ? `P ${formatPValue(headP)}` : undefined,
      !unreliable && headline.kind === "modification" && headline.estimate ? `${headline.estimate.label}: ${estimateText(lang, formatNumber, headline.estimate)}` : undefined,
      !unreliable && headline.kind === "prediction" && headline.baseline ? `${t.baselineAuc} ${formatNumber(headline.baseline.estimate)}` : undefined,
      !unreliable && plan.result.estimates.some(({ measure }) => measure === "proportion_mediated") ? mediationText(t, formatNumber, plan.result) : undefined,
      methodOf(plan),
      t.analysed(formatCount(plan.result.n_analysed)),
    ].filter((fact): fact is string => Boolean(fact));
    const undated = plan.quality?.checks.some(({ check_id, status }) => check_id === "outcome_timing" && status === "warn");
    const analysedAs = analysedOutcome(plan, frame);
    return (
      <div className="min-w-0 flex-1 space-y-0.5">
        <div>
          {level}
          {/* A direction that does not survive the multiple-comparison adjustment is not shown in bold. */}
          {dir && <span className={significantAfterAdjustment ? "mr-1.5 font-semibold" : "mr-1.5 text-muted-foreground"}>{dir}</span>}
          <span className="whitespace-nowrap">{headlineOf(t, lang, plan)}</span>
          {facts.map((fact) => <span key={fact} className="text-muted-foreground"> · <span className="whitespace-nowrap">{fact}</span></span>)}
        </div>
        {(undated || analysedAs) && (
          <div className="text-xs text-warning">{[analysedAs ? text.analysedAs(analysedAs) : undefined, undated ? text.timingShort : undefined].filter(Boolean).join(lang === "zh" ? "；" : "; ")}</div>
        )}
      </div>
    );
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">{text.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{text.scope(summary.frames, summary.plans, summary.completed, summary.plans - summary.completed, unanswered.length)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex items-center gap-1 text-muted-foreground"><Download className="h-3.5 w-3.5" /> {t.downloads}:</span>
            {downloads.map((link) => <a key={link.key} href={link.href} className="text-primary hover:underline">{link.label}</a>)}
          </div>
        </div>

        {(aims.length > 0 || unanswered.length > 0) && (
          <ol className="divide-y rounded-lg border">
            {aims.map((aim, index) => {
              const multi = aim.items.length > 1;
              const first = aim.items[0]!;
              return (
                <li key={aim.frame_id} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Badge variant="accent">{t.aim} {index + 1}</Badge>
                      <span className="text-xs text-muted-foreground">{studyTypeLabel(lang, aim.frame?.study_type)}</span>
                    </div>
                    <a href={`#${aimAnchor(index)}`} className="text-xs text-primary hover:underline">{text.jump}</a>
                  </div>
                  <p className="text-sm font-medium">{planSentence(t, lang, multi ? { ...first, exposure_level: undefined } : first, aim.frame)}</p>
                  <ul className="space-y-1.5">
                    {aim.items.map((plan) => (
                      <li key={plan.plan_id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-sm">
                        {line(plan, aim.frame, multi)}
                        {plan.status === "completed" && <TrustBadge quality={plan.quality} />}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
            {unanswered.map(({ frame, reasons }, index) => (
              <li key={`unanswered-${index}`} className="space-y-1 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge variant="secondary">{text.notAnalysed}</Badge>
                  <span className="text-xs text-muted-foreground">{studyTypeLabel(lang, frame.study_type)}</span>
                </div>
                <p className="font-medium">{frame.sub_question}</p>
                {reasons[0] && <p className="text-muted-foreground">{reasons[0][lang]}</p>}
              </li>
            ))}
          </ol>
        )}

        <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
          {multiplicity && <li>{before ? text.multiplicity(multiplicity.analyses, before, after) : text.multiplicityNone(multiplicity.analyses)}</li>}
          {hasPrediction && <li>{text.prediction}</li>}
          <li>{text.observational}</li>
        </ul>
      </CardContent>
    </Card>
  );
}
