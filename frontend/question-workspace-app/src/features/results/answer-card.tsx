import { useLang } from "@/hooks/use-lang";
import { estimateText, INFORMATIONAL_CHECKS, levelLabel, mainEstimate, mediationText, notReliablyEstimable, planDirection, planHeadline, planSentence, sparseEstimate } from "@/lib/domain";
import { formatCount, formatNumber, formatPValue } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Explain } from "@/components/detail/explain";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChecksPanel } from "./checks-panel";
import { FlowPanel } from "./flow-panel";
import { Table1Panel } from "./table1-panel";
import { FiguresPanel } from "./figures-panel";
import { DesignPanel } from "./design-panel";
import type { DesignOptions, PlanOptionChoice, PlanOutcome, StudyFrame, StudyMethodEstimate } from "@/lib/api-types";
import type { Dict, Lang } from "@/lib/i18n";

export function TrustBadge({ quality }: { quality: PlanOutcome["quality"] }) {
  const { t } = useLang();
  // The report says "(not checked)" for a result without checks; the page says the same instead of showing nothing.
  if (!quality) return <Badge variant="secondary">{t.trustNone}</Badge>;
  const warned = quality.checks.filter((c) => c.status === "warn" && !INFORMATIONAL_CHECKS.includes(c.check_id));
  const notes = quality.checks.filter((c) => c.status === "warn" && INFORMATIONAL_CHECKS.includes(c.check_id)).map((c) => c.title.en).join(", ");
  if (quality.status === "fail") return <Badge variant="destructive">✗ {t.trustFail}</Badge>;
  if (warned.length) return <Badge variant="warning">⚠ {t.trustWarn(warned.length)}</Badge>;
  return <Badge variant="success" title={notes || undefined}>✓ {t.trustPass}</Badge>;
}

/** The headline of a completed analysis, shared by the results summary and the answer card. */
export function headlineOf(t: Dict, lang: Lang, plan: PlanOutcome): string {
  if (!plan.result) return "–";
  // A degenerate model, or a group or event count below the minimum, is not an estimate, so it is never the headline.
  if (notReliablyEstimable(plan)) return t.notEstimable;
  const headline = planHeadline(plan);
  // A description answers with how many patients it describes; its proportions and means are listed under the headline.
  if (headline.kind === "description") return t.described(formatCount(plan.cohort?.rows ?? plan.result.n_input));
  if (headline.kind === "prediction") return headline.auc ? estimateText(lang, formatNumber, headline.auc).replace(/^AUC/u, t.testSetAuc) : t.noEstimate;
  if (headline.kind === "modification") return `${t.interactionP} ${formatPValue(headline.p_interaction)}`;
  if (!headline.estimate) return t.noEstimate;
  return ["test_statistic", "logrank_chisq"].includes(headline.estimate.measure) ? `P ${formatPValue(headline.estimate.p_value)}` : estimateText(lang, formatNumber, headline.estimate);
}

function groupLine(row: StudyMethodEstimate) {
  if (row.measure === "proportion") {
    return `${row.label}: ${(Number(row.estimate) * 100).toFixed(1)}% (${(Number(row.ci_low) * 100).toFixed(1)}–${(Number(row.ci_high) * 100).toFixed(1)})`;
  }
  return `${row.label}: ${formatNumber(row.estimate)} (${formatNumber(row.ci_low)}–${formatNumber(row.ci_high)})`;
}

