import { useLang } from "@/hooks/use-lang";
import { Card, CardContent } from "@/components/ui/card";
import { LiveLine, LogBlock } from "@/components/layout/run-log";
import type { QuestionRunRecord } from "@/lib/api-types";

/** Read-only replay of a finished run's stage log — the same detail shown live while a run is in progress, kept
 * available afterward so the reader can check what happened without waiting through it again. */
export function RunLogView({ record }: { record: QuestionRunRecord }) {
  const { t } = useLang();
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <h3 className="text-base font-semibold">{t.log}</h3>
        <LiveLine live={record.live} />
        <LogBlock live={record.live} defaultOpen />
      </CardContent>
    </Card>
  );
}
