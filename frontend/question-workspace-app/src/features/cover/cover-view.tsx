import { ArrowRight, FlaskConical, Languages } from "lucide-react";
import { useLang } from "@/hooks/use-lang";
import { useRunList } from "@/hooks/use-runs";
import { AskView } from "@/features/ask/ask-view";

interface CoverViewProps {
  /** A question was submitted from the cover: the workspace opens on that run. */
  onStarted: (id: string) => void;
  /** Open the workspace without a new question (to read earlier runs or define variables). */
  onEnter: () => void;
}

/** The first page: what the platform does, what it cannot do, its limits, and the question form that leads into planning. */
export function CoverView({ onStarted, onEnter }: CoverViewProps) {
  const { t, toggle } = useLang();
  const { data: runs } = useRunList();
  const cover = t.cover;
  const count = runs?.length ?? 0;

  return (
    <div className="h-screen w-screen overflow-y-auto bg-background text-foreground scrollbar-thin">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex items-center justify-between gap-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{cover.kicker}</p>
          <button
            type="button"
            onClick={toggle}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-label={t.switchLang}
          >
            <Languages className="h-3.5 w-3.5" />
            {t.switchLang}
          </button>
        </header>

        <section className="mt-8">
          <h1 className="flex items-center gap-2 text-2xl font-semibold leading-snug">
            <FlaskConical className="h-6 w-6 text-primary" />
            {t.title}
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{cover.lead}</p>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">{cover.howTitle}</h2>
          <ol className="mt-3 divide-y rounded-lg border bg-card">
            {cover.how.map(([step, text], index) => (
              <li key={step} className="flex gap-4 px-4 py-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium text-muted-foreground">{index + 1}</span>
                <div>
                  <div className="text-sm font-medium">{step}</div>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="text-sm font-semibold">{cover.canTitle}</h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
              {cover.can.map((item) => <li key={item}>{item}</li>)}
            </ul>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t.questionScope.unsupported}</p>
          </div>
          <div>
            <h2 className="text-sm font-semibold">{cover.cannotTitle}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{cover.cannot}</p>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-semibold">{cover.limitsTitle}</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
            {cover.limits.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>

        <section className="mt-10 space-y-3">
          <h2 className="text-sm font-semibold">{cover.startTitle}</h2>
          <AskView open autoFocus={false} onOpen={() => undefined} onClose={() => undefined} closable={false} onStarted={onStarted} />
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <button type="button" onClick={onEnter} className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
              {count ? cover.enter(count) : cover.enterEmpty}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
            <a href="/how-it-works.html" target="_blank" rel="noreferrer" className="text-muted-foreground underline-offset-4 hover:underline">{t.accessHow}</a>
          </div>
        </section>
      </div>
    </div>
  );
}
