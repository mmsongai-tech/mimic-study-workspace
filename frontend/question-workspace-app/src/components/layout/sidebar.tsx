import { Languages, FlaskConical, ListChecks, MessageSquareText, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLang } from "@/hooks/use-lang";
import { useDeleteRun, useRunList } from "@/hooks/use-runs";
import { isInProgress, isReadOnly } from "./run-actions";
import { ranWithNoResult } from "@/lib/domain";
import { StatusBadge } from "./status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { QuestionRunRecord } from "@/lib/api-types";

// Run times are stored in UTC (ISO strings); show them in the reader's own time zone as MM-DD HH:mm.
const localTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(5, 16).replace("T", " ");
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

interface SidebarProps {
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onNewQuestion: () => void;
  onDeleted: (id: string) => void;
  section: "questions" | "variables";
  onSection: (section: "questions" | "variables") => void;
  onHome: () => void;
}

export function Sidebar({ selectedId, onSelect, onNewQuestion, onDeleted, section, onSection, onHome }: SidebarProps) {
  const { t, toggle, lang } = useLang();
  const { data: runs, isLoading } = useRunList();

  return (
    <aside className="flex h-full w-full flex-col border-r bg-card sm:w-72 lg:w-80">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-4">
        <button type="button" onClick={onHome} title={t.cover.home} className="flex items-center gap-2 rounded-md text-left transition-opacity hover:opacity-80">
          <FlaskConical className="h-5 w-5 text-primary" />
          <div>
            <div className="text-sm font-semibold leading-tight">{t.title}</div>
            <div className="text-xs text-muted-foreground">{t.localOnly}</div>
          </div>
        </button>
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label={t.switchLang}
        >
          <Languages className="h-3.5 w-3.5" />
          {t.switchLang}
        </button>
      </div>

      <nav className="grid grid-cols-2 gap-1 border-b p-2" aria-label="sections">
        {([["questions", MessageSquareText, lang === "zh" ? "研究问题" : "Questions"], ["variables", ListChecks, lang === "zh" ? "变量" : "Variables"]] as const).map(([value, Icon, label]) => (
          <button key={value} type="button" onClick={() => onSection(value)} aria-current={section === value ? "page" : undefined}
            className={cn("flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors", section === value ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60")}>
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
      </nav>

      <div className="space-y-2 border-b p-3">
        <button
          type="button"
          onClick={onNewQuestion}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
        >
          {t.newQuestion}
        </button>
        <a href="/how-it-works.html" target="_blank" rel="noreferrer" className="block text-center text-xs text-muted-foreground underline-offset-4 hover:underline">{t.accessHow}</a>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-2">
        <div className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.runs}</div>
        {isLoading ? (
          <div className="space-y-2 p-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : !runs?.length ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">{t.noRuns}</p>
        ) : (
          <ul className="space-y-1">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} active={run.id === selectedId} onSelect={onSelect} onDeleted={onDeleted} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function RunRow({ run, active, onSelect, onDeleted }: { run: QuestionRunRecord; active: boolean; onSelect: (id: string) => void; onDeleted: (id: string) => void }) {
  const { t } = useLang();
  const deleteRun = useDeleteRun();
  const canDelete = !isReadOnly(run) && !isInProgress(run);
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onSelect(run.id)}
        className={cn(
          "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors",
          active ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-accent",
        )}
      >
        <div className="line-clamp-2 font-medium text-foreground">{run.question}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <StatusBadge status={run.status} stalled={run.live?.stalled} noResult={ranWithNoResult(run)} />
          <span>{localTime(run.created_at)}</span>
          {run.source === "command_line" && <span>· {t.commandLine}</span>}
        </div>
      </button>
      {canDelete && (
        <button
          type="button"
          aria-label={t.deleteRun}
          title={t.deleteRun}
          disabled={deleteRun.isPending}
          onClick={() => {
            if (window.confirm(t.confirmDelete(run.question))) deleteRun.mutate(run.id, { onSuccess: () => onDeleted(run.id) });
          }}
          className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}
