import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { StaffFull } from "@/shared/api/types";
import { clsx } from "clsx";
import {
  BadgeCheck,
  Banknote,
  BrainCircuit,
  ClipboardList,
  ChevronDown,
  ClipboardCheck,
  Database,
  Factory,
  FileDown,
  FileText,
  MessageSquareText,
  Gauge,
  HardHat,
  LogOut,
  type LucideIcon,
  Menu,
  Pause,
  Play,
  ScrollText,
  Siren,
  Sparkles,
  TrendingUp,
  Undo2,
  Users,
  Workflow,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { DbBanner } from "@/features/data/DbPanel";
import { AlertStrip, ImpactDrawer } from "@/features/incidents/ImpactDrawer";
import { download } from "@/shared/api/client";
import { fetchSandbox, useChatChannels, useFloorControl, useIncidents, useShift, useShiftActions } from "@/shared/api/queries";
import { can, session, useSession } from "@/shared/auth/session";
import { Button } from "@/shared/ui/Button";
import { Field, Input } from "@/shared/ui/Field";
import { Sheet } from "@/shared/ui/Sheet";
import { ExportButton } from "@/shared/export/ExportButton";
import { request } from "@/shared/api/client";
import { time } from "@/shared/lib/format";
import { ChatDock } from "@/shared/chat/ChatDock";
import { FullReportButton, FullReportSheet } from "@/shared/export/FullReport";
import { chatBus, useChatState } from "@/shared/chat/bus";
import { connectLive, disconnectLive, useFloor, useLiveStatus } from "@/shared/realtime/live";
import { IconButton } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { Logo } from "@/shared/ui/Logo";
import { Dot } from "@/shared/ui/Status";
import { onSimChange, sim, useSim } from "@/shared/sim/store";
import { toast } from "@/shared/ui/Toaster";

interface NavItem {
  to: string;
  end?: boolean;
  label: string;
  title: string;
  lead: string;
  page: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { to: "/app", end: true, label: "Цех", title: "Цех сейчас", lead: "Живая линия, показатели смены и прогноз до её конца", page: "floor", icon: Factory },
  { to: "/app/shift", label: "Смена", title: "Смена", lead: "Приёмка и сдача смены, люди по участкам, готовность, передача и настройка смен", page: "shift", icon: ClipboardList },
  { to: "/app/kpi", label: "Показатели", title: "Показатели", lead: "OEE, план, брак и простои против целей заказчика", page: "kpi", icon: Gauge },
  { to: "/app/quality", label: "Качество", title: "Качество", lead: "Брак по участкам и причины, найденные в данных", page: "quality", icon: BadgeCheck },
  { to: "/app/forecast", label: "Прогноз", title: "Прогноз и риски", lead: "Что сделать в первую очередь и что случится дальше", page: "forecast", icon: TrendingUp },
  { to: "/app/sim", label: "Симуляция", title: "Симуляция", lead: "Что будет со сменой, если сейчас что-то случится, — и что даст решение завтра", page: "sim", icon: Sparkles },
  { to: "/app/builder", label: "Конструктор", title: "Конструктор линий", lead: "Соберите производство любого масштаба из узлов и запустите его в живой симуляции", page: "builder", icon: Workflow },
  { to: "/app/incidents", label: "Инциденты", title: "Инциденты", lead: "Аварии и отклонения: кто принял, сколько стоили", page: "incidents", icon: Siren },
  { to: "/app/economics", label: "Экономика", title: "Экономика производства", lead: "Доход, затраты и потери завода в тенге — и сколько вернёт их устранение", page: "economics", icon: Banknote },
  { to: "/app/journal", label: "Журнал", title: "История действий", lead: "Кто, что и когда сделал на производстве: смены, сообщения с участков, решения, выгрузки", page: "journal", icon: ScrollText },
  { to: "/app/data", label: "Данные", title: "Данные и параметры", lead: "Параметры каждого участка и станка, ввод данных в любом виде, проверка введённого", page: "data", icon: Database },
];
const STAFF: NavItem = { to: "/app/staff", label: "Сотрудники", title: "Сотрудники", lead: "Кто входит в систему, роли, участки и PIN-коды", page: "staff", icon: Users };
const AI: NavItem = { to: "/app/ai", label: "ИИ-анализ", title: "ИИ-анализ", lead: "Разбор ситуации, риски и ответы на вопросы — по данным двойника", page: "ai", icon: BrainCircuit };

export function AppShell() {
  const qc = useQueryClient();
  const location = useLocation();
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const simState = useSim();
  const content = useRef<HTMLDivElement>(null);
  const current = [...NAV, AI, STAFF].find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to))) ?? NAV[0];
  const simFloor = simState.result && current.to === "/app";

  useEffect(() => {
    connectLive(qc);
    return () => disconnectLive();
  }, [qc]);

  useEffect(() => {
    onSimChange(() => {
      for (const k of ["overview", "insights", "incidents", "suggestions", "ai-report"]) qc.removeQueries({ queryKey: [k] });
    });
    const stored = sim.storedId();
    if (stored && !sim.get().result) {
      fetchSandbox(stored)
        .then((r) => sim.enter(r, { autoplay: false }))
        .catch(() => sim.exit());
    }
  }, [qc]);

  useEffect(() => {
    setMenu(false);
  }, [location.pathname]);

  return (
    <div className="min-h-dvh">
      <div aria-hidden className="ambient" />
      <header className="sticky top-0 z-40 px-3 pt-3 sm:px-5">
        <div className="glass-bar mx-auto max-w-[1600px] rounded-[26px] p-1.5">
          <div className="flex h-12 items-center gap-2 pr-1 pl-3.5">
            <Link to="/app" aria-label="На главную — цех" className="mr-1 flex shrink-0 items-center gap-3 rounded-full py-1 pr-2 text-ink">
              <Logo />
            </Link>
            <span className="hidden h-6 w-px bg-line-strong md:block" aria-hidden />
            <span className="hidden items-center gap-2 truncate text-[0.8125rem] font-semibold text-ink-3 md:flex">
              <span className="size-1.5 rounded-full bg-brand" aria-hidden />
              Сборочный завод · Костанай
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <MyAreaLink />
              <ShiftPill />
              <FullReportButton className="hidden xl:inline-flex" />
              <NavLink
                to={AI.to}
                aria-label="ИИ-анализ"
                className={({ isActive }) =>
                  clsx(
                    "hidden h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-[background,box-shadow,transform] duration-200 active:scale-[0.98] md:inline-flex",
                    isActive ? "bg-deep text-white" : "bg-brand text-white shadow-[0_8px_20px_-10px_rgb(227_36_27/0.9)] hover:bg-brand-2",
                  )
                }
              >
                <BrainCircuit className="size-4" aria-hidden />
                <span className="hidden sm:inline">ИИ-анализ</span>
              </NavLink>
              <UserButton />
              <IconButton label="Разделы" className="hidden md:inline-grid lg:hidden" onClick={() => setMenu(true)}>
                <Menu className="size-5" />
              </IconButton>
            </div>
          </div>
          <nav aria-label="Разделы" className="scroll-thin mt-1 hidden gap-1 overflow-x-auto rounded-[20px] bg-sunken/80 p-1 lg:flex">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  clsx(
                    "group relative flex h-9 shrink-0 items-center gap-2 rounded-[14px] px-3 text-[0.84rem] font-semibold whitespace-nowrap transition-[background,color,box-shadow] duration-200 xl:flex-1 xl:justify-center",
                    isActive ? "bg-panel text-ink shadow-[0_2px_10px_-4px_rgb(60_16_14/0.25)]" : "text-ink-3 hover:bg-white/70 hover:text-ink",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <n.icon className={clsx("size-4 transition-colors", isActive ? "text-brand" : "text-ink-3 group-hover:text-ink-2")} aria-hidden />
                    {n.label}
                    {n.to === "/app/incidents" && <IncidentCount />}
                    {isActive && <span className="absolute inset-x-5 -bottom-0.5 h-[3px] rounded-full bg-brand" aria-hidden />}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      {simState.result && <SimBanner />}
      <DbBanner />
      <AlertStrip />
      <ImpactDrawer />
      <ChatDock hideLauncherOnPhone />

      <main className="mx-auto w-full max-w-[1600px] px-3 pt-5 pb-28 sm:px-5 sm:pt-7 md:pb-16">
        <div key={current.to} className="rise mb-5 flex flex-wrap items-end justify-between gap-3 px-1 sm:mb-6 sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-[clamp(1.75rem,3.4vw,2.75rem)] leading-tight font-light tracking-[-0.025em]">{simFloor ? "Цех в симуляции" : current.title}</h1>
            <p className="mt-1.5 text-[0.95rem] text-ink-3">{simFloor ? "Повтор смены при введённых событиях и сравнение с «как было бы без них»" : current.lead}</p>
          </div>
          <ExportButton page={current.page} title={simFloor ? "Цех в симуляции" : current.title} target={content} />
        </div>
        <div ref={content}>
          <Outlet />
        </div>
      </main>

      <MobileNav onMore={() => setMenu(true)} />
      <FullReportSheet open={report} onClose={() => setReport(false)} />

      <Drawer open={menu} onClose={() => setMenu(false)} title="Разделы" width="max-w-[340px]">
        <div className="px-4 pt-4">
          <button
            type="button"
            onClick={() => {
              setMenu(false);
              setReport(true);
            }}
            className="flex h-12 w-full items-center gap-3 rounded-[14px] bg-deep px-4 font-semibold text-white"
          >
            <FileText className="size-4 text-brand-2" aria-hidden /> Общий анализ (PDF)
          </button>
        </div>
        <nav aria-label="Разделы" className="flex flex-col gap-1 p-4">
          {[...NAV, AI].map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                clsx("flex h-12 items-center gap-3 rounded-[14px] px-4 font-semibold", isActive ? "bg-brand text-white" : "text-ink-2 hover:bg-sunken")
              }
            >
              <n.icon className="size-4" aria-hidden />
              {n.label}
              {n.to === "/app/incidents" && <IncidentCount />}
            </NavLink>
          ))}
        </nav>
      </Drawer>
    </div>
  );
}

