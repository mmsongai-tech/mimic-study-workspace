import * as React from "react";
import { Info } from "lucide-react";
import { useLang } from "@/hooks/use-lang";
import { EXPLANATIONS } from "@/lib/explanations";

/**
 * A small "why is this here" control: click to open a plain-language note under the section, number or check it
 * belongs to. Renders nothing when no explanation is registered for the id, so adding a new id never breaks a page.
 */
export function Explain({ id, label }: { id: string; label?: string }) {
  const { t, lang } = useLang();
  const colon = lang === "zh" ? "：" : ": ";
  const [open, setOpen] = React.useState(false);
  const entry = EXPLANATIONS[id];
  if (!entry) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded text-xs text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
        {label ?? t.whyThis}
      </button>
      {open && (
        <div role="note" className="mt-1.5 space-y-1.5 rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-foreground">
          <div className="font-semibold">{entry.title[lang]}</div>
          <p><b>{t.explainWhat}{colon}</b>{entry.what[lang]}</p>
          <p><b>{t.explainWhy}{colon}</b>{entry.why[lang]}</p>
          <p><b>{t.explainRead}{colon}</b>{entry.read[lang]}</p>
        </div>
      )}
    </div>
  );
}
