import { clsx } from "clsx";
import {
  AlertTriangle,
  BrainCircuit,
  Database,
  FileDown,
  FileSpreadsheet,
  FlaskConical,
  KeyRound,
  Network,
  Search,
  Server,
  SlidersHorizontal,
  Sparkles,
  Sun,
  UserCog,
  X,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { initials } from "@/features/auth/LoginPage";
import { download } from "@/shared/api/client";
import { type JournalFilter, useJournal, useShiftHistory, useStaff } from "@/shared/api/queries";
import type { JournalEntry, Role, ShiftSession } from "@/shared/api/types";
import { exportState } from "@/shared/export/ExportButton";
import { kzt, num } from "@/shared/lib/format";
import { Button } from "@/shared/ui/Button";
import { Input, Select } from "@/shared/ui/Field";
import { Empty, ErrorNote, Skeleton } from "@/shared/ui/Panel";
import { toast } from "@/shared/ui/Toaster";

const CAT: Record<string, { icon: ReactNode; cls: string }> = {
  auth: { icon: <KeyRound className="size-3.5" />, cls: "bg-[#efe9f8] text-[#5b3fb0]" },
  control: { icon: <SlidersHorizontal className="size-3.5" />, cls: "bg-brand-soft text-brand" },
  incident: { icon: <AlertTriangle className="size-3.5" />, cls: "bg-down-soft text-down" },
  shift: { icon: <Sun className="size-3.5" />, cls: "bg-run-soft text-run" },
  simulation: { icon: <Sparkles className="size-3.5" />, cls: "bg-deep text-white" },
  scenario: { icon: <FlaskConical className="size-3.5" />, cls: "bg-sunken text-ink-2" },
  data: { icon: <Database className="size-3.5" />, cls: "bg-[#e6f0fb] text-[#225a96]" },
  assistant: { icon: <BrainCircuit className="size-3.5" />, cls: "bg-[#fbeee6] text-[#9a4a12]" },
  export: { icon: <FileDown className="size-3.5" />, cls: "bg-sunken text-ink-2" },
  builder: { icon: <Network className="size-3.5" />, cls: "bg-[#e7f5f1] text-[#16725a]" },
  users: { icon: <UserCog className="size-3.5" />, cls: "bg-[#efe9f8] text-[#5b3fb0]" },
  system: { icon: <Server className="size-3.5" />, cls: "bg-sunken text-ink-3" },
};
const AVATAR: Record<Role, string> = { director: "bg-deep text-white", admin: "bg-ink-2 text-white", supervisor: "bg-brand text-white", worker: "bg-floor text-ink" };

const PERIODS = [
  { value: "today", label: "Сегодня" },
  { value: "7", label: "7 дней" },
  { value: "30", label: "30 дней" },
  { value: "", label: "Всё время" },
];

const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
};

function sinceOf(period: string): string | undefined {
  if (!period) return undefined;
  const d = new Date();
  if (period === "today") d.setHours(0, 0, 0, 0);
  else d.setDate(d.getDate() - Number(period));
  return iso(d);
}

