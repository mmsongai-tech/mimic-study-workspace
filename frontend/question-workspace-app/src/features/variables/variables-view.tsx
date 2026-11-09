import * as React from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Search, Trash2, XCircle } from "lucide-react";
import { useLang } from "@/hooks/use-lang";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { Aggregation, DefinitionReport, SearchHit, SearchKind, VariableDefinition } from "@/lib/variables-types";
import { useCheckVariable, useDeleteVariable, useSaveVariable, useVariableLists, useVariableSearch } from "./use-variables";
import { VARIABLES_TEXT } from "./variables-i18n";

type Mode = "measure" | "event" | "infusion";
const MEASURE_TABLES = new Set(["labevents", "chartevents"]);
const hitKey = (hit: SearchHit): string => hit.id !== undefined ? `${hit.table}:${hit.id}` : hit.code ? `${hit.code}|${hit.version}` : hit.label;
const slug = (text: string): string => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
const count = (value: number): string => value.toLocaleString("en-US");

const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <label className="block space-y-1">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    {children}
    {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
  </label>
);
const inputClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm placeholder:text-muted-foreground";

/** Builds the definition the form describes, or the reason it cannot yet be built. */
function buildDefinition(input: { kind: SearchKind; mode: Mode; selected: SearchHit[]; nameEn: string; nameZh: string; synonyms: string; meaning: string; aggregation: Aggregation; unit: string; min: string; max: string }): { definition?: VariableDefinition; problem?: "pick" | "table" } {
  const { selected } = input;
  if (!selected.length) return { problem: "pick" };
  const base = {
    schema_version: "1.0.0" as const, version: "1.0.0", status: "researcher_defined" as const,
    definition_id: slug(input.nameEn) || "variable", labels: { en: input.nameEn.trim(), ...(input.nameZh.trim() ? { zh: input.nameZh.trim() } : {}) },
    synonyms: input.synonyms.split(/[,，、]/u).map((value) => value.trim()).filter(Boolean), meaning: input.meaning.trim(),
  };
  if (input.kind === "drug") return { definition: { ...base, kind: "drug", drug: { prescription_labels: selected.map((hit) => hit.label) } } };
  if (input.kind === "diagnosis") return { definition: { ...base, kind: "diagnosis", diagnosis: { codes: selected.map((hit) => ({ code: hit.code!, version: hit.version! })) } } };
  const tables = new Set(selected.map((hit) => hit.table));
  if (tables.size > 1) return { problem: "table" };
  const table = selected[0]!.table as NonNullable<VariableDefinition["items"]>["table"]; const ids = selected.map((hit) => hit.id!);
  if (input.mode === "infusion") return table === "inputevents" ? { definition: { ...base, kind: "drug", drug: { input_item_ids: ids } } } : { problem: "table" };
  if (input.mode === "event") return { definition: { ...base, kind: "procedure_or_event", items: { table, item_ids: ids } } };
  if (!MEASURE_TABLES.has(table)) return { problem: "table" };
  const min = input.min.trim() === "" ? undefined : Number(input.min); const max = input.max.trim() === "" ? undefined : Number(input.max);
  return { definition: { ...base, kind: "lab_or_chart", items: { table, item_ids: ids, aggregation: input.aggregation, ...(input.unit.trim() ? { unit: input.unit.trim() } : {}), ...(min !== undefined || max !== undefined ? { valid_range: { ...(min !== undefined && Number.isFinite(min) ? { min } : {}), ...(max !== undefined && Number.isFinite(max) ? { max } : {}) } } : {}) } } };
}

function CheckList({ report, text }: { report: DefinitionReport; text: typeof VARIABLES_TEXT.zh | typeof VARIABLES_TEXT.en }) {
  return (
    <ul className="space-y-2" aria-live="polite">
      {report.checks.map((check, index) => {
        const Icon = check.level === "ok" ? CheckCircle2 : check.level === "warning" ? AlertTriangle : XCircle;
        return (
          <li key={index} className="flex gap-2.5 text-sm">
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", check.level === "ok" ? "text-success" : check.level === "warning" ? "text-warning" : "text-destructive")} />
            <div><span className="font-medium">{text.checkNames[check.check]}</span><span className="text-muted-foreground"> · {check.message}</span></div>
          </li>
        );
      })}
    </ul>
  );
}

/** The variables a blocked question still needs, shared by every step of the define-then-plan flow. */
export interface DefineFlow { terms: string[]; done: string[]; auto_run: boolean; onAutoRun: (value: boolean) => void; onSaved: (term: string) => void }

