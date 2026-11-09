import * as React from "react";
import { X } from "lucide-react";
import { useLang } from "@/hooks/use-lang";
import { useDeleteRun, useStartRun } from "@/hooks/use-runs";
import { EXAMPLES } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { QuestionKinds, unfilledBlank, withoutBlankMarkers } from "./question-kinds";

interface AskViewProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  closable: boolean;
  onStarted: (id: string) => void;
  /** A question being edited: its text pre-fills the form; when `replaces` is set the original is deleted on submit. */
  editing?: { id: string; question: string; replaces: boolean };
  onEditDone?: () => void;
  /** Focus the question box when the form opens (off on the cover, where it would scroll the page to the form). */
  autoFocus?: boolean;
}

export function AskView({ open, onOpen, onClose, closable, onStarted, editing, onEditDone, autoFocus = true }: AskViewProps) {
  const { t, lang } = useLang();
  const [question, setQuestion] = React.useState("");
  const [autoConfirm, setAutoConfirm] = React.useState(false);
  const startRun = useStartRun();
  const deleteRun = useDeleteRun();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (open && autoFocus) textareaRef.current?.focus();
  }, [open, autoFocus]);
  React.useEffect(() => {
    if (!editing) return;
    setQuestion(editing.question);
    textareaRef.current?.focus();
  }, [editing]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 rounded-md border border-dashed px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
      >
        {t.newQuestion}
      </button>
    );
  }

  // A format put into the box still has blanks until the user replaces them.
  const blank = unfilledBlank(question);
  const pick = (format: string) => {
    // Text the user already typed is replaced only when they agree.
    if (question.trim() && question !== format && !window.confirm(t.questionScope.replaceAsk)) return;
    setQuestion(format);
    textareaRef.current?.focus();
  };

  const submit = () => {
    const trimmed = withoutBlankMarkers(question.trim()).trim();
    if (!trimmed || blank) return;
    startRun.mutate(
      { question: trimmed, auto_confirm: autoConfirm },
      {
        onSuccess: (record) => {
          setQuestion("");
          // The edited question is replaced only after the new one was accepted, so a failed submit never loses it.
          if (editing?.replaces) deleteRun.mutate(editing.id);
          onEditDone?.();
          onStarted(record.id);
        },
      },
    );
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-start justify-between gap-2">
          <label htmlFor="question" className="text-sm font-medium">
            {t.askLabel}
          </label>
          {closable && (
            <button type="button" onClick={onClose} aria-label="close" className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Textarea
          id="question"
          ref={textareaRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t.askPlaceholder}
          className="min-h-28"
        />
        {blank && <p className="text-xs text-warning">{t.questionScope.blankLeft}</p>}
        <p className="text-xs text-muted-foreground">{t.askHint}</p>
        {editing && <p className="text-xs text-primary">{editing.replaces ? t.editingReplaces : t.editingCopy}</p>}

        <QuestionKinds onPick={pick} />

        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES[lang].map((example, index) => (
            <button
              key={index}
              type="button"
              title={example}
              onClick={() => setQuestion(example)}
              className="max-w-full truncate rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Q{index + 1} · {example}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={autoConfirm} onCheckedChange={(v) => setAutoConfirm(v === true)} />
          {t.autoConfirm}
        </label>

        {startRun.isError && <p className="text-sm text-destructive">{t.error}: {(startRun.error as Error).message}</p>}

        <Button onClick={submit} disabled={!question.trim() || Boolean(blank) || startRun.isPending}>
          {t.run}
        </Button>
      </CardContent>
    </Card>
  );
}
