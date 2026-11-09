import { useLang } from "@/hooks/use-lang";
import { stageName } from "@/lib/domain";
import { keepOpenHints } from "@/lib/i18n";
import { useInviteGate } from "@/features/access/access-gate";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { LiveLine, LogBlock } from "@/components/layout/run-log";
import type { QuestionRunRecord } from "@/lib/api-types";

/** `stalled` comes from the page (isStalled), which also notices when the server itself stopped answering. */
export function RunningView({ record, stalled }: { record: QuestionRunRecord; stalled: boolean }) {
  const { t } = useLang();
  const inviteGate = useInviteGate();
  const live = record.live;

  const isPreparing = record.status === "drafting" || (record.status === "queued" && !record.lock_id && !record.reanalysis_of);
  if (isPreparing) {
    return (
      <Card>
        <CardContent className="space-y-4 pt-6">
          <Progress value={undefined} />
          <p className="text-sm">{t.preparing}</p>
          <LiveLine live={live} stalled={stalled} />
          <LogBlock live={live} />
        </CardContent>
      </Card>
    );
  }

  const events = live?.events || [];
  const last = [...events].reverse().find((e) => e.stage === "plan" && /\d+\/\d+/.test(e.detail || ""));
  const match = last?.detail?.match(/(\d+)\/(\d+)/);
  const done = match ? Number(match[1]) : 0;
  const total = match ? Number(match[2]) : 0;
  const readingAll = !last && events.some((e) => e.stage === "cohort" && /^all/.test(e.detail || ""));
  const percent = total ? Math.round((done / total) * 100) : 0;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div>
          <h3 className="text-base font-semibold">{t.runningTitle}</h3>
          <p className="text-sm text-muted-foreground">{keepOpenHints(t, inviteGate).running}</p>
        </div>
        <Progress value={total ? percent : undefined} />
        <p className="text-sm font-medium">
          {total ? t.plansDone(done, total) : readingAll ? t.readingAll : stageName(t, live?.current?.stage || "")}
        </p>
        <LiveLine live={live} stalled={stalled} />
        <LogBlock live={live} />
      </CardContent>
    </Card>
  );
}
