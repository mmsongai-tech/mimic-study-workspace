import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { useLang } from "@/hooks/use-lang";
import { useConfirmPlan, useStartRun } from "@/hooks/use-runs";
import { api } from "@/lib/api";
import { aimsOf, modelDidNotRespond, planSentence, levelLabel, studyTypeLabel, warningsOf, type Aim } from "@/lib/domain";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChipCheckbox } from "@/components/ui/chip-checkbox";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ProtocolTable } from "@/components/detail/protocol-table";
import { MappingTable } from "@/components/detail/mapping-table";
import { BlockerList } from "@/components/detail/blocker-list";
import { AssumptionsList } from "@/components/detail/assumptions-list";
import { DetailsToggle } from "@/components/detail/details-toggle";
import { DesignOptionsBlock } from "@/components/detail/design-options-block";
import { offersQuestionKinds, QuestionKinds } from "@/features/ask/question-kinds";
import { useInviteGate } from "@/features/access/access-gate";
import { keepOpenHints } from "@/lib/i18n";
import type { DraftPlan, PlanOptionChoice, QuestionPlanDraft, TimeChoice } from "@/lib/api-types";

interface FormState {
  excluded: Set<string>;
  methods: Record<string, string>; // frame_id -> method_id
  landmark: Record<string, boolean>; // frame_id -> on
  severity: Record<string, string[]>; // frame_id -> selected names
  time: Record<string, TimeChoice>; // frame_id -> time choices (empty = defaults)
}

function initialState(draft: QuestionPlanDraft): FormState {
  const methods: Record<string, string> = {};
  const landmark: Record<string, boolean> = {};
  const severity: Record<string, string[]> = {};
  for (const aim of aimsOf(draft.plans, draft.frame_set.frames, (item) => item.plan)) {
    const first = aim.items[0];
    if (first.default_method) methods[aim.frame_id] = first.default_method;
    const ready = aim.items.filter((item) => item.status === "ready");
    const options = ready[0]?.design_options;
    if (options?.landmark) landmark[aim.frame_id] = options.landmark.default;
    if (options?.severity) severity[aim.frame_id] = [...options.severity.default_on];
  }
  return { excluded: new Set(), methods, landmark, severity, time: {} };
}

function runnableCount(draft: QuestionPlanDraft, excluded: Set<string>): number {
  return draft.plans.filter((item) => item.status === "ready" && !excluded.has(item.plan.plan_id)).length;
}

function buildConfirmPayload(draft: QuestionPlanDraft, form: FormState) {
  const methods: Record<string, string> = {};
  const options: Record<string, PlanOptionChoice> = {};
  for (const item of draft.plans) {
    if (item.status !== "ready") continue;
    const method = form.methods[item.plan.frame_id];
    if (method) methods[item.plan.plan_id] = method;
    if (item.design_options) {
      const choice: PlanOptionChoice = {};
      if (item.design_options.landmark) choice.landmark = form.landmark[item.plan.frame_id];
      if (item.design_options.severity) {
        choice.severity_on = (form.severity[item.plan.frame_id] || []).filter((v) => item.design_options!.severity!.names.includes(v));
      }
      const time = form.time[item.plan.frame_id];
      if (item.design_options.time && time && Object.keys(time).length) choice.time = time;
      if (Object.keys(choice).length) options[item.plan.plan_id] = choice;
    }
  }
  return { methods, excluded: [...form.excluded], options };
}

