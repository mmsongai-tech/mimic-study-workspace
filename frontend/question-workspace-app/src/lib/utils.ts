import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Standard shadcn/ui class-name merge helper: clsx for conditionals, tailwind-merge to resolve conflicting utilities. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "–";
  return Math.abs(value) >= 1000 ? Number(value).toFixed(0) : Number(value).toPrecision(3);
}

export function formatPValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "–";
  return value < 0.001 ? "<0.001" : Number(value).toFixed(3);
}

export function formatCount(value: number): string {
  return value > 0 && value < 10 ? "<10" : value.toLocaleString("en-US");
}
