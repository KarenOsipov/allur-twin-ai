import { clsx } from "clsx";
import { X } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  title: ReactNode;
  body?: ReactNode;
  tone?: "neutral" | "run" | "blocked" | "down";
}

let items: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(t: Omit<Toast, "id">, ttl = 5000) {
  const id = ++seq;
  items = [...items.slice(-3), { ...t, id }];
  emit();
  window.setTimeout(() => dismiss(id), ttl);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

const BAR = {
  neutral: "bg-ink-3",
  run: "bg-run",
  blocked: "bg-blocked",
  down: "bg-down",
};

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
  );
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-[5.5rem] z-[70] sm:[body[data-chat=open]_&]:right-[26.5rem] sm:[body[data-chat=open]_&]:bottom-4 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto relative flex animate-[fade-up_.2s_var(--ease-out)] items-start gap-3 overflow-hidden rounded-[16px] border border-line bg-panel py-3 pr-2 pl-4 shadow-[var(--shadow-float)]"
        >
          <span aria-hidden className={clsx("absolute inset-y-0 left-0 w-1", BAR[t.tone ?? "neutral"])} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t.title}</div>
            {t.body && <div className="mt-0.5 text-[0.8125rem] text-ink-2">{t.body}</div>}
          </div>
          <button type="button" onClick={() => dismiss(t.id)} className="grid size-7 place-items-center rounded text-ink-3 hover:text-ink" aria-label="Закрыть уведомление">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