/** `onRewrite`: puts a question format into the question box, offered when nothing in the question could be planned. */
export function ReviewView({ runId, draft, onStarted, onRewrite }: { runId: string; draft: QuestionPlanDraft; onStarted?: (id: string) => void; onRewrite?: (format: string) => void }) {
  const { t, lang } = useLang();
  const inviteGate = useInviteGate();
  const startRun = useStartRun();
  const [form, setForm] = React.useState<FormState>(() => initialState(draft));
  const confirmPlan = useConfirmPlan(runId);

  const aims = aimsOf(draft.plans, draft.frame_set.frames, (item) => item.plan);
  const runnable = runnableCount(draft, form.excluded);
  const modelDown = modelDidNotRespond(draft.unanswered_frames);

  const toggleExcluded = (planId: string, include: boolean) => {
    setForm((prev) => {
      const excluded = new Set(prev.excluded);
      if (include) excluded.delete(planId);
      else excluded.add(planId);
      return { ...prev, excluded };
    });
  };
  const setMethod = (frameId: string, methodId: string) => setForm((prev) => ({ ...prev, methods: { ...prev.methods, [frameId]: methodId } }));
  const setLandmark = (frameId: string, on: boolean) => setForm((prev) => ({ ...prev, landmark: { ...prev.landmark, [frameId]: on } }));
  const setSeverity = (frameId: string, names: string[]) => setForm((prev) => ({ ...prev, severity: { ...prev.severity, [frameId]: names } }));
  const setTime = (frameId: string, patch: TimeChoice) => setForm((prev) => ({ ...prev, time: { ...prev.time, [frameId]: { ...prev.time[frameId], ...patch } } }));

  const submit = () => {
    if (!runnable) return;
    confirmPlan.mutate(buildConfirmPayload(draft, form));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <h3 className="text-base font-semibold">{t.reviewTitle}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{keepOpenHints(t, inviteGate).review}</p>
        </CardContent>
      </Card>

      {aims.map((aim, index) => (
        <ReviewAim
          key={aim.frame_id}
          aim={aim}
          index={index}
          form={form}
          onToggleExcluded={toggleExcluded}
          onSetMethod={setMethod}
          onSetLandmark={setLandmark}
          onSetSeverity={setSeverity}
          onSetTime={setTime}
        />
      ))}

      {!!draft.unanswered_frames?.length && (
        <Card>
          <CardHeader>
            <CardTitle>{modelDown ? t.modelDown : t.cannotAnalyse}</CardTitle>
            <p className="text-sm text-muted-foreground">{modelDown ? t.modelDownHint : t.cannotAnalyseHint}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {draft.unanswered_frames.map(({ frame, reasons }, index) => (
              <div key={index}>
                <p className="text-sm font-medium">{frame.sub_question}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                  {reasons.map((r, i) => (
                    <li key={i}>{r[lang]}</li>
                  ))}
                </ul>
                {(draft.clarifications ?? []).filter((c) => c.sub_question === frame.sub_question).map((c) => (
                  <div key={c.frame_id} className="mt-3 rounded-md border bg-muted/40 p-3">
                    <p className="text-sm font-medium">{t.readingTitle(c.text)}</p>
                    <p className="text-xs text-muted-foreground">{t.readingHint}</p>
                    <div className="mt-2 flex flex-col gap-2">
                      {c.options.map((option) => (
                        <div key={option.option_id} className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{option.label[lang]}</p>
                            <p className="truncate text-xs text-muted-foreground">{option.sub_question}</p>
                          </div>
                          <Button size="sm" disabled={startRun.isPending} onClick={() => startRun.mutate({ question: option.question }, { onSuccess: (run) => onStarted?.(run.id) })}>
                            {t.readingUse}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Nothing could be planned because the question was not read or is of a kind this version leaves out: offer the kinds it accepts. */}
      {offersQuestionKinds(draft) && onRewrite && (
        <Card>
          <CardContent className="pt-6">
            <QuestionKinds onPick={onRewrite} prompt={t.questionScope.pick} />
          </CardContent>
        </Card>
      )}

      {(draft.mapping_clarifications ?? []).filter((record) => !record.chosen).map((record) => (
        <Card key={`${record.frame_id}-${record.role}-${record.term}`}>
          <CardHeader>
            <CardTitle>{t.mappingTitle(record.term)}</CardTitle>
            <p className="text-sm text-muted-foreground">{record.candidate ? `${record.candidate} · ` : ""}{t.mappingHint}</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {record.options.map((option) => (
              <div key={option.option_id} className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2">
                <p className="text-sm">{option.label[lang]}</p>
                {option.option_id !== "stop" && (
                  <Button size="sm" disabled={startRun.isPending} onClick={async () => {
                    if (option.option_id === "define" && option.proposal) await api.saveVariable(option.proposal.definition);
                    startRun.mutate({ question: draft.question, ...(option.option_id === "broader" ? { accept: [`${record.role}|${record.term.toLowerCase()}`] } : {}) }, { onSuccess: (run) => onStarted?.(run.id) });
                  }}>{option.option_id === "define" ? t.mappingDefine : t.mappingBroader}</Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 shadow-lg">
        <div className="text-sm">
          <span className="font-medium">{t.willRun(runnable)}</span>
          {confirmPlan.isError && <p className="text-destructive">{t.error}: {(confirmPlan.error as Error).message}</p>}
        </div>
        <Button onClick={submit} disabled={!runnable || confirmPlan.isPending}>
          {t.confirmRun}
        </Button>
      </div>
    </div>
  );
}

interface AimProps {
  aim: Aim<DraftPlan>;
  index: number;
  form: FormState;
  onToggleExcluded: (planId: string, include: boolean) => void;
  onSetMethod: (frameId: string, methodId: string) => void;
  onSetLandmark: (frameId: string, on: boolean) => void;
  onSetSeverity: (frameId: string, names: string[]) => void;
  onSetTime: (frameId: string, patch: TimeChoice) => void;
}

function ReviewAim({ aim, index, form, onToggleExcluded, onSetMethod, onSetLandmark, onSetSeverity, onSetTime }: AimProps) {
  const { t, lang } = useLang();
  const ready = aim.items.filter((item) => item.status === "ready");
  const blocked = aim.items.filter((item) => item.status !== "ready");
  const first = aim.items[0];
  const frame = aim.frame;
  const warnings = warningsOf(first.protocol);
  const multi = aim.items.length > 1;
  const options = first.method_options || [];
  const sentence = planSentence(t, lang, multi ? { ...first.plan, exposure_level: undefined } : first.plan, frame);
  const designOptions = ready[0]?.design_options;
  const blockers = blocked.flatMap((item) => item.blocked_outcome?.blockers || []);

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-center gap-2">
          <Badge variant="accent">{t.aim} {index + 1}</Badge>
          <span className="text-sm text-muted-foreground">{studyTypeLabel(lang, frame?.study_type)}</span>
        </div>
        <p className="text-sm font-medium">{sentence}</p>

        {multi && (
          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.levels}</div>
            <div className="flex flex-wrap gap-1.5">
              {aim.items.map((item) =>
                item.status === "ready" ? (
                  <ChipCheckbox
                    key={item.plan.plan_id}
                    checked={!form.excluded.has(item.plan.plan_id)}
                    onChange={(checked) => onToggleExcluded(item.plan.plan_id, checked)}
                  >
                    {levelLabel(lang, frame, item.plan.exposure_level!)}
                  </ChipCheckbox>
                ) : (
                  <ChipCheckbox key={item.plan.plan_id} checked={false} title={t.notRunnable}>
                    {levelLabel(lang, frame, item.plan.exposure_level!)}
                  </ChipCheckbox>
                ),
              )}
            </div>
          </div>
        )}

        {ready.length > 0 && (options.length > 0 || designOptions) && <p className="text-xs text-muted-foreground">{t.questionScope.choices}</p>}

        {ready.length > 0 && options.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.method}</div>
            <SegmentedControl
              name={`method-${aim.frame_id}`}
              value={form.methods[aim.frame_id]}
              onChange={(value) => onSetMethod(aim.frame_id, value)}
              options={options.map((o, i) => ({
                value: o.method_id,
                label: (
                  <>
                    {o.label[lang]}
                    {i === 0 && <em className="ml-1 not-italic text-xs opacity-75">{t.recommended}</em>}
                  </>
                ),
              }))}
            />
            <p className="text-xs text-muted-foreground">
              {options.find((o) => o.method_id === form.methods[aim.frame_id])?.when_preferred[lang]}
            </p>
          </div>
        )}

        {ready.length > 0 && designOptions && (
          <DesignOptionsBlock
            frameId={aim.frame_id}
            options={designOptions}
            landmarkOn={form.landmark[aim.frame_id]}
            severityOn={form.severity[aim.frame_id] || []}
            onSetLandmark={onSetLandmark}
            onSetSeverity={onSetSeverity}
            time={form.time[aim.frame_id]}
            onSetTime={onSetTime}
          />
        )}

        {blocked.length > 0 && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm font-semibold text-destructive">
              {t.notRunnable}
              {multi ? `: ${blocked.map((item) => levelLabel(lang, frame, item.plan.exposure_level!)).join(", ")}` : ""}
            </p>
            <BlockerList blockers={blockers} />
          </div>
        )}

        {warnings.length > 0 && (
          <details className="rounded-md border border-warning/30 bg-warning/5 p-3">
            <summary className="flex cursor-pointer items-center gap-1.5 text-sm font-medium text-warning">
              <AlertTriangle className="h-4 w-4" /> {t.thingsToKnow(warnings.length)}
            </summary>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-foreground/80">
              {warnings.map((w, i) => (
                <li key={i}>{w.message[lang]}</li>
              ))}
            </ul>
          </details>
        )}

        <DetailsToggle>
          <ProtocolTable protocol={first.protocol} />
          <MappingTable mapping={first.mapping} />
          <AssumptionsList assumptions={first.plan.study_spec.assumptions} />
        </DetailsToggle>
      </CardContent>
    </Card>
  );
}
