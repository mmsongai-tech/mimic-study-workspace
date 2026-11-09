import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** A pill-style checkbox (multi-select inclusion / severity variables) — checked chips are filled, unchecked are outlined. */
export function ChipCheckbox({
  checked,
  onChange,
  children,
  title,
  disabled,
}: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  children: React.ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      disabled={disabled || !onChange}
      onClick={() => onChange?.(!checked)}
      className={cn(
        "flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm transition-colors",
        checked ? "border-primary/40 bg-primary/10 text-foreground" : "border-input bg-background text-muted-foreground",
        !onChange && "cursor-default",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {checked && <Check className="h-3.5 w-3.5 text-primary" />}
      {children}
    </button>
  );
}
