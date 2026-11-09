import { Badge } from "@/components/ui/badge";
import { useLang } from "@/hooks/use-lang";
import type { RunStatus } from "@/lib/api-types";

const VARIANT: Record<RunStatus, "secondary" | "warning" | "default" | "success" | "destructive"> = {
  queued: "secondary",
  drafting: "secondary",
  awaiting_confirmation: "warning",
  running: "default",
  completed: "success",
  failed: "destructive",
  cancelled: "secondary",
};

export function StatusBadge({ status, stalled, noResult }: { status: RunStatus; stalled?: boolean; noResult?: boolean }) {
  const { t } = useLang();
  if (stalled) return <Badge variant="destructive">{t.stalled}</Badge>;
  // The pipeline finished, but if every aim was blocked, calling that "completed" reads as success when it
  // isn't — use the same "blocked" wording already shown per-aim in this exact run, instead of the word
  // "completed" at all.
  if (status === "completed" && noResult) return <Badge variant="warning">{t.blocked}</Badge>;
  return <Badge variant={VARIANT[status]}>{t[status]}</Badge>;
}