function MobileNav({ onMore }: { onMore: () => void }) {
  const chat = useChatChannels();
  const unread = (chat.data ?? []).reduce((n, c) => n + c.unread, 0);
  const st = useChatState();
  const item = "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[16px] py-1.5 text-[0.68rem] font-semibold transition-colors";
  const tab = (to: string, label: string, Icon: typeof Factory, end = false, badge?: ReactNode) => (
    <NavLink to={to} end={end} className={({ isActive }) => clsx(item, isActive && !st.open ? "bg-brand-soft text-brand" : "text-ink-3 active:bg-sunken")}>
      <Icon className="size-[22px]" aria-hidden />
      <span className="truncate">{label}</span>
      {badge}
    </NavLink>
  );
  return (
    <nav aria-label="Главное меню" className="fixed inset-x-0 bottom-0 z-40 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
      <div className="mx-auto flex max-w-[520px] items-stretch gap-1 rounded-[22px] bg-panel/95 p-1.5 shadow-[var(--shadow-float)] ring-1 ring-line backdrop-blur-xl">
        {tab("/app", "Цех", Factory, true)}
        {tab("/app/shift", "Смена", ClipboardList)}
        {tab("/app/incidents", "Инциденты", Siren, false, <MobileBadge kind="incidents" />)}
        <button type="button" onClick={() => chatBus.open()} className={clsx(item, st.open ? "bg-brand-soft text-brand" : "text-ink-3 active:bg-sunken")}>
          <MessageSquareText className="size-[22px]" aria-hidden />
          <span>Чат</span>
          {unread > 0 && <span className="num absolute top-0.5 right-[calc(50%-1.4rem)] grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-1 text-[0.62rem] font-bold text-white ring-2 ring-white">{unread > 99 ? "99+" : unread}</span>}
        </button>
        <button type="button" onClick={onMore} className={clsx(item, "text-ink-3 active:bg-sunken")}>
          <Menu className="size-[22px]" aria-hidden />
          <span>Ещё</span>
        </button>
      </div>
    </nav>
  );
}

