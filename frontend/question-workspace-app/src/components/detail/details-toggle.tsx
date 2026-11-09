import * as React from "react";
import { useLang } from "@/hooks/use-lang";

export function DetailsToggle({ label, children }: { label?: string; children: React.ReactNode }) {
  const { t } = useLang();
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-sm font-medium text-primary hover:underline">
        {open ? t.hideDetails : label ?? t.details}
      </button>
      {open && <div className="mt-3 space-y-4">{children}</div>}
    </div>
  );
}