export function AnswerCard({
  runId,
  plan,
  frame,
  selectedMethod,
  onChangeMethod,
  designOptions,
  optionChoice,
  onSetOption,
}: {
  runId: string;
  plan: PlanOutcome;
  frame: StudyFrame | undefined;
  selectedMethod: string;
  onChangeMethod: (methodId: string) => void;
  designOptions?: DesignOptions;
  optionChoice?: PlanOptionChoice;
  onSetOption: (patch: Partial<PlanOptionChoice>) => void;
}) {
  const { t, lang } = useLang();
  const run = plan.result;

  if (plan.status !== "completed" || !run) {
    return (
      <div className="rounded-md border border-dashed p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{plan.exposure_level ? levelLabel(lang, frame, plan.exposure_level) : planSentence(t, lang, plan, frame)}</span>
          <Badge variant={plan.status === "failed" ? "destructive" : "secondary"}>{t[plan.status as "blocked" | "failed"] ?? plan.status}</Badge>
        </div>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
          {plan.blockers.map((b, i) => (
            <li key={i}>{b.message[lang]}</li>
          ))}
        </ul>
      </div>
    );
  }

  const main = mainEstimate(run);
  const interaction = run.diagnostics?.p_interaction as number | undefined;
  const mediated = run.estimates.find((r) => r.measure === "proportion_mediated");
  const headed = planHeadline(plan);
  // A description lists every proportion and mean it reports (whole cohort and each group); other analyses list their group rates.
  const groups = headed.kind === "description" ? run.estimates.filter((r) => r.measure !== "test_statistic") : run.estimates.filter((r) => String(r.term).startsWith("group:"));
  const unreliable = notReliablyEstimable(plan);
  const headline = headlineOf(t, lang, plan);
  const dir = planDirection(t, plan, frame);

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xl font-semibold">{headline}</span>
        <TrustBadge quality={plan.quality} />
      </div>

      {unreliable && sparseEstimate(run) && (
        <p className="text-sm text-muted-foreground">{t.firthLine}: <b className="text-foreground">{estimateText(lang, formatNumber, sparseEstimate(run))}</b> · {t.firthNote}</p>
      )}

      {groups.length > 0 && (
        <div className="space-y-0.5 text-sm">
          {groups.map((row, i) => (
            <div key={i}>{groupLine(row)}</div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
        {dir && <b className="text-foreground">{dir}</b>}
        {dir && " · "}
        {/* An effect-modification headline is the interaction test; the estimate under it is one subgroup's, named by its label. */}
        {headed.kind === "modification" && main && !unreliable ? `${main.label}: ${estimateText(lang, formatNumber, main)}`
          : headed.kind === "prediction" ? (headed.baseline ? `${t.baselineAuc} ${formatNumber(headed.baseline.estimate)}` : "")
          : headed.kind === "description" ? ""
          : main?.label}
        {mediated && !unreliable && ` · ${mediationText(t, formatNumber, run)}`}
        {" · "}
        {t.analysed(formatCount(run.n_analysed))}
      </div>

      {plan.quality?.checks.some((check) => check.check_id === "outcome_timing") && (
        <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">{t.associationOnly}</p>
      )}
      <div className="flex flex-wrap gap-x-4">
        {main && <Explain id={main.measure} />}
        {interaction !== undefined && <Explain id="p_interaction" />}
        {mediated && <Explain id="proportion_mediated" />}
        <Explain id={selectedMethod} label={t.whyMethod} />
      </div>

      {plan.method_note && (
        <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">{plan.method_note[lang]}</p>
      )}
      {(plan.design_notes || []).map((note, i) => (
        <p key={i} className="text-xs text-muted-foreground">{note[lang]}</p>
      ))}

      <Tabs defaultValue="checks">
        <TabsList>
          <TabsTrigger value="checks">{t.tabs.checks}</TabsTrigger>
          <TabsTrigger value="patients">{t.tabs.patients}</TabsTrigger>
          <TabsTrigger value="table1">{t.tabs.table1}</TabsTrigger>
          <TabsTrigger value="figures">{t.tabs.figures}</TabsTrigger>
          <TabsTrigger value="design">{t.tabs.design}</TabsTrigger>
        </TabsList>
        <TabsContent value="checks"><ChecksPanel quality={plan.quality} /></TabsContent>
        <TabsContent value="patients"><FlowPanel plan={plan} /></TabsContent>
        <TabsContent value="table1"><Table1Panel run={run} /></TabsContent>
        <TabsContent value="figures"><FiguresPanel runId={runId} run={run} /></TabsContent>
        <TabsContent value="design">
          <DesignPanel
            plan={plan}
            selectedMethod={selectedMethod}
            onChangeMethod={onChangeMethod}
            designOptions={designOptions}
            optionChoice={optionChoice}
            onSetOption={onSetOption}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
