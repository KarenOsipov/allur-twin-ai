import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, ChevronDown, CircleCheck, LayoutGrid, CircleHelp, Clock3, LogOut, MessageCircle, OctagonAlert, PackageX, ScanSearch, ShieldAlert, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { request } from "@/shared/api/client";
import { useMyProblems, useReportProblem, useWorkerOverview } from "@/shared/api/queries";
import type { Incident, ProblemKind, ProblemOut, WorkerOverview } from "@/shared/api/types";
import { initials } from "@/features/auth/LoginPage";
import { can, session, useSession } from "@/shared/auth/session";
import { ChatDock } from "@/shared/chat/ChatDock";
import { chatBus } from "@/shared/chat/bus";
import { connectLive, disconnectLive } from "@/shared/realtime/live";
import { signOutSupabase } from "@/shared/supabase/supabase";
import { EQ_STATUS, AREA_STATE, STATE_COLOR, dateTime, num, time } from "@/shared/lib/format";

const sameDay = (s: string) => new Date(s).toDateString() === new Date().toDateString();
import { Button } from "@/shared/ui/Button";
import { Logo } from "@/shared/ui/Logo";
import { ErrorNote, Skeleton } from "@/shared/ui/Panel";
import { Sheet } from "@/shared/ui/Sheet";
import { Dot } from "@/shared/ui/Status";

const KINDS: { kind: ProblemKind; label: string; hint: string; icon: typeof Wrench }[] = [
  { kind: "equipment", label: "Поломка", hint: "станок, робот, конвейер", icon: Wrench },
  { kind: "supply", label: "Нет комплектующих", hint: "склад, поставка", icon: PackageX },
  { kind: "quality", label: "Брак", hint: "дефекты идут подряд", icon: ScanSearch },
  { kind: "safety", label: "Опасно", hint: "травма, утечка, дым", icon: ShieldAlert },
  { kind: "other", label: "Другое", hint: "нет людей, вопрос", icon: MessageCircle },
];

