import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLang } from "@/hooks/use-lang";
import { stepIndex } from "@/lib/domain";
import type { QuestionRunRecord } from "@/lib/api-types";

interface StepRailProps {
  record: QuestionRunRecord;
  /** When set, steps 1–3 (not the question step, which has nothing more to show) become clickable, letting the
   * reader jump back to an earlier stage's read-only detail without re-running anything. */
  onSelect?: (index: number) => void;
  selected?: number;
}

export function StepRail({ record, onSelect, selected }: StepRailProps) {
  const { t } = useLang();
  const current = stepIndex(record);
  const failed = record.status === "failed" || record.live?.stalled;
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-sm">
      {t.steps.map((label, index) => {
        const done = index < current || (index === 3 && record.status === "completed");
        const active = index === current;
        const clickable = Boolean(onSelect) && index > 0 && (done || active);
        const isSelected = selected === index;
        const dot = (
          <span
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-shadow",
              done ? "bg-success text-success-foreground" : active ? (failed ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground") : "bg-muted text-muted-foreground",
              isSelected && "ring-2 ring-offset-2 ring-offset-background ring-accent",
            )}
          >
            {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
          </span>
        );
        return (
          <li key={label} className="flex items-center gap-2">
            {clickable ? (
              <button
                type="button"
                onClick={() => onSelect!(index)}
                className="flex items-center gap-2 rounded-full transition-opacity hover:opacity-80"
              >
                {dot}
                <span className={cn(isSelected ? "font-semibold text-foreground" : "font-medium text-foreground", "underline decoration-dotted underline-offset-4")}>{label}</span>
              </button>
            ) : (
              <>
                {dot}
                <span className={cn(done || active ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
              </>
            )}
            {index < t.steps.length - 1 && <span className="mx-1 h-px w-6 bg-border sm:w-10" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
