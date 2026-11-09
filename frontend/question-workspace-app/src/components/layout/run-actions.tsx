import { Ban, Pencil, Trash2 } from "lucide-react";
import { useLang } from "@/hooks/use-lang";
import { useCancelRun, useDeleteRun } from "@/hooks/use-runs";
import { Button } from "@/components/ui/button";
import type { QuestionRunRecord } from "@/lib/api-types";

/** A run can be deleted or edited unless it is executing; one still waiting in the queue can also be given up. */
export const isInProgress = (record: Pick<QuestionRunRecord, "status" | "source">): boolean => record.status === "drafting" || record.status === "running";
export const isReadOnly = (record: Pick<QuestionRunRecord, "source">): boolean => record.source === "command_line";
/** Editing replaces a run that never produced results; for a finished run the edit starts a copy and keeps the results. */
export const editReplaces = (record: Pick<QuestionRunRecord, "status">): boolean => record.status !== "completed";

interface RunActionsProps {
  record: Pick<QuestionRunRecord, "id" | "question" | "status" | "source">;
  onEdit: (record: { id: string; question: string; replaces: boolean }) => void;
  onDeleted: (id: string) => void;
}

export function RunActions({ record, onEdit, onDeleted }: RunActionsProps) {
  const { t } = useLang();
  const deleteRun = useDeleteRun();
  const cancelRun = useCancelRun();
  if (isReadOnly(record)) return null;
  const busy = isInProgress(record);
  const error = (deleteRun.error ?? cancelRun.error) as Error | null;

  const remove = () => {
    if (!window.confirm(t.confirmDelete(record.question))) return;
    deleteRun.mutate(record.id, { onSuccess: () => onDeleted(record.id) });
  };
  const cancel = () => {
    if (!window.confirm(t.confirmCancel)) return;
    cancelRun.mutate(record.id);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {record.status === "queued" && (
          <Button type="button" size="sm" variant="outline" onClick={cancel} disabled={cancelRun.isPending}>
            <Ban className="h-3.5 w-3.5" />{t.cancelRun}
          </Button>
        )}
        {!busy && (
          <Button type="button" size="sm" variant="outline" onClick={() => onEdit({ id: record.id, question: record.question, replaces: editReplaces(record) })}>
            <Pencil className="h-3.5 w-3.5" />{editReplaces(record) ? t.editQuestion : t.copyQuestion}
          </Button>
        )}
        {!busy && (
          <Button type="button" size="sm" variant="outline" onClick={remove} disabled={deleteRun.isPending} className="text-destructive hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />{t.deleteRun}
          </Button>
        )}
        {busy && <span className="text-xs text-muted-foreground">{t.inProgressHint}</span>}
      </div>
      {error && <p className="text-xs text-destructive">{t.error}: {error.message}</p>}
    </div>
  );
}