function MobileBadge({ kind }: { kind: "incidents" }) {
  const q = useIncidents("active", "");
  const n = kind === "incidents" ? (q.data?.active ?? 0) : 0;
  if (!n) return null;
  return <span className="num absolute top-0.5 right-[calc(50%-1.4rem)] grid h-[18px] min-w-[18px] place-items-center rounded-full bg-down px-1 text-[0.62rem] font-bold text-white ring-2 ring-white">{n}</span>;
}

function IncidentCount() {
  const q = useIncidents("active", "");
  const n = q.data?.active ?? 0;
  if (!n) return null;
  return <span className="num ml-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-down px-1.5 text-2xs font-bold text-white ring-2 ring-white">{n}</span>;
}

function UserButton() {
  const me = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const logout = () => {
    request("/auth/logout", { method: "POST" }).catch(() => undefined);
    sim.exit();
    chatBus.close();
    chatBus.select(null);
    session.clear({ logout: true });
    qc.clear();
    navigate("/login", { replace: true, state: null });
  };
  const initials = (me?.name ?? "··")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
  const item = "flex h-10 w-full items-center gap-2.5 rounded-[12px] px-3 text-sm font-semibold text-ink-2 hover:bg-sunken hover:text-ink";
  const users = useQuery({ queryKey: ["users"], queryFn: () => request<StaffFull[]>("/users"), enabled: can(me, "manage_users"), staleTime: 60_000 });
  const pending = (users.data ?? []).filter((u) => u.status === "pending").length;
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Профиль: ${me?.name ?? ""}`}
        className="display relative grid size-10 place-items-center rounded-full bg-deep text-sm font-medium text-white"
      >
        {initials}
        {pending > 0 && <span className="absolute -top-0.5 -right-0.5 size-3 rounded-full bg-blocked ring-2 ring-white" aria-label="Есть заявки на доступ" />}
      </button>
      {open && (
        <div className="panel absolute top-12 right-0 z-50 w-72 animate-[fade-up_.18s_var(--ease-out)] p-2" role="menu">
          <div className="px-3 py-2">
            <div className="font-semibold">{me?.name}</div>
            <div className="text-xs text-ink-3">{me?.position} · АО «Группа компаний АЛЛЮР»</div>
          </div>
          <div className="my-1 h-px bg-line" />
          {can(me, "report") && (
            <Link to="/work" role="menuitem" className={item}>
              <HardHat className="size-4" aria-hidden /> Экран участка
            </Link>
          )}
          {can(me, "manage_users") && (
            <Link to="/app/staff" role="menuitem" className={item} onClick={() => setOpen(false)}>
              <Users className="size-4" aria-hidden /> Сотрудники и доступ
              {pending > 0 && <span className="num ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-blocked px-1.5 text-2xs font-bold text-white">{pending}</span>}
            </Link>
          )}
          <button type="button" role="menuitem" onClick={logout} className={item}>
            <LogOut className="size-4" aria-hidden /> Выйти
          </button>
        </div>
      )}
    </div>
  );
}

function SimBanner() {
  const s = useSim();
  const r = s.result;
  const location = useLocation();
  if (!r) return null;
  const frame = r.frames[Math.floor(s.playhead)];
  const onFloor = location.pathname === "/app";
  if (onFloor) return null;
  return (
    <div className="sticky top-[76px] z-30 lg:top-[128px] mx-auto mt-3 max-w-[1600px] px-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[18px] bg-deep px-4 py-2.5 text-white shadow-[var(--shadow-float)]">
        <span className="inline-flex items-center gap-2 text-sm font-bold">
          <Sparkles className="size-4 text-brand-2" aria-hidden /> Режим симуляции
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-white/75">
          {r.actions.map((a) => a.title).join(" · ")} — цифры на этой странице посчитаны так, будто смена прошла по симуляции (до {time(r.end)})
        </span>
        {frame && (
          <Link to="/app" className="text-sm font-semibold text-white underline-offset-4 hover:underline">
            Смотреть повтор
          </Link>
        )}
        <button
          type="button"
          onClick={() => {
            sim.exit();
            toast({ title: "Вы вернулись в реальное время", body: "Все разделы снова показывают живой завод.", tone: "run" });
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-[0.8125rem] font-semibold text-ink hover:bg-white/90"
        >
          <Undo2 className="size-3.5" aria-hidden /> В реальное время
        </button>
      </div>
    </div>
  );
}

const SPEEDS = [1, 20, 60];

function ShiftPill() {
  const floor = useFloor();
  const status = useLiveStatus();
  const shift = useShift();
  const me = useSession();
  const s = useSim();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (s.result) {
    const frame = s.result.frames[Math.floor(s.playhead)];
    return (
      <div className="hidden h-10 items-center gap-2 rounded-full bg-deep pr-4 pl-3.5 text-white md:flex" title="Время в симуляции">
        <Sparkles className="size-4 text-brand-2" aria-hidden />
        <span className="display num text-[0.95rem] font-medium">{frame ? time(frame.clock) : "—"}</span>
        <span className="text-xs font-medium text-white/60">симуляция</span>
      </div>
    );
  }
  if (!floor?.ready) return null;
  const online = status === "online";
  const sess = shift.data?.session;
  const accepted = sess && !sess.closed_at;
  const who = accepted ? sess.supervisor.split(" ").reverse().map((w, i) => (i === 0 ? w : `${w[0]}.`)).join(" ") : null;
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-10 items-center gap-2 rounded-full bg-white/80 pr-2.5 pl-3.5 transition-colors hover:bg-white"
      >
        <Dot color={online ? "var(--color-run)" : "var(--color-down)"} pulse={online} />
        <span className="display num text-[0.95rem] font-medium">{time(floor.clock)}</span>
        <span className="hidden text-xs font-medium whitespace-nowrap text-ink-3 sm:inline">
          {floor.working ? (who ? `смена ${floor.shift.number} · ${who}` : `смена ${floor.shift.number} · не принята`) : "вне смены"}
        </span>
        {floor.speed !== 1 && <span className="num rounded-full bg-deep px-1.5 text-2xs font-bold text-white">×{floor.speed}</span>}
        {floor.paused && <span className="rounded-full bg-blocked-soft px-1.5 text-2xs font-bold text-blocked">пауза</span>}
        <ChevronDown className="size-3.5 text-ink-3" aria-hidden />
      </button>
      {open && <ShiftPanel onClose={() => setOpen(false)} me={me} />}
    </div>
  );
}

function ShiftPanel({ onClose, me }: { onClose: () => void; me: ReturnType<typeof useSession> }) {
  const floor = useFloor();
  const shift = useShift();
  const ctl = useFloorControl();
  const actions = useShiftActions();
  const [form, setForm] = useState<null | "start" | "close">(null);
  const [staff, setStaff] = useState("58");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const info = shift.data;
  const sess = info?.session;
  const accepted = sess && !sess.closed_at;
  const canShift = can(me, "shift");
  const report = async () => {
    setBusy(true);
    try {
      await download("/documents/floor.pdf", "smennyi_otchet.pdf");
    } catch (e) {
      toast({ title: "Не удалось сформировать отчёт", body: (e as Error).message, tone: "down" });
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    const done = (title: string, body: string) => {
      toast({ title, body, tone: "run" });
      setForm(null);
      onClose();
    };
    if (form === "start")
      actions.start.mutate(
        { staff: Number(staff) || undefined, note: note.trim() || undefined },
        { onSuccess: (r) => done(`Смена ${r.shift} принята`, "Рабочие видят, кто ведёт смену. Сообщения с участков придут вам."), onError: (e) => toast({ title: "Не получилось", body: e.message, tone: "down" }) },
      );
    else
      actions.close.mutate(
        { note: note.trim() || undefined },
        { onSuccess: (r) => done(`Смена ${r.shift} сдана`, `Выпущено ${r.summary.finished ?? 0}. Итог записан в историю смен.`), onError: (e) => toast({ title: "Не получилось", body: e.message, tone: "down" }) },
      );
  };
  return (
    <>
      <div className="panel absolute top-12 right-0 z-50 w-[min(340px,calc(100vw-1.5rem))] animate-[fade-up_.18s_var(--ease-out)] p-4" role="dialog" aria-label="Смена">
        {info?.working ? (
          <>
            <div className="text-xs text-ink-3">
              Смена {info.number} · {time(info.start)}–{time(info.end)} · план {info.plan}
            </div>
            <div className="mt-1 text-[1.05rem] font-semibold">{accepted ? sess.supervisor : "Смена не принята"}</div>
            {accepted && (
              <p className="text-xs text-ink-3">
                принял в {time(sess.started_at)}
                {sess.staff ? ` · на смене ${sess.staff} чел.` : ""}
              </p>
            )}
            {canShift && (
              <div className="mt-3 flex gap-2">
                {!accepted && (
                  <Button variant="primary" size="sm" icon={<ClipboardCheck className="size-4" />} onClick={() => setForm("start")}>
                    Принять быстро
                  </Button>
                )}
                {accepted && (
                  <Button variant="secondary" size="sm" onClick={() => setForm("close")}>
                    Сдать смену
                  </Button>
                )}
                <Link to="/app/shift" onClick={onClose} className="inline-flex h-9 items-center rounded-full px-3 text-sm font-semibold text-accent hover:bg-sunken">
                  {accepted ? "Пульт смены" : "С людьми и чек-листом"}
                </Link>
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-ink-2">Сейчас нерабочее время. Следующая смена начнётся по графику.</div>
        )}
        {info?.previous && (
          <p className="mt-3 rounded-[12px] bg-sunken px-3 py-2 text-xs text-ink-2">
            Прошлая смена: {info.previous.supervisor} — выпущено {info.previous.summary.finished ?? "—"} из {info.previous.plan}
          </p>
        )}
        <Button variant="ghost" size="sm" className="mt-2 -ml-2" loading={busy} icon={<FileDown className="size-4" />} onClick={report}>
          Сменный отчёт PDF
        </Button>
        {can(me, "operate") && floor && (
          <div className="mt-3 border-t border-line pt-3">
            <div className="mb-2 text-xs font-semibold text-ink-3">Скорость модели цеха (для показа)</div>
            <div className="flex items-center gap-2">
              <div role="radiogroup" aria-label="Скорость модели" className="flex rounded-full bg-sunken p-0.5">
                {SPEEDS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={floor.speed === v}
                    onClick={() => ctl.speed.mutate(v)}
                    className={clsx("num h-7 rounded-full px-2.5 text-xs font-bold transition-colors", floor.speed === v ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink")}
                  >
                    {v === 1 ? "Реальное" : `×${v}`}
                  </button>
                ))}
              </div>
              <IconButton label={floor.paused ? "Продолжить" : "Пауза"} className="size-8" onClick={() => ctl.pause.mutate(!floor.paused)}>
                {floor.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              </IconButton>
            </div>
          </div>
        )}
      </div>
      <Sheet open={form != null} onClose={() => setForm(null)} title={form === "start" ? "Принять смену" : "Сдать смену"}>
        <div className="flex flex-col gap-4">
          {form === "start" && (
            <Field label="Сколько человек вышло на смену">
              <Input inputMode="numeric" value={staff} onChange={(e) => setStaff(e.target.value.replace(/\D/g, "").slice(0, 4))} />
            </Field>
          )}
          <Field label={form === "start" ? "Что передала прошлая смена (необязательно)" : "Что передать следующей смене (необязательно)"}>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full resize-none rounded-[12px] border border-line-strong bg-sunken px-3.5 py-2.5 text-sm focus:border-accent focus:bg-panel focus:outline-none"
            />
          </Field>
          <Button variant="primary" className="h-12" loading={actions.start.isPending || actions.close.isPending} onClick={submit}>
            {form === "start" ? "Принять смену" : "Сдать смену"}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function MyAreaLink() {
  const me = useSession();
  if (me?.role !== "worker") return null;
  return (
    <Link to="/work" className="inline-flex h-10 items-center gap-1.5 rounded-full bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-2">
      Мой участок
    </Link>
  );
}
