import * as React from "react";
import { useLang } from "@/hooks/use-lang";
import { useRun, useRunList, usePlanDraft, useRunResult } from "@/hooks/use-runs";
import { composeHeading, isStalled, ranWithNoResult, stepIndex } from "@/lib/domain";
import { Sidebar } from "@/components/layout/sidebar";
import { StepRail } from "@/components/layout/step-rail";
import { StatusBadge } from "@/components/layout/status-badge";
import { AskView } from "@/features/ask/ask-view";
import { ReviewView } from "@/features/review/review-view";
import { RunningView } from "@/features/running/running-view";
import { ResultsView } from "@/features/results/results-view";
import { FailedView } from "@/features/failed/failed-view";
import { PlanSummaryView } from "@/features/plan-summary/plan-summary-view";
import { RunLogView } from "@/features/plan-summary/run-log-view";
import { editReplaces, RunActions } from "@/components/layout/run-actions";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { DefineVariableProvider } from "@/features/variables/define-context";
import { VariablesView, type DefineFlow } from "@/features/variables/variables-view";
import { unmappedTermsOf } from "@/components/detail/blocker-list";
import { CoverView } from "@/features/cover/cover-view";

export default function App() {
  const { t, lang } = useLang();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined);
  // The cover opens once per browser tab; the title in the sidebar brings it back.
  const [onCover, setOnCover] = React.useState(() => { try { return window.sessionStorage.getItem("mimic-cover-passed") !== "1"; } catch { return true; } });
  const leaveCover = () => { setOnCover(false); try { window.sessionStorage.setItem("mimic-cover-passed", "1"); } catch { /* storage blocked: the cover shows again on reload */ } };
  const [asking, setAsking] = React.useState(false);
  // The Variables page: opened from the sidebar, or from a mapping row that could not be resolved (then it starts with that term).
  const [section, setSection] = React.useState<"questions" | "variables">("questions");
  const [defineTerm, setDefineTerm] = React.useState<string | undefined>(undefined);
  const [autoSelected, setAutoSelected] = React.useState(false);
  const [editing, setEditing] = React.useState<{ id: string; question: string; replaces: boolean } | undefined>(undefined);
  // Which step of a completed run's history the reader is looking back at; reset whenever the selected run changes
  // so a fresh selection always opens on its current stage (results for a completed run).
  const [viewStage, setViewStage] = React.useState<number | null>(null);
  React.useEffect(() => setViewStage(null), [selectedId]);

  const { data: runs } = useRunList();
  const runQuery = useRun(selectedId);
  const record = runQuery.data;
  // Failed polls re-render the page, so this also turns on when the server itself has stopped answering.
  const stalled = record ? isStalled(record, { now: Date.now(), answeredAt: runQuery.dataUpdatedAt, failedAt: runQuery.errorUpdatedAt }) : false;

  // Select the most recent run once, on first load, the way the previous app did.
  React.useEffect(() => {
    if (!autoSelected && !selectedId && runs && runs.length > 0) {
      setSelectedId(runs[0].id);
      setAutoSelected(true);
    } else if (!autoSelected && runs) {
      setAutoSelected(true);
    }
  }, [runs, selectedId, autoSelected]);

  const { data: draft } = usePlanDraft(selectedId, record?.status === "awaiting_confirmation" || record?.status === "failed");
  const { data: result } = useRunResult(selectedId, record?.status === "completed");
  // record.result_summary is written once a run completes and covers the common case cheaply; a run that finished
  // before that existed falls back to the full result once it's loaded.
  const summary = record?.result_summary ?? result?.summary;
  const noResult = record ? ranWithNoResult({ status: record.status, result_summary: summary }) : false;
  // Only compose in English: the original question is Chinese-authored almost always, so Chinese mode should
  // show it verbatim; English mode is where a raw Chinese heading otherwise reads oddly next to English aims.
  const composedHeading = lang === "en" ? composeHeading(t, lang, draft?.frame_set ?? result?.frame_set) : undefined;

  // Completed runs keep every stage's detail on disk, so the reader can look back at any of them without
  // re-running anything; other statuses only ever have one relevant stage to show.
  const browsable = record?.status === "completed" && Boolean(result);
  const activeStage = browsable ? viewStage ?? stepIndex(record!) : null;

  const askOpen = asking || !selectedId;

  // Define-then-plan: every variable a blocked question could not map is defined in turn, then the question is planned again on its own.
  const blockedTerms = React.useMemo(() => unmappedTermsOf((draft?.plans ?? []).flatMap((plan) => plan.blocked_outcome?.blockers ?? [])), [draft]);
  const [definedTerms, setDefinedTerms] = React.useState<string[]>([]);
  const [autoRun, setAutoRun] = React.useState(false);
  React.useEffect(() => setDefinedTerms([]), [selectedId]);
  const replan = async (): Promise<void> => {
    if (!record) return;
    const run = await api.startRun({ question: record.question, ...(autoRun ? { auto_confirm: true } : {}) });
    await queryClient.invalidateQueries({ queryKey: ["runs"] });
    setDefinedTerms([]); setDefineTerm(undefined);
    select(run.id);
  };
  const flow: DefineFlow | undefined = blockedTerms.length && defineTerm && blockedTerms.includes(defineTerm)
    ? { terms: blockedTerms, done: definedTerms, auto_run: autoRun, onAutoRun: setAutoRun, onSaved: (term) => {
      const done = [...new Set([...definedTerms, term])]; setDefinedTerms(done);
      const next = blockedTerms.find((item) => !done.includes(item));
      if (next) setDefineTerm(next); else void replan();
    } } : undefined;

  // A question format chosen from the kinds offered for a question that could not be planned goes into the question box.
  const rewrite = (format: string) => {
    if (!record) return;
    setEditing({ id: record.id, question: format, replaces: editReplaces(record) });
    setAsking(true);
  };

  const select = (id: string) => {
    setSelectedId(id);
    setAsking(false);
    setSection("questions");
  };

  if (onCover) return <CoverView onStarted={(id) => { leaveCover(); select(id); }} onEnter={leaveCover} />;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar onHome={() => setOnCover(true)} section={section} onSection={(next) => { setDefineTerm(undefined); setSection(next); }} selectedId={selectedId} onSelect={select} onNewQuestion={() => { setEditing(undefined); setAsking(true); setSection("questions"); }} onDeleted={(id) => { if (id === selectedId) setSelectedId(undefined); }} />
      <main className="flex-1 overflow-y-auto scrollbar-thin">
        {section === "variables" && (
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
            <VariablesView key={defineTerm ?? "free"} initialTerm={defineTerm} flow={flow} onReplan={record ? replan : undefined} onBack={selectedId ? () => { setDefineTerm(undefined); setSection("questions"); } : undefined} />
          </div>
        )}
        <DefineVariableProvider value={(term) => { setDefineTerm(term); setSection("variables"); }}>
        <div className={section === "variables" ? "hidden" : "mx-auto max-w-4xl space-y-4 px-4 py-6 sm:px-6"}>
          <AskView
            open={askOpen}
            onOpen={() => setAsking(true)}
            onClose={() => setAsking(false)}
            closable={Boolean(selectedId)}
            onStarted={select}
            editing={editing}
            onEditDone={() => setEditing(undefined)}
          />

          {selectedId && record && (
            <div className="space-y-4">
              <div className="rounded-xl border bg-card p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h2 className="text-lg font-semibold">{composedHeading ?? record.question}</h2>
                  <StatusBadge status={record.status} stalled={stalled} noResult={noResult} />
                </div>
                {composedHeading && composedHeading !== record.question && (
                  <p className="mt-1 text-xs text-muted-foreground">{t.asSubmitted}: {record.question}</p>
                )}
                <div className="mt-4">
                  <StepRail record={record} onSelect={browsable ? setViewStage : undefined} selected={activeStage ?? undefined} />
                </div>
                {record.lock_id && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {t.lockedAs} <code className="rounded bg-muted px-1 py-0.5">{record.lock_id.slice(-12)}</code>
                    {" · "}
                    {t.confirmedBy[record.confirmed_by ?? "automatic"]}
                  </p>
                )}
                {record.error && <p className="mt-3 text-sm text-destructive">{t.error}: {record.error}</p>}
                <div className="mt-3">
                  <RunActions
                    record={record}
                    onEdit={(target) => { setEditing(target); setAsking(true); }}
                    onDeleted={(id) => { if (id === selectedId) setSelectedId(undefined); }}
                  />
                </div>
              </div>

              {record.status === "awaiting_confirmation" && draft && <ReviewView runId={record.id} draft={draft} onStarted={select} onRewrite={rewrite} />}
              {(record.status === "queued" || record.status === "drafting" || record.status === "running") && <RunningView record={record} stalled={stalled} />}
              {record.status === "completed" && !result && (
                <div className="space-y-3">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              )}
              {browsable && result && activeStage === 1 && <PlanSummaryView result={result} />}
              {browsable && activeStage === 2 && <RunLogView record={record} />}
              {browsable && result && activeStage === 3 && <ResultsView record={record} result={result} onRewrite={rewrite} />}
              {record.status === "failed" && <FailedView record={record} draft={draft} />}
            </div>
          )}
        </div>
        </DefineVariableProvider>
      </main>
    </div>
  );
}
