import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, ChevronDown, Copy, Factory, FilePlus2, FolderOpen, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { request } from "@/shared/api/client";
import { useLayouts } from "@/shared/api/queries";
import type { LayoutMeta } from "@/shared/api/types";
import { dateTime } from "@/shared/lib/format";
import { toast } from "@/shared/ui/Toaster";

export const TEMPLATES: { id: string; title: string; text: string }[] = [
  { id: "allur", title: "Аллюр · Костанай", text: "Текущий цех: сварка, окраска, сборка, контроль" },
  { id: "flex", title: "Гибкая линия", text: "Распределитель на две окраски, конвейер, доработка брака" },
  { id: "sub", title: "Завод с подсборками", text: "Кузов и двигатель собираются параллельно" },
  { id: "big4", title: "Завод: 4 линии", text: "~100 единиц оборудования" },
  { id: "big10", title: "Завод: 10 линий", text: "~260 единиц оборудования — проверка масштаба" },
  { id: "blank", title: "Пустой проект", text: "Склад → участок → склад ГП" },
];

export function ProjectMenu({
  name,
  savedId,
  canSave,
  dirty,
  onRename,
  onOpen,
  onTemplate,
  onSaveAs,
  onDeleted,
  floorId,
  isAdmin,
  onMakeFloor,
}: {
  name: string;
  savedId: number | null;
  canSave: boolean;
  dirty: boolean;
  onRename: (name: string) => void;
  onOpen: (id: number) => void;
  onTemplate: (id: string) => void;
  onSaveAs: () => void;
  onDeleted: (id: number) => void;
  floorId: number | null;
  isAdmin: boolean;
  onMakeFloor: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const layouts = useLayouts();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="relative min-w-0 flex-1" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-11 w-full min-w-0 items-center gap-2 rounded-[14px] px-2.5 text-left hover:bg-sunken"
      >
        <FolderOpen className="size-4 shrink-0 text-ink-3" aria-hidden />
        <span className="display min-w-0 truncate text-[1.2rem] font-medium">{name}</span>
        {dirty && <span className="size-2 shrink-0 rounded-full bg-brand" title="Есть несохранённые изменения" />}
        <ChevronDown className="size-4 shrink-0 text-ink-3" aria-hidden />
      </button>
      {open && (
        <div className="panel absolute top-12 left-0 z-50 w-[min(440px,calc(100vw-2rem))] animate-[fade-up_.18s_var(--ease-out)] p-2" role="dialog" aria-label="Проект">
          <Rename name={name} onRename={onRename} />
          <div className="my-2 h-px bg-line" />
          {(() => {
            const all = layouts.data ?? [];
            const main = all.find((l) => l.id === floorId);
            const drafts = all.filter((l) => l.id !== floorId);
            const row = (l: LayoutMeta) => (
              <Saved
                key={l.id}
                l={l}
                current={l.id === savedId}
                isFloor={l.id === floorId}
                canSave={canSave && (l.id !== floorId || isAdmin)}
                canMakeFloor={isAdmin && l.id !== floorId}
                onOpen={() => {
                  onOpen(l.id);
                  setOpen(false);
                }}
                onMakeFloor={() => {
                  onMakeFloor(l.id);
                  setOpen(false);
                }}
                onDeleted={() => onDeleted(l.id)}
              />
            );
            return (
              <>
                <h3 className="px-3 pt-1 pb-1.5 text-xs font-semibold text-ink-3">Схема цеха — её показывает страница «Цех»</h3>
                <ul>{main ? row(main) : <li className="px-3 py-2 text-sm text-ink-3">Стандартная линия «Аллюр». Откройте макет и нажмите «Сделать схемой цеха».</li>}</ul>
                <div className="my-2 h-px bg-line" />
                <h3 className="px-3 pt-1 pb-1.5 text-xs font-semibold text-ink-3">Макеты — черновики, цех их не видит</h3>
                <ul className="scroll-thin max-h-60 overflow-y-auto">
                  {drafts.map(row)}
                  {layouts.data && drafts.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">Макетов пока нет — начните с шаблона ниже.</li>}
                </ul>
              </>
            );
          })()}
          {canSave && (
            <button type="button" onClick={() => (onSaveAs(), setOpen(false))} className="mt-1 flex h-10 w-full items-center gap-2.5 rounded-[12px] px-3 text-sm font-semibold text-ink-2 hover:bg-sunken">
              <Copy className="size-4" aria-hidden /> Сохранить как новый макет
            </button>
          )}
          <div className="my-2 h-px bg-line" />
          <h3 className="px-3 pt-1 pb-1.5 text-xs font-semibold text-ink-3">Новый макет из шаблона</h3>
          <ul className="grid gap-0.5 sm:grid-cols-2">
            {TEMPLATES.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => {
                    onTemplate(t.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-start gap-2 rounded-[12px] px-3 py-2 text-left hover:bg-sunken"
                >
                  <FilePlus2 className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{t.title}</span>
                    <span className="block text-xs text-ink-3">{t.text}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Rename({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <form
      className="flex items-center gap-2 px-1 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onRename(v.trim());
      }}
    >
      <label className="min-w-0 flex-1">
        <span className="mb-1 block px-2 text-xs font-semibold text-ink-3">Название проекта</span>
        <input
          value={v}
          maxLength={120}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => v.trim() && v.trim() !== name && onRename(v.trim())}
          className="h-10 w-full rounded-[12px] border border-line-strong bg-sunken px-3 text-sm focus:border-accent focus:bg-panel focus:outline-none"
        />
      </label>
    </form>
  );
}

function Saved({
  l,
  current,
  isFloor,
  canSave,
  canMakeFloor,
  onOpen,
  onMakeFloor,
  onDeleted,
}: {
  l: LayoutMeta;
  current: boolean;
  isFloor: boolean;
  canSave: boolean;
  canMakeFloor: boolean;
  onOpen: () => void;
  onMakeFloor: () => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [name, setName] = useState(l.name);
  const refresh = () => qc.invalidateQueries({ queryKey: ["layouts"] });

  const rename = async () => {
    try {
      const full = await request<LayoutMeta & { data: unknown }>(`/layouts/${l.id}`);
      await request(`/layouts/${l.id}`, { method: "PUT", body: { name: name.trim(), data: full.data } });
      refresh();
      setMode("view");
      toast({ title: "Переименовано", body: name.trim(), tone: "run" });
    } catch (e) {
      toast({ title: "Не удалось переименовать", body: (e as Error).message, tone: "down" });
    }
  };
  const copy = async () => {
    try {
      const full = await request<LayoutMeta & { data: unknown }>(`/layouts/${l.id}`);
      await request("/layouts", { method: "POST", body: { name: `${l.name} (копия)`.slice(0, 120), data: full.data } });
      refresh();
      toast({ title: "Копия создана", tone: "run" });
    } catch (e) {
      toast({ title: "Не удалось скопировать", body: (e as Error).message, tone: "down" });
    }
  };
  const remove = async () => {
    try {
      await request(`/layouts/${l.id}`, { method: "DELETE" });
      refresh();
      onDeleted();
      toast({ title: "Проект удалён", body: l.name, tone: "run" });
    } catch (e) {
      toast({ title: "Не удалось удалить", body: (e as Error).message, tone: "down" });
    }
  };

  if (mode === "rename")
    return (
      <li className="flex items-center gap-1.5 px-2 py-1">
        <input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && rename()} className="h-9 min-w-0 flex-1 rounded-[10px] border border-accent bg-panel px-2.5 text-sm focus:outline-none" aria-label="Новое название" />
        <button type="button" onClick={rename} className="grid size-9 place-items-center rounded-full text-run hover:bg-run-soft" aria-label="Сохранить название">
          <Check className="size-4" />
        </button>
        <button type="button" onClick={() => setMode("view")} className="grid size-9 place-items-center rounded-full text-ink-3 hover:bg-sunken" aria-label="Отмена">
          <X className="size-4" />
        </button>
      </li>
    );
  if (mode === "delete")
    return (
      <li className="flex items-center gap-2 rounded-[12px] bg-down-soft px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate">Удалить «{l.name}»?</span>
        <button type="button" onClick={remove} className="h-8 rounded-full bg-down px-3 text-xs font-bold text-white">
          Удалить
        </button>
        <button type="button" onClick={() => setMode("view")} className="h-8 rounded-full px-3 text-xs font-semibold text-ink-2 hover:bg-white/60">
          Отмена
        </button>
      </li>
    );
  return (
    <li className={clsx("group flex items-center gap-1 rounded-[12px] pr-1", current ? "bg-brand-soft/60" : isFloor ? "bg-run-soft/60 hover:bg-run-soft" : "hover:bg-sunken")}>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 px-3 py-2 text-left">
        <span className="block truncate text-sm font-semibold">
          {isFloor && <Factory className="mr-1 inline size-3.5 -translate-y-px text-run" aria-label="Схема цеха" />}
          {l.name} {current && <span className="text-xs font-normal text-brand">· открыт</span>}
        </span>
        <span className="block truncate text-xs text-ink-3">
          {l.nodes} узлов · {l.equipment} ед. оборудования · {l.author} · {dateTime(l.updated_at)}
        </span>
      </button>
      {canMakeFloor && (
        <button
          type="button"
          title="Сделать схемой цеха — её покажет страница «Цех»"
          aria-label={`Сделать «${l.name}» схемой цеха`}
          onClick={onMakeFloor}
          className="h-8 shrink-0 rounded-full px-2.5 text-xs font-semibold text-run opacity-100 hover:bg-run-soft sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
        >
          В цех
        </button>
      )}
      {canSave && (
        <span className="flex opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <button type="button" title="Переименовать" aria-label={`Переименовать «${l.name}»`} onClick={() => setMode("rename")} className="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-panel hover:text-ink">
            <Pencil className="size-3.5" />
          </button>
          <button type="button" title="Сделать копию" aria-label={`Копия «${l.name}»`} onClick={copy} className="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-panel hover:text-ink">
            <Copy className="size-3.5" />
          </button>
          {!isFloor && <button type="button" title="Удалить" aria-label={`Удалить «${l.name}»`} onClick={() => setMode("delete")} className="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-down-soft hover:text-down">
            <Trash2 className="size-3.5" />
          </button>}
        </span>
      )}
    </li>
  );
}
