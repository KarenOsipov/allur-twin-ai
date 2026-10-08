import { clsx } from "clsx";
import type { CSSProperties, ReactNode } from "react";

export function Panel({
  title,
  hint,
  actions,
  children,
  className,
  bodyClass,
  id,
  tone = "light",
  i,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  id?: string;
  tone?: "light" | "deep";
  i?: number;
}) {
  return (
    <section
      id={id}
      className={clsx(tone === "deep" ? "panel-deep" : "panel", "rise flex min-w-0 flex-col", className)}
      style={i !== undefined ? ({ "--i": i } as CSSProperties) : undefined}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-6 pt-5">
          <div className="min-w-0">
            {title && <h2 className="text-[1.1875rem]">{title}</h2>}
            {hint && <p className={clsx("mt-1 max-w-[70ch] text-[0.8125rem]", tone === "deep" ? "text-deep-ink-2" : "text-ink-3")}>{hint}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx("min-w-0 flex-1 px-6 pt-4 pb-6", bodyClass)}>{children}</div>
    </section>
  );
}

export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[16px] border border-dashed border-line-strong bg-sunken px-5 py-6">
      <p className="font-semibold">{title}</p>
      {text && <p className="max-w-[60ch] text-sm text-ink-2">{text}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx("animate-pulse rounded-[var(--radius-block)] bg-white/60", className)} />;
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Не удалось загрузить данные";
  return (
    <div role="alert" className="rounded-[16px] bg-down-soft px-4 py-3 text-sm font-medium text-down">
      {message}
    </div>
  );
}
