import { clsx } from "clsx";
import { BrainCircuit } from "lucide-react";
import type { CSSProperties } from "react";
import { Link } from "react-router";

export interface TakeawayItem {
  tone: "ok" | "warn" | "bad";
  text: string;
}

const DOT = { ok: "bg-run", warn: "bg-blocked", bad: "bg-down" };

export function Takeaway({ items, question }: { items: TakeawayItem[]; question?: string }) {
  if (!items.length) return null;
  return (
    <section className="panel rise flex flex-col gap-3 p-5 md:flex-row md:items-center" style={{ "--i": 0 } as CSSProperties} aria-label="Главное">
      <span className="eyebrow shrink-0 md:w-20">Главное</span>
      <ul className="flex min-w-0 flex-1 flex-col gap-2 lg:flex-row lg:gap-6">
        {items.map((it) => (
          <li key={it.text} className="flex min-w-0 items-start gap-2 text-[0.9375rem] leading-snug">
            <span className={clsx("mt-[7px] size-2 shrink-0 rounded-full", DOT[it.tone])} aria-hidden />
            <span>{it.text}</span>
          </li>
        ))}
      </ul>
      {question && (
        <Link to="/app/ai" className="inline-flex h-9 shrink-0 items-center gap-2 self-start rounded-full bg-sunken px-4 text-sm font-semibold text-ink-2 hover:bg-brand-soft hover:text-brand md:self-center">
          <BrainCircuit className="size-4" aria-hidden /> Разобрать с ИИ
        </Link>
      )}
    </section>
  );
}