export function VariablesView({ initialTerm, onBack, onReplan, flow }: { initialTerm?: string | undefined; onBack?: (() => void) | undefined; onReplan?: (() => Promise<void>) | undefined; flow?: DefineFlow | undefined }) {
  const { lang } = useLang();
  const text = VARIABLES_TEXT[lang];
  const [kind, setKind] = React.useState<SearchKind>("item");
  const [query, setQuery] = React.useState(initialTerm ?? "");
  const [selected, setSelected] = React.useState<Map<string, SearchHit>>(new Map());
  const [mode, setMode] = React.useState<Mode>("measure");
  const [nameEn, setNameEn] = React.useState(initialTerm && /^[\x00-\x7f]+$/u.test(initialTerm) ? initialTerm : "");
  const [nameZh, setNameZh] = React.useState(""); const [synonyms, setSynonyms] = React.useState(""); const [meaning, setMeaning] = React.useState("");
  const [aggregation, setAggregation] = React.useState<Aggregation>("mean"); const [unit, setUnit] = React.useState(""); const [min, setMin] = React.useState(""); const [max, setMax] = React.useState("");
  const search = useVariableSearch(kind, query);
  const lists = useVariableLists();
  const check = useCheckVariable(); const save = useSaveVariable(); const remove = useDeleteVariable();
  const [saved, setSaved] = React.useState(false); const [replanning, setReplanning] = React.useState(false);

  const chosen = [...selected.values()];
  const built = buildDefinition({ kind, mode, selected: chosen, nameEn, nameZh, synonyms, meaning, aggregation, unit, min, max });
  const complete = Boolean(built.definition && nameEn.trim() && meaning.trim());
  // Any change to the form invalidates an earlier check and a "saved" notice.
  React.useEffect(() => { check.reset(); save.reset(); setSaved(false); }, [kind, mode, selected, nameEn, nameZh, synonyms, meaning, aggregation, unit, min, max]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (hit: SearchHit) => setSelected((current) => {
    const next = new Map(current); const key = hitKey(hit);
    if (next.has(key)) next.delete(key); else {
      next.set(key, hit);
      if (!nameEn.trim() && next.size === 1) setNameEn(hit.label.replace(/\s*\(.*?\)\s*/gu, " ").trim());
      if (!unit && hit.units?.[0]) setUnit(hit.units[0][0]);
    }
    return next;
  });
  const switchKind = (next: SearchKind) => { setKind(next); setSelected(new Map()); setMode(next === "item" ? "measure" : "event"); };
  const unavailable = search.error && /503|not available/iu.test(String(search.error));

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        {onBack && <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2"><ArrowLeft />{text.backToQuestion}</Button>}
        <h1 className="text-xl font-semibold tracking-tight">{initialTerm ? text.forTerm(initialTerm) : text.title}</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{text.intro}</p>
        {flow && flow.terms.length > 0 && (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <p className="text-sm font-medium">{text.flowTitle(flow.terms.length - flow.done.length)}</p>
            <div className="flex flex-wrap gap-1.5">
              {flow.terms.map((term) => (
                <Badge key={term} variant={flow.done.includes(term) ? "success" : term === initialTerm ? "default" : "secondary"} className="font-normal">{flow.done.includes(term) ? "✓ " : ""}{term}</Badge>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={flow.auto_run} onChange={(event) => flow.onAutoRun(event.target.checked)} />
              {text.flowAutoRun}
            </label>
          </div>
        )}
      </header>

      {unavailable && <Card className="border-warning/40"><CardContent className="p-4 text-sm text-warning">{text.unavailable}</CardContent></Card>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>{text.step1}</CardTitle>
            <SegmentedControl<SearchKind> name={text.step1} value={kind} onChange={switchKind} options={(["item", "drug", "diagnosis"] as const).map((value) => ({ value, label: text.kinds[value] }))} />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input className={cn(inputClass, "pl-9")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.searchPlaceholder[kind]} aria-label={text.step1} autoFocus />
            </div>
            <p className="text-xs text-muted-foreground">{text.searchHint}</p>
            <div className="max-h-[26rem] overflow-y-auto scrollbar-thin rounded-md border">
              {query.trim().length < 2 ? null : search.isLoading ? <div className="space-y-2 p-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
                : !search.data?.length ? <p className="p-4 text-sm text-muted-foreground">{text.noHits}</p>
                : <ul className="divide-y">{search.data.map((hit) => {
                  const key = hitKey(hit); const on = selected.has(key);
                  return (
                    <li key={key}>
                      <label className={cn("flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-accent/60", on && "bg-accent", hit.rows === 0 && "opacity-50")}>
                        <Checkbox checked={on} onCheckedChange={() => toggle(hit)} disabled={hit.rows === 0} className="mt-1" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-sm font-medium">{hit.code ? <code className="mr-1.5 rounded bg-muted px-1 text-xs">{hit.code} · ICD-{hit.version}</code> : null}{hit.label}</span>
                            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">{hit.table}</Badge>
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {count(hit.admissions)} {text.admissions} · {count(hit.rows)} {text.rows}
                            {hit.median !== undefined && <> · {text.median} {hit.median} ({text.inRange} {hit.p01}–{hit.p99}{hit.units?.[0] ? ` ${hit.units[0][0]}` : ""})</>}
                          </div>
                        </div>
                      </label>
                    </li>
                  );
                })}</ul>}
            </div>
            {chosen.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{text.selected(chosen.length)}</span>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setSelected(new Map())}>{text.clear}</Button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader className="pb-3"><CardTitle>{text.step2}</CardTitle>{built.problem === "pick" && <CardDescription>{text.pickFirst}</CardDescription>}{built.problem === "table" && <CardDescription className="text-warning">{text.needTable}</CardDescription>}</CardHeader>
            <CardContent className="space-y-3">
              {chosen.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label={text.selected(chosen.length)}>
                  {chosen.map((hit) => (
                    <li key={hitKey(hit)}>
                      <button type="button" onClick={() => toggle(hit)} title={hit.label} className="inline-flex max-w-[16rem] items-center gap-1 rounded-full border bg-accent px-2.5 py-1 text-xs text-accent-foreground transition-colors hover:bg-accent/60">
                        <span className="truncate">{hit.code ?? hit.label}</span><span aria-hidden className="text-muted-foreground">×</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {kind === "item" && (
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{text.whatIs}</span>
                  <SegmentedControl<Mode> name={text.whatIs} value={mode} onChange={setMode} options={[{ value: "measure", label: text.measure }, { value: "event", label: text.event }, { value: "infusion", label: text.infusion }]} />
                  <p className="text-xs text-muted-foreground">{mode === "measure" ? text.measureHelp : mode === "event" ? text.eventHelp : text.infusionHelp}</p>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={text.nameEn}><input className={inputClass} value={nameEn} onChange={(event) => setNameEn(event.target.value)} /></Field>
                <Field label={text.nameZh}><input className={inputClass} value={nameZh} onChange={(event) => setNameZh(event.target.value)} /></Field>
              </div>
              <Field label={text.synonyms}><input className={inputClass} value={synonyms} onChange={(event) => setSynonyms(event.target.value)} /></Field>
              <Field label={text.meaning}><Textarea rows={2} value={meaning} onChange={(event) => setMeaning(event.target.value)} /></Field>
              {kind === "item" && mode === "measure" && (
                <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
                  <Field label={text.aggregation}>
                    <select className={inputClass} value={aggregation} onChange={(event) => setAggregation(event.target.value as Aggregation)}>
                      {Object.entries(text.aggregations).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </Field>
                  <Field label={text.unitField}><input className={inputClass} value={unit} onChange={(event) => setUnit(event.target.value)} /></Field>
                  <Field label={text.rangeMin}><input className={inputClass} inputMode="decimal" value={min} onChange={(event) => setMin(event.target.value)} /></Field>
                  <Field label={text.rangeMax}><input className={inputClass} inputMode="decimal" value={max} onChange={(event) => setMax(event.target.value)} /></Field>
                </div>
              )}
              {built.definition && <p className="text-xs text-muted-foreground">{text.idLabel}: <code className="rounded bg-muted px-1">{built.definition.definition_id}</code></p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle>{text.step3}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={!complete || check.isPending} onClick={() => built.definition && check.mutate(built.definition)}>{check.isPending ? text.checking : text.check}</Button>
                <Button disabled={!complete || !check.data?.ok || save.isPending || saved} onClick={() => built.definition && save.mutate(built.definition, { onSuccess: () => { setSaved(true); if (flow && initialTerm) flow.onSaved(initialTerm); } })}>{save.isPending ? text.saving : text.save}</Button>
              </div>
              {check.data && (
                <div className="space-y-3">
                  <div className={cn("rounded-md border px-3 py-2 text-sm font-medium", check.data.ok ? "border-success/40 bg-success/10 text-success" : "border-destructive/40 bg-destructive/10 text-destructive")}>
                    {check.data.ok ? text.result.ok : text.result.error}{check.data.facts.rows > 0 && <span className="font-normal"> · {text.facts(count(check.data.facts.admissions), count(check.data.facts.rows))}</span>}
                  </div>
                  <CheckList report={check.data} text={text} />
                </div>
              )}
              {check.error && <p className="text-sm text-destructive">{String(check.error.message)}</p>}
              {save.error && <p className="text-sm text-destructive">{String(save.error.message)}</p>}
              {saved && <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">{text.saved}<div className="mt-1 text-xs text-muted-foreground">{text.reportNote}</div>{onReplan && <Button size="sm" className="mt-2" disabled={replanning} onClick={() => { setReplanning(true); void onReplan().finally(() => setReplanning(false)); }}>{replanning ? text.replanning : text.replan}</Button>}</div>}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {([["workspace", text.mine, true], ["shared", text.shared, false]] as const).map(([scope, title, deletable]) => (
          <Card key={scope}>
            <CardHeader className="pb-2"><CardTitle>{title}</CardTitle></CardHeader>
            <CardContent>
              {lists.isLoading ? <Skeleton className="h-16 w-full" /> : !lists.data?.[scope].length ? <p className="text-sm text-muted-foreground">{text.none}</p>
                : <ul className="divide-y">{lists.data[scope].map((definition) => (
                  <li key={definition.definition_id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{lang === "zh" && definition.labels.zh ? definition.labels.zh : definition.labels.en}</span><Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">{text.kindNames[definition.kind]}</Badge></div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{definition.meaning}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{text.status[definition.status]}</p>
                    </div>
                    {deletable && <Button variant="ghost" size="icon" aria-label={text.remove} onClick={() => { if (window.confirm(text.confirmRemove(definition.definition_id))) remove.mutate(definition.definition_id); }}><Trash2 /></Button>}
                  </li>
                ))}</ul>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