export function JournalPage() {
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState("");
  const [actor, setActor] = useState("");
  const [period, setPeriod] = useState("7");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(150);
  const [shift, setShift] = useState<ShiftSession | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    exportState.category = category || undefined;
  }, [category]);

  const filter: JournalFilter = useMemo(
    () => ({
      category: category || undefined,
      severity: severity || undefined,
      actor: actor || undefined,
      q: q || undefined,
      since: shift ? shift.started_at.slice(0, 19) : sinceOf(period),
      until: shift ? (shift.closed_at ?? undefined)?.slice(0, 19) : undefined,
    }),
    [category, severity, actor, q, period, shift],
  );
  const j = useJournal(filter, limit);
  const d = j.data;

  const exportAs = (fmt: "xlsx" | "csv") =>
    download(`/journal/export.${fmt}`, `allur_journal.${fmt}`, { ...filter }).catch((e: Error) => toast({ title: "Не удалось выгрузить", body: e.message, tone: "down" }));

  return (
    <div className="flex flex-col gap-4">
      <Shifts active={shift} onPick={(s) => setShift((cur) => (cur?.id === s.id ? null : s))} />

      <section className="panel rise flex flex-col gap-3 p-4 sm:p-5" style={{ "--i": 1 } as CSSProperties} aria-label="Фильтры">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="relative min-w-[200px] flex-1">
            <span className="sr-only">Поиск</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Поиск: Камера-02, смена, документ…" className="pl-9" />
          </label>
          {shift ? (
            <button type="button" onClick={() => setShift(null)} className="inline-flex h-10 items-center gap-2 rounded-[12px] bg-ink px-3.5 text-sm font-semibold text-white">
              Смена {shift.shift}, {new Date(shift.day).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} <X className="size-4" aria-hidden />
            </button>
          ) : (
            <label className="w-[150px]">
              <span className="sr-only">Период</span>
              <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
                {PERIODS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <label className="w-[170px]">
            <span className="sr-only">Важность</span>
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">Любая важность</option>
              <option value="critical">Только важные</option>
              <option value="warning">Внимание</option>
              <option value="info">Информация</option>
            </Select>
          </label>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" icon={<FileSpreadsheet className="size-4" />} onClick={() => exportAs("xlsx")}>
              Excel
            </Button>
            <Button size="sm" variant="ghost" onClick={() => exportAs("csv")}>
              CSV
            </Button>
          </div>
        </div>
        <People actors={d?.actors ?? []} active={actor} onPick={setActor} />
        <div className="scroll-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label="Раздел">
          <Chip active={!category} onClick={() => setCategory("")} label="Все события" count={d ? Object.values(d.counts).reduce((a, b) => a + b, 0) : undefined} />
          {d &&
            Object.entries(d.categories).map(([k, name]) => (
              <Chip key={k} active={category === k} onClick={() => setCategory(k)} label={name} count={d.counts[k]} icon={CAT[k]?.icon} />
            ))}
        </div>
      </section>

      <section className="panel rise overflow-hidden" style={{ "--i": 2 } as CSSProperties}>
        {j.error ? (
          <div className="p-5">
            <ErrorNote error={j.error} />
          </div>
        ) : !d ? (
          <div className="p-5">
            <Skeleton className="h-96" />
          </div>
        ) : d.items.length === 0 ? (
          <div className="p-5">
            <Empty title="Ничего не найдено" text="Измените фильтры или период — события появляются здесь сразу, как только что-то происходит." />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line bg-sunken/70 px-5 py-2.5 text-[0.8125rem] text-ink-2">
              <span>
                По фильтру: <b className="num">{num(d.total)}</b>
              </span>
              <span>
                Сегодня: <b className="num">{num(d.today)}</b>
              </span>
              <span className={clsx(d.today_important > 0 && "text-down")}>
                Важных сегодня: <b className="num">{num(d.today_important)}</b>
              </span>
            </div>
            <Timeline items={d.items} />
            {d.items.length < d.total && (
              <div className="flex justify-center border-t border-line p-4">
                <Button onClick={() => setLimit((l) => Math.min(l + 150, 500))} disabled={limit >= 500}>
                  {limit >= 500 ? "Остальное — в выгрузке Excel" : `Показать ещё (${num(d.total - d.items.length)})`}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function Shifts({ active, onPick }: { active: ShiftSession | null; onPick: (s: ShiftSession) => void }) {
  const h = useShiftHistory();
  const list = (h.data ?? []).slice(0, 10);
  if (h.isLoading) return <Skeleton className="h-36" />;
  if (!list.length) return null;
  return (
    <section className="rise" style={{ "--i": 0 } as CSSProperties} aria-label="Смены">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="text-[1.1rem]">Смены</h2>
        <span className="text-xs text-ink-3">нажмите на смену — лента покажет только её</span>
      </div>
      <div className="scroll-thin -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
        {list.map((s) => {
          const fin = s.summary.finished ?? 0;
          const plan = s.summary.plan ?? s.plan;
          const open = !s.closed_at;
          const share = Math.min(1, fin / Math.max(plan, 1));
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={active?.id === s.id}
              onClick={() => onPick(s)}
              className={clsx(
                "panel flex w-[230px] shrink-0 snap-start flex-col gap-2 px-4 py-3.5 text-left transition-[box-shadow,transform] hover:-translate-y-0.5",
                active?.id === s.id && "ring-2 ring-brand",
              )}
            >
              <div className="flex items-center justify-between gap-2 text-xs text-ink-3">
                <span className="num">
                  {new Date(s.day).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", weekday: "short" })} · смена {s.shift}
                </span>
                {open && <span className="rounded-full bg-run-soft px-2 py-0.5 font-semibold text-run">идёт</span>}
              </div>
              <div className="truncate text-sm font-semibold">{s.supervisor}</div>
              {open ? (
                <div className="text-xs text-ink-3">принял в {new Date(s.started_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</div>
              ) : (
                <>
                  <div className="flex items-baseline gap-1.5">
                    <span className={clsx("display num text-[1.5rem] leading-none font-light", fin < plan * 0.95 ? "text-down" : "text-ink")}>{fin}</span>
                    <span className="text-xs text-ink-3">из {plan}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-floor">
                    <div className={clsx("h-full rounded-full", fin < plan * 0.95 ? "bg-down" : "bg-run")} style={{ width: `${share * 100}%` }} />
                  </div>
                  <div className="text-xs text-ink-3">
                    {s.summary.incidents ?? 0} пробл. · {s.summary.reports ?? 0} с участков{(s.summary.cost_kzt ?? 0) > 0 && ` · ${kzt(s.summary.cost_kzt)}`}
                  </div>
                </>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function People({ actors, active, onPick }: { actors: string[]; active: string; onPick: (a: string) => void }) {
  const staff = useStaff();
  const role = new Map((staff.data?.users ?? []).map((u) => [u.name, u.role]));
  const people = actors.filter((a) => a !== "Система");
  if (!people.length) return null;
  return (
    <div className="scroll-thin -mx-1 flex gap-1.5 overflow-x-auto px-1" role="radiogroup" aria-label="Кто">
      <Chip active={!active} onClick={() => onPick("")} label="Все люди" />
      {people.map((a) => {
        const r = role.get(a) as Role | undefined;
        return (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={active === a}
            onClick={() => onPick(active === a ? "" : a)}
            className={clsx("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-1 text-[0.8125rem] font-semibold", active === a ? "bg-ink text-white" : "bg-sunken text-ink-2 hover:text-ink")}
          >
            <span className={clsx("display grid size-6 place-items-center rounded-full text-[0.65rem]", r ? AVATAR[r] : "bg-floor")}>{initials(a)}</span>
            {a}
          </button>
        );
      })}
    </div>
  );
}

function Chip({ active, onClick, label, count, icon }: { active: boolean; onClick: () => void; label: string; count?: number; icon?: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={clsx(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-semibold whitespace-nowrap transition-colors",
        active ? "bg-ink text-white" : "bg-sunken text-ink-2 hover:text-ink",
      )}
    >
      {icon}
      {label}
      {count != null && <span className={clsx("num text-xs", active ? "text-white/60" : "text-ink-3")}>{num(count)}</span>}
    </button>
  );
}

function dayTitle(d: Date): string {
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Сегодня";
  if (d.toDateString() === y.toDateString()) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "long" });
}

function Timeline({ items }: { items: JournalEntry[] }) {
  const staff = useStaff();
  const role = new Map((staff.data?.users ?? []).map((u) => [u.name, u.role]));
  const groups: { day: string; title: string; items: JournalEntry[] }[] = [];
  for (const e of items) {
    const d = new Date(e.at);
    const key = d.toDateString();
    const last = groups[groups.length - 1];
    if (last?.day === key) last.items.push(e);
    else groups.push({ day: key, title: dayTitle(d), items: [e] });
  }
  return (
    <div>
      {groups.map((g) => (
        <section key={g.day}>
          <h3 className="sticky top-0 z-10 border-b border-line bg-panel/95 px-5 py-2 text-[0.8125rem] font-semibold text-ink-2 backdrop-blur first-letter:uppercase">
            {g.title} <span className="font-normal text-ink-3">· {g.items.length}</span>
          </h3>
          <ol className="relative">
            {g.items.map((e) => (
              <Row key={e.id} e={e} role={role.get(e.actor) as Role | undefined} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Row({ e, role }: { e: JournalEntry; role?: Role }) {
  const cat = CAT[e.category] ?? CAT.system;
  const details = Object.entries(e.details).filter(([k]) => k !== "Инцидент");
  const system = e.actor === "Система";
  return (
    <li className={clsx("grid grid-cols-[3.2rem_2rem_minmax(0,1fr)] gap-x-3 px-5 py-3 sm:grid-cols-[3.6rem_2.25rem_minmax(0,1fr)_auto]", e.severity === "critical" && "bg-down-soft/40")}>
      <span className="num pt-1.5 text-[0.8125rem] font-semibold text-ink-2">{new Date(e.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
      <span
        className={clsx("display grid size-8 place-items-center rounded-full text-[0.7rem] font-medium sm:size-9", system ? cat.cls : role ? AVATAR[role] : "bg-floor text-ink")}
        title={e.actor}
        aria-hidden
      >
        {system ? cat.icon : initials(e.actor)}
      </span>
      <div className="min-w-0">
        <p className="text-sm">
          <span className="font-semibold">{system ? "Система" : e.actor}</span>
          <span className="text-ink-3"> · </span>
          <span className={clsx(e.severity === "critical" ? "font-semibold text-down" : e.severity === "warning" ? "text-ink" : "text-ink-2")}>{e.title}</span>
        </p>
        {details.length > 0 && (
          <dl className="mt-1 flex flex-wrap gap-1.5 text-xs">
            {details.slice(0, 6).map(([k, v]) => (
              <div key={k} className="max-w-full truncate rounded-full bg-sunken px-2 py-0.5 text-ink-3">
                <dt className="inline">{k === "ip" ? "IP" : k}: </dt>
                <dd className="inline font-medium text-ink-2">{typeof v === "boolean" ? (v ? "да" : "нет") : String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <span className={clsx("col-start-3 mt-1 inline-flex h-6 w-fit items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold sm:col-start-auto sm:mt-1", cat.cls)}>
        {cat.icon}
        {e.category_name}
      </span>
    </li>
  );
}
