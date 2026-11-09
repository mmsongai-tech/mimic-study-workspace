import { useLang } from "@/hooks/use-lang";
import { formatSince, stageName } from "@/lib/domain";
import { cn } from "@/lib/utils";
import type { QuestionRunRecord } from "@/lib/api-types";

/** Live stage indicator and collapsible event log — shown while a run is active, and kept visible after it
 * fails so the user can see exactly what happened (which stage, which variables resolved) rather than just
 * a one-line error. */
export function LiveLine({ live, stalled = live?.stalled }: { live: QuestionRunRecord["live"]; stalled?: boolean }) {
  const { t, lang } = useLang();
  if (!live) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", stalled ? "bg-destructive" : "animate-pulse bg-primary")} />
        <span>{stageName(t, live.current?.stage || "")}</span>
        {live.current?.detail && <span className="text-muted-foreground">· {live.current.detail.replace(/^all · /u, "")}</span>}
        <span className="text-muted-foreground">
          · {t.lastSignal} {formatSince(live.heartbeat_at, lang)}
        </span>
      </div>
      {stalled && <p className="text-sm text-destructive">{t.stalledHint}</p>}
    </div>
  );
}

export function LogBlock({ live, defaultOpen }: { live: QuestionRunRecord["live"]; defaultOpen?: boolean }) {
  const { t } = useLang();
  if (!live?.events?.length) return null;
  return (
    <details className="rounded-md border" open={defaultOpen}>
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-muted-foreground">{t.log}</summary>
      <ul className="max-h-64 space-y-1 overflow-y-auto scrollbar-thin border-t px-3 py-2 text-xs text-muted-foreground">
        {[...live.events]
          .reverse()
          .slice(0, 30)
          .map((event, index) => (
            <li key={index}>
              {event.at.slice(11, 19)} · {stageName(t, event.stage)}
              {event.detail ? ` · ${event.detail}` : ""}
            </li>
          ))}
      </ul>
    </details>
  );
}
