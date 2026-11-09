import { useLang } from "@/hooks/use-lang";
import { aimsOf, levelLabel, planSentence, studyTypeLabel } from "@/lib/domain";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProtocolTable } from "@/components/detail/protocol-table";
import { MappingTable } from "@/components/detail/mapping-table";
import { AssumptionsList } from "@/components/detail/assumptions-list";
import type { PlanOutcome, QuestionRunResult, StudyFrame } from "@/lib/api-types";

/**
 * Read-only "what did we actually analyse" view for a completed run's plan step. Unlike the review screen (which
 * offers choices before a run starts), this shows the choices that were actually locked in — the chosen method and
 * design notes come straight from each plan's result, not from the draft's defaults — so it stays accurate even
 * though the draft file only ever records what was originally proposed.
 */
export function PlanSummaryView({ result }: { result: QuestionRunResult }) {
  const { t, lang } = useLang();
  const aims = aimsOf(result.plans, result.frame_set.frames, (plan) => plan);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <h3 className="text-base font-semibold">{t.whatWasAnalysed}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t.whatWasAnalysedHint}</p>
        </CardContent>
      </Card>

      {aims.map((aim, index) => {
        const frame = aim.frame;
        const multi = aim.items.length > 1;
        const first = aim.items[0];
        const sentence = planSentence(t, lang, multi ? { ...first, exposure_level: undefined } : first, frame);
        return (
          <Card key={aim.frame_id}>
            <CardContent className="space-y-4 pt-6">
              <div className="flex items-center gap-2">
                <Badge variant="accent">{t.aim} {index + 1}</Badge>
                <span className="text-sm text-muted-foreground">{studyTypeLabel(lang, frame?.study_type)}</span>
              </div>
              <p className="text-sm font-medium">{sentence}</p>

              {aim.items.map((plan) => (
                <PlanLevel key={plan.plan_id} plan={plan} frame={frame} showLevelLabel={multi} lang={lang} />
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function PlanLevel({ plan, frame, showLevelLabel, lang }: { plan: PlanOutcome; frame: StudyFrame | undefined; showLevelLabel: boolean; lang: "zh" | "en" }) {
  const { t } = useLang();
  if (plan.status !== "completed") {
    return (
      <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        {showLevelLabel && <span className="font-medium text-foreground">{levelLabel(lang, frame, plan.exposure_level ?? "")}: </span>}
        {t.notRunnable}
      </div>
    );
  }
  const methodLabel = plan.method_options?.find((o) => o.method_id === plan.chosen_method)?.label[lang] ?? plan.chosen_method;
  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        {showLevelLabel && <Badge variant="secondary">{levelLabel(lang, frame, plan.exposure_level ?? "")}</Badge>}
        <span className="text-sm">
          {t.method}: <b>{methodLabel}</b>
        </span>
      </div>
      {!!plan.design_notes?.length && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
          {plan.design_notes.map((note, i) => (
            <li key={i}>{note[lang]}</li>
          ))}
        </ul>
      )}
      <ProtocolTable protocol={plan.protocol} />
      <MappingTable mapping={plan.mapping} />
      <AssumptionsList assumptions={plan.study_spec.assumptions} />
    </div>
  );
}
