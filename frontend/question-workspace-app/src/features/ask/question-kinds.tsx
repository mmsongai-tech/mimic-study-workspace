import { useLang } from "@/hooks/use-lang";
import { I18N } from "@/lib/i18n";
import type { ClarificationRecord, FrameAmbiguityCode, MappingClarificationRecord, StudyFrame } from "@/lib/api-types";

/** Every 【…】 blank of the formats, in both languages. */
const BLANKS = [...new Set(Object.values(I18N).flatMap((dict) => dict.questionScope.kinds.flatMap(([, format]) => format.match(/【[^】]*】/gu) ?? [])))];

/** A blank of a format the question still contains as offered (not yet replaced by the user's words). */
export const unfilledBlank = (question: string): string | undefined => BLANKS.find((blank) => question.includes(blank));

/** The 【】 markers are the format's blanks; once filled in, the words inside them are the question. */
export const withoutBlankMarkers = (question: string): string => question.replace(/[【】]/gu, "");

/** Why an aim stopped when rewriting the question in another kind's format cannot help: MIMIC-IV lacks the data, or the local model did not respond. */
const NOT_FIXED_BY_REWRITING: ReadonlySet<FrameAmbiguityCode> = new Set<FrameAmbiguityCode>(["NOT_IN_MIMIC", "MODEL_NOT_RESPONDING"]);

/**
 * Whether the plan or results page offers the kinds of question: only when nothing could be planned, no choice is waiting
 * (a reading of a vague outcome, a partly matched variable), and no unanswered aim stopped because MIMIC-IV lacks the data or
 * the local model did not respond. A question that was not read, is of a kind this version leaves out, or lacks a population
 * or a measurable outcome is helped by a format; a choice of reading, missing data or a silent model is not.
 */
export const offersQuestionKinds = (planned: {
  plans: readonly unknown[];
  unanswered_frames?: ReadonlyArray<{ frame: Pick<StudyFrame, "ambiguities"> }>;
  clarifications?: readonly ClarificationRecord[];
  mapping_clarifications?: readonly MappingClarificationRecord[];
}): boolean =>
  planned.plans.length === 0
  && !(planned.clarifications ?? []).some(({ chosen }) => !chosen)
  && !(planned.mapping_clarifications ?? []).some(({ chosen }) => !chosen)
  // An aim of a kind this version leaves out shows only that reason, so only that reason decides for it.
  && (planned.unanswered_frames ?? []).every(({ frame }) =>
    frame.ambiguities[0]?.code === "STUDY_TYPE_NOT_SUPPORTED" || !frame.ambiguities.some(({ code }) => NOT_FIXED_BY_REWRITING.has(code)));

/**
 * The kinds of question this version accepts, each with a fill-in format: clicking one hands its format to `onPick`.
 * Shown on the ask form, and as choices when a question could not be planned at all (`prompt` then replaces the title).
 */
export function QuestionKinds({ onPick, prompt }: { onPick: (format: string) => void; prompt?: string }) {
  const { t } = useLang();
  const scope = t.questionScope;
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{prompt ?? scope.title}</p>
        <p className="text-xs text-muted-foreground">{scope.hint}</p>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {scope.kinds.map(([name, format]) => (
          <button
            key={name}
            type="button"
            title={format}
            onClick={() => onPick(format)}
            className="rounded-md border bg-muted/30 px-2.5 py-1.5 text-left transition-colors hover:border-primary/40 hover:bg-accent"
          >
            <span className="block text-xs font-semibold">{name}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{format}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{scope.unsupported}</p>
    </div>
  );
}
