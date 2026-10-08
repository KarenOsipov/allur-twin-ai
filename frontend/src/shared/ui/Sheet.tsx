import { clsx } from "clsx";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

export function Sheet({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCloseEvt = () => onClose();
    const onClick = (e: MouseEvent) => {
      if (e.target === d) d.close();
    };
    d.addEventListener("close", onCloseEvt);
    d.addEventListener("click", onClick);
    return () => {
      d.removeEventListener("close", onCloseEvt);
      d.removeEventListener("click", onClick);
    };
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={clsx(
        "m-0 mt-auto max-h-[92dvh] w-full max-w-none rounded-t-[26px] bg-panel p-0 text-ink shadow-[var(--shadow-float)] open:animate-[sheet-up_.24s_var(--ease-out)]",
        "sm:m-auto sm:max-w-[560px] sm:rounded-[26px]",
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[92dvh] flex-col">
          <header className="flex items-center justify-between gap-4 px-5 pt-4 pb-2">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button type="button" onClick={() => ref.current?.close()} className="grid size-10 place-items-center rounded-full text-ink-2 hover:bg-sunken" aria-label="Закрыть">
              <X className="size-5" />
            </button>
          </header>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}