export function WorkerPage() {
  const s = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [area, setArea] = useState<string | undefined>(undefined);
  const view = useWorkerOverview(area);
  const mine = useMyProblems();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    connectLive(qc);
    return () => disconnectLive();
  }, [qc]);

  const logout = () => {
    request("/auth/logout", { method: "POST" }).catch(() => undefined);
    void signOutSupabase();
    chatBus.close();
    session.clear({ logout: true });
    qc.clear();
    navigate("/login", { replace: true });
  };

  return (
    <div className="min-h-dvh pb-24">
      <div aria-hidden className="ambient" />
      <header className="sticky top-0 z-30 px-3 pt-3">
        <div className="glass-bar mx-auto flex h-14 max-w-[600px] items-center gap-3 rounded-[22px] pr-2 pl-4">
          <Logo />
          <div className="ml-auto flex min-w-0 items-center gap-2.5">
            <div className="min-w-0 text-right">
              <div className="truncate text-sm font-semibold">{s?.name}</div>
              <div className="truncate text-xs text-ink-3">{s?.position}</div>
            </div>
            <span className="display grid size-10 shrink-0 place-items-center rounded-full bg-deep text-sm font-medium text-white" aria-hidden>
              {initials(s?.name ?? "")}
            </span>
            {can(s, "view") && (
              <Link to="/app" aria-label="Вернуться в систему" className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-sunken px-3 text-sm font-semibold text-ink-2 hover:bg-floor hover:text-ink">
                <LayoutGrid className="size-4" aria-hidden />
                <span className="hidden min-[440px]:inline">В систему</span>
              </Link>
            )}
            {!can(s, "view") && (
              <button type="button" onClick={logout} aria-label="На главную" className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-sunken px-3 text-sm font-semibold text-ink-2 hover:bg-floor hover:text-ink">
                <LogOut className="size-4" aria-hidden />
                <span className="hidden min-[440px]:inline">На главную</span>
              </button>
            )}
            {can(s, "view") && (
              <button type="button" onClick={logout} aria-label="Выйти" className="grid size-10 place-items-center rounded-full text-ink-2 hover:bg-sunken">
                <LogOut className="size-5" />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto mt-4 flex max-w-[600px] flex-col gap-4 px-3">
        {view.isLoading && <Skeleton className="h-64" />}
        {view.isError && <ErrorNote error={view.error} />}
        {view.data && <AreaCard v={view.data} onArea={setArea} />}

        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rise flex h-20 items-center justify-center gap-3 rounded-[24px] bg-brand text-lg font-bold text-white shadow-[0_18px_40px_-18px_rgb(227_36_27/0.9)] transition-transform active:scale-[0.98]"
        >
          <OctagonAlert className="size-7" aria-hidden />
          Сообщить о проблеме
        </button>
        <p className="-mt-2 text-center text-xs text-ink-3">
          {view.data?.supervisor ? `Сообщение сразу получит начальник смены — ${view.data.supervisor}` : "Сообщение получат начальник смены и руководитель"}
        </p>

        <section className="panel px-5 py-5">
          <h2 className="text-[1.05rem] font-semibold">Мои сообщения</h2>
          {mine.data && mine.data.length === 0 && <p className="mt-2 text-sm text-ink-3">Пока сообщений не было. Если что-то случится — нажмите красную кнопку.</p>}
          <ul className="mt-3 flex flex-col gap-2">
            {(mine.data ?? []).slice(0, 8).map((i) => (
              <MyProblem key={i.id} i={i} />
            ))}
          </ul>
        </section>
      </main>

      {view.data && <ReportSheet open={open} onClose={() => setOpen(false)} v={view.data} />}
      <ChatDock />
    </div>
  );
}

function AreaCard({ v, onArea }: { v: WorkerOverview; onArea: (a: string) => void }) {
  const st = v.area.state;
  const isStore = v.area.kind === "store";
  return (
    <section className="panel rise px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-[13rem]">
          <AreaPicker v={v} onArea={onArea} />
          <p className="text-sm text-ink-3">
            {v.working ? `Смена ${v.shift.number} · ${time(v.clock)}` : `Вне смены · ${time(v.clock)}`}
          </p>
        </div>
        {!isStore && st && (
          <span className="inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-bold" style={{ background: `color-mix(in srgb, ${STATE_COLOR[st]} 14%, white)`, color: STATE_COLOR[st] }}>
            <Dot color={STATE_COLOR[st]} pulse={st === "run" || st === "down"} />
            {AREA_STATE[st]}
          </span>
        )}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2">
        <Stat label={isStore ? "На складе" : "Сделано за смену"} value={num(isStore ? v.area.stock : v.area.output)} />
        <Stat label="Линия: выпуск / план к часу" value={`${num(v.kpi.finished)} / ${num(v.kpi.plan_to_now)}`} />
      </dl>
      {v.equipment.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1.5">
          {v.equipment.map((e) => (
            <li key={e.code} className="flex items-center justify-between gap-3 rounded-[14px] bg-sunken px-3.5 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{e.code}</span>
                <span className="block truncate text-xs text-ink-3">{e.reason ?? e.name}</span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold" style={{ color: STATE_COLOR[e.status] }}>
                <Dot color={STATE_COLOR[e.status]} />
                {EQ_STATUS[e.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-[0.8125rem] text-ink-2">
        Начальник смены: <b>{v.supervisor ?? "смена ещё не принята"}</b>
      </p>
    </section>
  );
}

function AreaPicker({ v, onArea }: { v: WorkerOverview; onArea: (a: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Участок: ${v.area.name}. Сменить участок`}
        className="group -ml-1.5 flex max-w-full items-center gap-1.5 rounded-[12px] px-1.5 py-0.5 text-left transition-colors hover:bg-sunken"
      >
        <span className="display min-w-0 text-[clamp(1.4rem,6vw,1.9rem)] leading-tight font-light tracking-[-0.02em] text-balance">{v.area.name}</span>
        <ChevronDown className="size-5 shrink-0 text-ink-3 transition-transform group-hover:translate-y-0.5" aria-hidden />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Участок">
        <ul className="flex flex-col gap-1.5 pb-1">
          {v.areas.map((a) => {
            const on = a.code === v.area.code;
            return (
              <li key={a.code}>
                <button
                  type="button"
                  onClick={() => {
                    onArea(a.code);
                    setOpen(false);
                  }}
                  aria-current={on}
                  className={clsx("flex h-14 w-full items-center gap-3 rounded-[16px] px-4 text-left text-[1.02rem] transition-colors", on ? "bg-brand-soft/70 font-semibold text-ink" : "bg-sunken hover:bg-floor")}
                >
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {on && <Check className="size-5 text-brand" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      </Sheet>
    </>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-[16px] bg-sunken px-4 py-3">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="display num mt-0.5 text-[1.6rem] font-light">{value}</dd>
    </div>
  );
}

function MyProblem({ i }: { i: Incident }) {
  const tone = i.status === "resolved" ? "text-run bg-run-soft" : i.status === "ack" ? "text-blocked bg-blocked-soft" : "text-down bg-down-soft";
  const label = i.status === "resolved" ? "Решено" : i.status === "ack" ? `Принято: ${i.acked_by}` : "Отправлено, ждёт";
  return (
    <li className="rounded-[16px] border border-line px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-semibold">{i.title}</span>
        <span className="num shrink-0 text-xs text-ink-3">{sameDay(i.created_at) ? time(i.created_at) : dateTime(i.created_at)}</span>
      </div>
      <span className={clsx("mt-2 inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold", tone)}>
        {i.status === "resolved" ? <CircleCheck className="size-3.5" aria-hidden /> : <Clock3 className="size-3.5" aria-hidden />}
        {label}
      </span>
      {i.resolution && <p className="mt-1.5 text-xs text-ink-2">{i.resolution}</p>}
    </li>
  );
}

function ReportSheet({ open, onClose, v }: { open: boolean; onClose: () => void; v: WorkerOverview }) {
  const report = useReportProblem();
  const [kind, setKind] = useState<ProblemKind | null>(null);
  const [eq, setEq] = useState<string | null>(null);
  const [stopped, setStopped] = useState(true);
  const [minutes, setMinutes] = useState(20);
  const [text, setText] = useState("");
  const [done, setDone] = useState<ProblemOut | null>(null);

  const reset = () => {
    setKind(null);
    setEq(null);
    setStopped(true);
    setMinutes(20);
    setText("");
    setDone(null);
    report.reset();
  };
  const close = () => {
    onClose();
    window.setTimeout(reset, 300);
  };
  const needEq = kind === "equipment";
  const ready = kind && (!needEq || eq);
  const send = () => {
    if (!kind) return;
    report.mutate(
      { kind, area: v.area.code, equipment: needEq ? eq : null, text: text.trim(), line_stopped: kind === "equipment" || kind === "supply" ? stopped : false, minutes },
      { onSuccess: (d) => setDone(d) },
    );
  };

  return (
    <Sheet open={open} onClose={close} title={done ? "Сообщение отправлено" : `Проблема: ${v.area.name.toLowerCase()}`}>
      {done ? (
        <div className="flex flex-col items-center py-4 text-center">
          <span className="grid size-16 place-items-center rounded-full bg-run-soft text-run">
            <CircleCheck className="size-9" aria-hidden />
          </span>
          <p className="mt-4 text-lg font-semibold">{done.supervisor ? `${done.supervisor} получил сообщение` : "Начальник смены получил сообщение"}</p>
          <p className="mt-1 text-sm text-ink-3">{time(done.incident.created_at)} · {done.incident.title}</p>
          {done.applied && <p className="mt-3 rounded-[14px] bg-sunken px-4 py-2 text-xs text-ink-2">Цифровой двойник уже знает: {done.applied}</p>}
          <p className="mt-3 text-sm text-ink-2">Статус — в «Моих сообщениях». Когда примут, здесь появится «Принято».</p>
          <Button variant="primary" className="mt-6 h-12 w-full" onClick={close}>
            Готово
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Что случилось?</legend>
            <div className="grid grid-cols-2 gap-2">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  aria-pressed={kind === k.kind}
                  onClick={() => {
                    setKind(k.kind);
                    setStopped(k.kind === "equipment" || k.kind === "supply");
                  }}
                  className={clsx(
                    "flex min-h-20 flex-col items-start gap-1 rounded-[18px] border-2 px-3.5 py-3 text-left transition-colors",
                    k.kind === "other" && "col-span-2",
                    kind === k.kind ? "border-brand bg-brand-soft" : "border-transparent bg-sunken hover:border-line-strong",
                  )}
                >
                  <k.icon className={clsx("size-5", kind === k.kind ? "text-brand" : "text-ink-2")} aria-hidden />
                  <span className="text-[0.95rem] font-bold">{k.label}</span>
                  <span className="text-xs text-ink-3">{k.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>

          {needEq && (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">Что сломалось?</legend>
              {v.equipment.length === 0 && <p className="text-sm text-ink-3">На этом участке нет оборудования в схеме — выберите «Другое».</p>}
              <div className="flex flex-wrap gap-2">
                {v.equipment.map((e) => (
                  <button
                    key={e.code}
                    type="button"
                    aria-pressed={eq === e.code}
                    onClick={() => setEq(e.code)}
                    className={clsx("h-11 rounded-full border-2 px-4 text-sm font-semibold", eq === e.code ? "border-brand bg-brand-soft" : "border-transparent bg-sunken")}
                  >
                    {e.code}
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          {(kind === "equipment" || kind === "supply") && (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">Участок остановился?</legend>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { v: true, l: "Да, стоим" },
                  { v: false, l: "Нет, работаем" },
                ].map((o) => (
                  <button
                    key={String(o.v)}
                    type="button"
                    aria-pressed={stopped === o.v}
                    onClick={() => setStopped(o.v)}
                    className={clsx("h-12 rounded-[16px] border-2 text-sm font-bold", stopped === o.v ? (o.v ? "border-down bg-down-soft text-down" : "border-run bg-run-soft text-run") : "border-transparent bg-sunken")}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
              {stopped && (
                <>
                  <p className="mt-4 mb-2 text-sm font-semibold">Примерно на сколько?</p>
                  <div className="flex flex-wrap gap-2">
                    {[10, 20, 30, 60, 120].map((m) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={minutes === m}
                        onClick={() => setMinutes(m)}
                        className={clsx("num h-11 rounded-full border-2 px-4 text-sm font-semibold", minutes === m ? "border-ink bg-ink text-white" : "border-transparent bg-sunken")}
                      >
                        {m < 60 ? `${m} мин` : `${m / 60} ч`}
                      </button>
                    ))}
                    <span className="inline-flex items-center gap-1 text-xs text-ink-3">
                      <CircleHelp className="size-3.5" aria-hidden /> не знаете — оставьте 20 мин
                    </span>
                  </div>
                </>
              )}
            </fieldset>
          )}

          {kind && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold">Что видите? (необязательно)</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Например: пропало давление краски, на пульте ошибка E12"
                className="resize-none rounded-[14px] border border-line-strong bg-sunken px-3.5 py-2.5 text-[0.95rem] focus:border-accent focus:bg-panel focus:outline-none"
              />
            </label>
          )}

          {report.isError && <ErrorNote error={report.error} />}
          <Button variant="primary" className="h-14 w-full text-base" disabled={!ready} loading={report.isPending} onClick={send}>
            Отправить начальнику смены
          </Button>
        </div>
      )}
    </Sheet>
  );
}
