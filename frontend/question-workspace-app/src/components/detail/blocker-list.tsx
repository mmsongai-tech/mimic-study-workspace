import { useLang } from "@/hooks/use-lang";
import { Button } from "@/components/ui/button";
import { useDefineVariable } from "@/features/variables/define-context";
import type { PipelineBlocker } from "@/lib/api-types";

/** The first quoted name in a blocker message (“Dexmedetomidine use”), which is the variable the platform could not map. */
const quotedTerm = (message: string): string | undefined => /[“"]([^”"]{2,80})[”"]/u.exec(message)?.[1];

/** The variables a set of plans could not map, each once, in the order they were met. */
export const unmappedTermsOf = (blockers: PipelineBlocker[]): string[] => [...new Set(blockers.filter(({ code }) => code === "VARIABLE_UNMAPPED").map(({ message }) => quotedTerm(message.en)).filter((term): term is string => Boolean(term)))];

/**
 * The reasons a plan cannot run, as a list. A variable that could not be mapped offers "Define this variable", so the
 * researcher can add it from the dictionaries instead of waiting for a developer.
 */
export function BlockerList({ blockers, className }: { blockers: PipelineBlocker[]; className?: string }) {
  const { lang } = useLang();
  const define = useDefineVariable();
  const unique = [...new Map(blockers.map((blocker) => [blocker.message[lang], blocker])).values()];
  return (
    <ul className={className ?? "mt-1 list-disc space-y-1 pl-5 text-sm text-destructive/90"}>
      {unique.map((blocker, index) => {
        const term = blocker.code === "VARIABLE_UNMAPPED" ? quotedTerm(blocker.message.en) : undefined;
        return (
          <li key={index}>
            {blocker.message[lang]}
            {term && define && <Button variant="outline" size="sm" className="ml-2 h-6 px-2 text-xs" onClick={() => define(term)}>{lang === "zh" ? "定义这个变量" : "Define this variable"}</Button>}
          </li>
        );
      })}
    </ul>
  );
}
