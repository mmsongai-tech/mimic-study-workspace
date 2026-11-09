import { useLang } from "@/hooks/use-lang";
import { aimsOf, planSentence, studyTypeLabel } from "@/lib/domain";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BlockerList } from "@/components/detail/blocker-list";
import { LiveLine, LogBlock } from "@/components/layout/run-log";
import type { QuestionPlanDraft, QuestionRunRecord } from "@/lib/api-types";

/**
 * Rendered instead of a blank page when a run ends in "failed" — the plan draft is fetched even for failed runs
 * (it is written before the run can fail), so we can show exactly which aims had no runnable analysis and why,
 * plus the full stage-by-stage log, rather than just the one-line record.error.
 */
export function FailedView({ record, draft }: { record: QuestionRunRecord; draft: QuestionPlanDraft | undefined }) {
  const { t, lang } = useLang();
  const aims = draft ? aimsOf(draft.plans, draft.frame_set.frames, (item) => item.plan) : [];

  return (
    <div className="space-y-4">
      {aims.length > 0 && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div>
              <h3 className="text-base font-semibold">{t.failedTitle}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t.failedHint}</p>
            </div>
            {aims.map((aim, index) => {
              const first = aim.items[0];
              const frame = aim.frame;
              const multi = aim.items.length > 1;
              const blocked = aim.items.filter((item) => item.status !== "ready");
              const sentence = planSentence(t, lang, multi ? { ...first.plan, exposure_level: undefined } : first.plan, frame);
              const blockers = blocked.flatMap((item) => item.blocked_outcome?.blockers || []);
              return (
                <div key={aim.frame_id} className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="accent">{t.aim} {index + 1}</Badge>
                    <span className="text-sm text-muted-foreground">{studyTypeLabel(lang, frame?.study_type)}</span>
                  </div>
                  <p className="text-sm font-medium">{sentence}</p>
                  {blockers.length > 0 && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                      <p className="text-sm font-semibold text-destructive">{t.notRunnable}</p>
                      <BlockerList blockers={blockers} />
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-3 pt-6">
          <h3 className="text-base font-semibold">{t.log}</h3>
          <LiveLine live={record.live} />
          <LogBlock live={record.live} defaultOpen />
        </CardContent>
      </Card>
    </div>
  );
}
