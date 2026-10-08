import { clsx } from "clsx";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = "max-w-[520px]",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: string;
}) {
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
      aria-label={typeof title === "string" ? title : undefined}
      className={clsx(
        "fixed inset-y-2 right-2 left-auto m-0 h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] rounded-[var(--radius-block)] bg-panel p-0 text-ink shadow-[var(--shadow-float)]",
        "open:animate-[slide-in_.22s_var(--ease-out)]",
        width,
      )}
    >
      {open && (
        <div className="flex h-full flex-col">
          <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
            <div className="display min-w-0 text-lg font-medium">{title}</div>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="grid size-9 place-items-center rounded-full text-ink-2 hover:bg-sunken hover:text-ink"
              aria-label="Закрыть"
            >
              <X className="size-5" />
            </button>
          </header>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
        </div>
      )}
    </dialog>
  );
}
