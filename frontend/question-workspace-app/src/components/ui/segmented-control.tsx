import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
}

/** A pill-style single-select control (method choice, follow-up start) — visually distinct from checkbox chips. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  name,
}: {
  value: T | undefined;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  name: string;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            value === option.value ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background text-foreground hover:bg-accent",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
