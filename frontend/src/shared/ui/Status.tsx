import { clsx } from "clsx";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import type { Status } from "@/shared/api/types";

const ICON = { ok: CircleCheck, warning: TriangleAlert, critical: CircleAlert };
const TONE = {
  ok: "text-run bg-run-soft",
  warning: "text-blocked bg-blocked-soft",
  critical: "text-down bg-down-soft",
};
const LABEL = { ok: "В норме", warning: "У границы", critical: "Нарушение" };

export function StatusPill({ status, label, className }: { status: Status; label?: string; className?: string }) {
  const Icon = ICON[status];
  return (
    <span className={clsx("inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap", TONE[status], className)}>
      <Icon className="size-3.5" aria-hidden />
      {label ?? LABEL[status]}
    </span>
  );
}

export function Dot({ color, pulse, className }: { color: string; pulse?: boolean; className?: string }) {
  return (
    <span className={clsx("relative inline-block size-2 shrink-0 rounded-full", className)} style={{ background: color }}>
      {pulse && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full"
          style={{ background: color, animation: "pulse-ring 1.6s var(--ease-out) infinite" }}
        />
      )}
    </span>
  );
}

export function Meter({ value, max, mark, tone = "accent", className }: { value: number; max: number; mark?: number; tone?: "accent" | "run" | "blocked" | "down"; className?: string }) {
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  const color = { accent: "var(--color-accent)", run: "var(--color-run)", blocked: "var(--color-blocked)", down: "var(--color-down)" }[tone];
  return (
    <div className={clsx("relative h-1.5 rounded-full bg-floor", className)}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${w}%`, background: color }} />
      {mark !== undefined && (
        <span aria-hidden className="absolute -top-1 h-3.5 w-0.5 rounded-full bg-ink" style={{ left: `calc(${Math.min(100, (mark / max) * 100)}% - 1px)` }} />
      )}
    </div>
  );
}
