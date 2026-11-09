import * as React from "react";
import { useLang } from "@/hooks/use-lang";
import { useReanalyse, usePlanDraft } from "@/hooks/use-runs";
import { aimsOf, estimateText, levelLabel, modelDidNotRespond, notReliablyEstimable, planDirection, planSentence, rawCounts, sparseEstimate, studyTypeLabel, type Aim } from "@/lib/domain";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AnswerCard, headlineOf, TrustBadge } from "./answer-card";
import { aimAnchor, ResultSummary } from "./summary-card";
import { offersQuestionKinds, QuestionKinds } from "@/features/ask/question-kinds";
import type { DesignOptions, PlanOptionChoice, PlanOutcome, QuestionRunRecord, QuestionRunResult } from "@/lib/api-types";

/** `onRewrite`: puts a question format into the question box, offered when nothing in the question could be planned. */
export function ResultsView({ record, result, onRewrite }: { record: QuestionRunRecord; result: QuestionRunResult; onRewrite?: (format: string) => void }) {
  const { t, lang } = useLang();
  const [pendingMethods, setPendingMethods] = React.useState<Record<string, string>>({});
  const [pendingOptions, setPendingOptions] = React.useState<Record<string, PlanOptionChoice>>({});
  const reanalyse = useReanalyse();
  // The draft is only source of the design options a plan *offers* (landmark hours, severity variable names);
  // it's always fetchable regardless of run status, and never rewritten after a run completes.
  const { data: draft } = usePlanDraft(record.id, true);

  const aims = aimsOf(result.plans, result.frame_set.frames, (plan) => plan);
  const modelDown = modelDidNotRespond(result.unanswered_frames);

  const designOptionsByPlan = React.useMemo(
    () => new Map(draft?.plans.map((item) => [item.plan.plan_id, item.design_options] as const) ?? []),
    [draft],
  );

  const changed = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const plan of result.plans) {
      const chosen = pendingMethods[plan.plan_id];
      if (chosen && chosen !== plan.chosen_method) out[plan.plan_id] = chosen;
    }
    return out;
  }, [pendingMethods, result.plans]);

  const hasChanges = Object.keys(changed).length > 0 || Object.keys(pendingOptions).length > 0;
  const canReanalyse = result.plans.some((p) => p.method_options?.length || designOptionsByPlan.get(p.plan_id));

  const downloadLinks = (["docx", "md", "txt"] as const).flatMap((ext) =>
    (["zh", "en"] as const).map((fileLang) => ({
      key: `${fileLang}.${ext}`,
      label: `${fileLang === "zh" ? "中文" : "EN"} .${ext}`,
      href: api.fileUrl(record.id, `report.${fileLang}.${ext}`),
    })),
  );

  const setOption = (planId: string, patch: Partial<PlanOptionChoice>) =>
    setPendingOptions((prev) => ({ ...prev, [planId]: { ...prev[planId], ...patch } }));

  const submitReanalyse = () => {
    if (!hasChanges) return;
    reanalyse.mutate({ reanalysis_of: record.id, methods: changed, ...(Object.keys(pendingOptions).length ? { options: pendingOptions } : {}) });
  };

  return (
    <div className="space-y-4">
      <ResultSummary result={result} aims={aims} downloads={downloadLinks} />

      {aims.map((aim, index) => (
        <ResultAim
          key={aim.frame_id}
          runId={record.id}
          aim={aim}
          index={index}
          selectedMethods={pendingMethods}
          onSelectMethod={(planId, methodId) => setPendingMethods((prev) => ({ ...prev, [planId]: methodId }))}
          designOptionsByPlan={designOptionsByPlan}
          pendingOptions={pendingOptions}
          onSetOption={setOption}
        />
      ))}

      {!!result.unanswered_frames?.length && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <h3 className="text-base font-semibold">{modelDown ? t.modelDown : t.unanswered}</h3>
            {modelDown && <p className="text-sm text-muted-foreground">{t.modelDownHint}</p>}
            {result.unanswered_frames.map(({ frame, reasons }, index) => (
              <div key={index}>
                <p className="text-sm font-medium">{frame.sub_question}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                  {reasons.map((r, i) => (
                    <li key={i}>{r[lang]}</li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {offersQuestionKinds({ plans: result.plans, unanswered_frames: result.unanswered_frames, clarifications: draft?.clarifications, mapping_clarifications: draft?.mapping_clarifications }) && onRewrite && (
        <Card>
          <CardContent className="pt-6">
            <QuestionKinds onPick={onRewrite} prompt={t.questionScope.pick} />
          </CardContent>
        </Card>
      )}

      {canReanalyse && (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
          <span className="text-sm text-muted-foreground">{t.reanalyseHint}</span>
          <div className="flex items-center gap-2">
            {reanalyse.isError && <span className="text-sm text-destructive">{t.error}: {(reanalyse.error as Error).message}</span>}
            <Button onClick={submitReanalyse} disabled={!hasChanges || reanalyse.isPending}>
              {t.reanalyse}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultAim({
  runId,
  aim,
  index,
  selectedMethods,
  onSelectMethod,
  designOptionsByPlan,
  pendingOptions,
  onSetOption,
}: {
  runId: string;
  aim: Aim<PlanOutcome>;
  index: number;
  selectedMethods: Record<string, string>;
  onSelectMethod: (planId: string, methodId: string) => void;
  designOptionsByPlan: Map<string, DesignOptions | undefined>;
  pendingOptions: Record<string, PlanOptionChoice>;
  onSetOption: (planId: string, patch: Partial<PlanOptionChoice>) => void;
}) {
  const { t, lang } = useLang();
  const frame = aim.frame;
  const multi = aim.items.length > 1;
  const first = aim.items[0];
  const sentence = planSentence(t, lang, multi ? { ...first, exposure_level: undefined } : first, frame);
  const [openLevel, setOpenLevel] = React.useState<string | null>(null);

  return (
    <Card id={aimAnchor(index)} className="scroll-mt-4">
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-center gap-2">
          <Badge variant="accent">{t.aim} {index + 1}</Badge>
          <span className="text-sm text-muted-foreground">{studyTypeLabel(lang, frame?.study_type)}</span>
        </div>
        <p className="text-sm font-medium">{sentence}</p>

        {multi && (() => {
          const done = aim.items.filter((plan) => plan.status === "completed");
          const few = done.filter((plan) => notReliablyEstimable(plan)).length;
          const timing = done.some((plan) => plan.quality?.checks.some((check) => check.check_id === "outcome_timing"));
          return (
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">{t.aimSummary(aim.items.length, done.length - few, few, aim.items.length - done.length)}</p>
              {timing && <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">{t.timingBanner}</p>}
            </div>
          );
        })()}

        {multi ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <tbody>
                {aim.items.map((plan) => {
                  const unreliable = plan.status === "completed" && notReliablyEstimable(plan);
                  const open = openLevel === plan.plan_id;
                  return (
                    <React.Fragment key={plan.plan_id}>
                      <tr className="border-b last:border-0">
                        <td className="px-3 py-2 font-medium">{levelLabel(lang, frame, plan.exposure_level!)}</td>
                        <td className="px-3 py-2">
                          {unreliable ? (
                            <div className="space-y-0.5"><span className="text-muted-foreground">{t.notEstimable}</span>
                              {rawCounts(plan).map((line, i) => <div key={i} className="text-xs text-muted-foreground">{line}</div>)}
                              {sparseEstimate(plan.result) && <div className="text-xs text-muted-foreground">{t.firthLine}: {estimateText(lang, formatNumber, sparseEstimate(plan.result))}</div>}</div>
                          ) : plan.status === "completed" ? headlineOf(t, lang, plan) : (
                            <div className="space-y-0.5"><Badge variant="secondary">{t[plan.status as "blocked" | "failed"] ?? plan.status}</Badge>
                              {plan.blockers[0] && <div className="max-w-md text-xs text-muted-foreground" title={plan.blockers[0].message[lang]}>{plan.blockers[0].message[lang]}</div>}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{planDirection(t, plan, frame) || "–"}</td>
                        <td className="px-3 py-2"><TrustBadge quality={plan.quality} /></td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" className="text-sm text-primary hover:underline" onClick={() => setOpenLevel(open ? null : plan.plan_id)}>
                            {open ? t.hideDetails : t.details}
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={5} className="px-3 pb-3">
                            <AnswerCard
                              runId={runId}
                              plan={plan}
                              frame={frame}
                              selectedMethod={selectedMethods[plan.plan_id] ?? plan.chosen_method ?? ""}
                              onChangeMethod={(methodId) => onSelectMethod(plan.plan_id, methodId)}
                              designOptions={designOptionsByPlan.get(plan.plan_id)}
                              optionChoice={pendingOptions[plan.plan_id]}
                              onSetOption={(patch) => onSetOption(plan.plan_id, patch)}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <AnswerCard
            runId={runId}
            plan={first}
            frame={frame}
            selectedMethod={selectedMethods[first.plan_id] ?? first.chosen_method ?? ""}
            onChangeMethod={(methodId) => onSelectMethod(first.plan_id, methodId)}
            designOptions={designOptionsByPlan.get(first.plan_id)}
            optionChoice={pendingOptions[first.plan_id]}
            onSetOption={(patch) => onSetOption(first.plan_id, patch)}
          />
        )}
      </CardContent>
    </Card>
  );
}
