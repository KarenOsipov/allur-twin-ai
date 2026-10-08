import { clsx } from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { type ChangeEvent, Children, Fragment, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, isValidElement, useEffect, useId, useMemo, useRef, useState } from "react";

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-[0.8125rem] font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

const control =
  "h-10 w-full min-w-0 rounded-[12px] border border-line-strong bg-sunken px-3.5 text-sm text-ink transition-colors placeholder:text-ink-3 hover:border-ink-3 focus:border-accent focus:bg-panel focus:outline-none";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(control, props.className)} />;
}

interface Opt {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function parseOptions(children: ReactNode, group?: string): Opt[] {
  const out: Opt[] = [];
  Children.forEach(children, (ch) => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; label?: string }>(ch)) return;
    if (ch.type === "optgroup") out.push(...parseOptions(ch.props.children, ch.props.label));
    else if (ch.type === "option") {
      const label = textOf(ch.props.children);
      out.push({ value: String(ch.props.value ?? label), label, disabled: ch.props.disabled, group });
    } else if (ch.type === Fragment) out.push(...parseOptions(ch.props.children, group));
  });
  return out;
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: "sm" | "md" };

export function Select({ children, value, onChange, disabled, className, size = "md", id, ...rest }: SelectProps) {
  const opts = useMemo(() => parseOptions(children), [children]);
  const current = String(value ?? "");
  const sel = opts.find((o) => o.value === current) ?? opts[0];
  const auto = useId();
  const listId = `${id ?? auto}-list`;
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean; max: number }>({ left: 0, top: 0, width: 0, up: false, max: 320 });
  const typed = useRef({ s: "", t: 0 });

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const want = Math.min(320, opts.length * 40 + 12);
    const up = below < Math.min(want, 200) && above > below;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 200) - 8)), top: up ? r.top - 4 : r.bottom + 4, width: r.width, up, max: Math.max(120, Math.min(320, up ? above : below)) });
  };

  const show = () => {
    if (disabled || !opts.length) return;
    place();
    setActive(Math.max(0, opts.findIndex((o) => o.value === current)));
    setOpen(true);
  };
  const hide = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const choose = (o: Opt) => {
    if (o.disabled) return;
    hide();
    if (o.value !== current) onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } } as unknown as ChangeEvent<HTMLSelectElement>);
  };

  useEffect(() => {
    const el = pop.current;
    if (!el) return;
    if (open) {
      try {
        el.showPopover();
      } catch {
      }
      el.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
      el.focus();
      const re = () => place();
      window.addEventListener("resize", re);
      window.addEventListener("scroll", re, true);
      return () => {
        window.removeEventListener("resize", re);
        window.removeEventListener("scroll", re, true);
      };
    }
    try {
      el.hidePopover();
    } catch {
    }
  }, [open]);

  useEffect(() => {
    pop.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const move = (d: number) => {
    let i = active;
    for (let k = 0; k < opts.length; k++) {
      i = (i + d + opts.length) % opts.length;
      if (!opts[i].disabled) break;
    }
    setActive(i);
  };
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
    else if (e.key === "Home") (e.preventDefault(), setActive(0));
    else if (e.key === "End") (e.preventDefault(), setActive(opts.length - 1));
    else if (e.key === "Enter" || e.key === " ") (e.preventDefault(), choose(opts[active]));
    else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), hide());
    else if (e.key === "Tab") hide(false);
    else if (e.key.length === 1) {
      const now = Date.now();
      typed.current = { s: (now - typed.current.t < 700 ? typed.current.s : "") + e.key.toLowerCase(), t: now };
      const i = opts.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.s));
      if (i >= 0) setActive(i);
    }
  };

  let lastGroup: string | undefined;
  return (
    <span className="relative block min-w-0">
      <button
        ref={btn}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={rest["aria-label"]}
        onClick={() => (open ? hide() : show())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
        className={clsx(
          control,
          "flex items-center justify-between gap-2 pr-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" && "h-8 rounded-[10px] px-2.5 text-xs",
          open && "border-accent bg-panel",
          className,
        )}
      >
        <span className="min-w-0 truncate">{sel?.label ?? "—"}</span>
        <ChevronDown aria-hidden className={clsx("size-4 shrink-0 text-ink-3 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <div
        ref={pop}
        id={listId}
        popover="auto"
        role="listbox"
        tabIndex={-1}
        aria-activedescendant={`${listId}-${active}`}
        onKeyDown={onListKey}
        onClick={(e) => e.preventDefault()}
        onToggle={(e) => {
          if ((e as unknown as { newState: string }).newState === "closed" && open) setOpen(false);
        }}
        style={{
          position: "fixed",
          margin: 0,
          left: pos.left,
          top: pos.up ? undefined : pos.top,
          bottom: pos.up ? window.innerHeight - pos.top : undefined,
          minWidth: Math.max(pos.width, 180),
          maxWidth: "calc(100vw - 16px)",
          maxHeight: pos.max,
        }}
        className="scroll-thin overflow-y-auto rounded-[14px] border border-line bg-panel p-1 text-sm text-ink shadow-[var(--shadow-float)] outline-none"
      >
        {open &&
          opts.map((o, i) => {
            const head = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            const on = o.value === current;
            return (
              <div key={`${o.group ?? ""}-${o.value}`}>
                {head && <div className="px-2.5 pt-2 pb-1 text-2xs font-bold tracking-wide text-ink-3 uppercase">{head}</div>}
                <div
                  id={`${listId}-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={on}
                  aria-disabled={o.disabled || undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o)}
                  className={clsx(
                    "flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-[10px] px-2.5 py-2",
                    i === active && "bg-sunken",
                    on && "font-semibold text-brand",
                    o.disabled && "cursor-not-allowed opacity-40",
                  )}
                >
                  <span className="min-w-0">{o.label}</span>
                  {on && <Check className="size-4 shrink-0" aria-hidden />}
                </div>
              </div>
            );
          })}
      </div>
    </span>
  );
}
