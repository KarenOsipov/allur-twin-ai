import { clsx } from "clsx";
import { CalendarClock, CheckCircle2, CircleAlert, ClipboardCheck, FileDown, Minus, Plus, RotateCcw, Save, Trash2, Users } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { download } from "@/shared/api/client";
import { useSaveShiftSetup, useShift, useShiftActions, useShiftHistory, useShiftSetup } from "@/shared/api/queries";
import type { ShiftInfo, ShiftPlanSetup, ShiftSession, ShiftSetup } from "@/shared/api/types";
import { can, useSession } from "@/shared/auth/session";
import { dateTime, dayLabel, kzt, num, num1, time } from "@/shared/lib/format";
import { useFloor } from "@/shared/realtime/live";
import { Button } from "@/shared/ui/Button";
import { Field, Input, Select } from "@/shared/ui/Field";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { toast } from "@/shared/ui/Toaster";

export function ShiftPage() {
  const me = useSession();
  const shift = useShift();
  const setup = useShiftSetup();
  const canShift = can(me, "shift");
  if (shift.isError) return <ErrorNote error={shift.error} />;
  if (!shift.data || !setup.data) return <Skeleton className="h-[520px]" />;
  const info = shift.data;
  const sess = info.session;
  const accepted = !!sess && !sess.closed_at;

  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-12 flex flex-col gap-4 xl:col-span-8">
        <NowCard info={info} />
        {info.working && !accepted && canShift && <AcceptForm info={info} setup={setup.data} />}
        {info.working && !accepted && !canShift && (
          <Panel i={2}>
            <p className="text-sm text-ink-2">Смену ещё не приняли. Принимает начальник смены.</p>
          </Panel>
        )}
        {accepted && <LiveShift info={info} sess={sess} setup={setup.data} canShift={canShift} />}
      </div>
      <div className="col-span-12 flex flex-col gap-4 xl:col-span-4">
        <Handover prev={info.previous} />
        <Schedule setup={setup.data} info={info} />
      </div>
      {canShift && <SetupPanel setup={setup.data} />}
      <History />
    </div>
  );
}

function NowCard({ info }: { info: ShiftInfo }) {
  const floor = useFloor();
  const sess = info.session;
  const accepted = !!sess && !sess.closed_at;
  const progress = floor?.working ? floor.shift.progress : 0;
  const plan = info.plan ?? 0;
  const done = floor?.kpi.finished ?? 0;
  const planNow = Math.round(plan * progress);
  const delta = done - planNow;
  return (
    <Panel tone="deep" i={0} bodyClass="p-6 sm:p-7">
      {!info.working ? (
        <div>
          <div className="text-sm text-white/60">Сейчас нерабочее время</div>
          <div className="display mt-1 text-[2.2rem] font-light">Следующая смена — по графику</div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-sm text-white/60">
                Смена {info.number} · {time(info.start)}–{time(info.end)}
              </div>
              <div className="display mt-1 text-[2.2rem] leading-tight font-light">{accepted ? sess!.supervisor : "Смена не принята"}</div>
              <div className="mt-1 text-sm text-white/70">
                {accepted ? `принял в ${time(sess!.started_at)}${sess!.staff ? ` · на смене ${sess!.staff} чел.` : ""}` : "Начальник смены ещё не принял смену"}
              </div>
            </div>
            <span className={clsx("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-bold", accepted ? "bg-run text-white" : "bg-white/10 text-white/80")}>
              {accepted ? <CheckCircle2 className="size-4" aria-hidden /> : <CircleAlert className="size-4" aria-hidden />}
              {accepted ? "Смена принята" : "Ждёт приёмки"}
            </span>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Big label="Выпущено" value={num(done)} sub={`из ${plan} по плану смены`} />
            <Big label="К этому часу" value={`${delta >= 0 ? "+" : "−"}${num(Math.abs(delta))}`} sub={`план к ${time(floor?.clock)} — ${planNow}`} tone={delta >= 0 ? "ok" : "bad"} />
            <Big label="Прогноз к концу" value={floor?.kpi.forecast_shift != null ? num(floor.kpi.forecast_shift) : "—"} sub="по модели цеха" />
          </div>
          <div className="mt-6">
            <div className="flex justify-between text-xs text-white/60">
              <span>{time(info.start)}</span>
              <span>прошло {Math.round(progress * 100)}% смены</span>
              <span>{time(info.end)}</span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

function Big({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "ok" | "bad" }) {
  return (
    <div className="rounded-[18px] bg-white/[0.06] px-4 py-3.5">
      <div className="text-xs text-white/60">{label}</div>
      <div className={clsx("display num mt-1 text-[2rem] leading-none font-light", tone === "ok" && "text-[#7be3a5]", tone === "bad" && "text-[#ff8a80]")}>{value}</div>
      <div className="mt-1.5 text-xs text-white/55">{sub}</div>
    </div>
  );
}

function Stepper({ value, onChange, min = 0, max = 500, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" aria-label={`${label}: меньше`} onClick={() => onChange(Math.max(min, value - 1))} className="grid size-8 place-items-center rounded-full bg-sunken text-ink-2 hover:bg-floor">
        <Minus className="size-3.5" />
      </button>
      <input
        aria-label={label}
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value.replace(/\D/g, "")) || 0)))}
        className="num h-8 w-12 rounded-[10px] border border-line-strong bg-panel text-center text-sm font-semibold focus:border-accent focus:outline-none"
      />
      <button type="button" aria-label={`${label}: больше`} onClick={() => onChange(Math.min(max, value + 1))} className="grid size-8 place-items-center rounded-full bg-sunken text-ink-2 hover:bg-floor">
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

function AcceptForm({ info, setup }: { info: ShiftInfo; setup: ShiftSetup }) {
  const actions = useShiftActions();
  const norm = setup.shifts[String(info.number)] ?? Object.values(setup.shifts)[0];
  const [plan, setPlan] = useState(info.plan ?? norm.plan);
  const [staff, setStaff] = useState<Record<string, number>>({ ...norm.staff });
  const [checked, setChecked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const total = Object.values(staff).reduce((a, b) => a + b, 0);
  const normTotal = Object.values(norm.staff).reduce((a, b) => a + b, 0);
  const short = setup.areas.filter((a) => (staff[a.code] ?? 0) < (norm.staff[a.code] ?? 0));
  const missing = setup.checklist.filter((x) => !checked.includes(x));

  const submit = () =>
    actions.start.mutate(
      { plan, staff_by_area: staff, checklist: checked, note: note.trim() || undefined },
      {
        onSuccess: (r) => toast({ title: `Смена ${r.shift} принята`, body: `План ${r.plan}, на смене ${r.staff ?? total} чел. Все в чате видят, кто ведёт смену.`, tone: "run" }),
        onError: (e) => toast({ title: "Не получилось принять смену", body: e.message, tone: "down" }),
      },
    );

  return (
    <Panel i={1} title="Принять смену" hint="Проверьте людей и готовность — всё запишется в историю смены и сменный отчёт." id="accept">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 rounded-[16px] bg-sunken px-4 py-3">
            <div>
              <div className="text-sm font-semibold">План на смену</div>
              <div className="text-xs text-ink-3">по настройке — {norm.plan} авто</div>
            </div>
            <Stepper label="План на смену" value={plan} onChange={setPlan} min={1} max={1000} />
          </div>
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm font-semibold">Люди по участкам</span>
              <span className={clsx("num text-sm font-semibold", total < normTotal ? "text-blocked" : "text-run")}>
                {total} из {normTotal}
              </span>
            </div>
            <ul className="flex flex-col divide-y divide-line rounded-[16px] border border-line">
              {setup.areas.map((a) => {
                const n = staff[a.code] ?? 0;
                const want = norm.staff[a.code] ?? 0;
                return (
                  <li key={a.code} className="flex items-center justify-between gap-3 px-3.5 py-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{a.name}</span>
                      <span className={clsx("block text-xs", n < want ? "text-blocked" : "text-ink-3")}>{n < want ? `не хватает ${want - n}` : `норма ${want}`}</span>
                    </span>
                    <Stepper label={a.name} value={n} onChange={(v) => setStaff((s) => ({ ...s, [a.code]: v }))} />
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Готовность к смене</legend>
            <ul className="flex flex-col gap-1.5">
              {setup.checklist.map((x) => {
                const on = checked.includes(x);
                return (
                  <li key={x}>
                    <label className={clsx("flex cursor-pointer items-center gap-3 rounded-[14px] px-3.5 py-2.5 text-sm transition-colors", on ? "bg-run-soft text-ink" : "bg-sunken text-ink-2 hover:bg-floor")}>
                      <input type="checkbox" checked={on} onChange={() => setChecked((c) => (on ? c.filter((y) => y !== x) : [...c, x]))} className="size-4 accent-[var(--color-run)]" />
                      {x}
                    </label>
                  </li>
                );
              })}
            </ul>
            {setup.checklist.length > 0 && (
              <button type="button" onClick={() => setChecked(missing.length ? [...setup.checklist] : [])} className="mt-2 text-xs font-semibold text-accent hover:underline">
                {missing.length ? "Отметить всё" : "Снять отметки"}
              </button>
            )}
          </fieldset>
          <Field label="Заметка при приёмке (необязательно)" hint="Например: Камера-02 после ремонта, следить за давлением">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full resize-none rounded-[12px] border border-line-strong bg-sunken px-3.5 py-2.5 text-sm focus:border-accent focus:bg-panel focus:outline-none"
            />
          </Field>
          {(short.length > 0 || missing.length > 0) && (
            <p className="rounded-[14px] bg-blocked-soft px-3.5 py-2.5 text-xs text-ink-2">
              {short.length > 0 && <>Не хватает людей: {short.map((a) => a.name.toLowerCase()).join(", ")}. </>}
              {missing.length > 0 && <>Не отмечено пунктов готовности: {missing.length} — это попадёт в журнал смены.</>}
            </p>
          )}
          <Button variant="primary" className="h-12" icon={<ClipboardCheck className="size-5" />} loading={actions.start.isPending} onClick={submit}>
            Принять смену
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function LiveShift({ info, sess, setup, canShift }: { info: ShiftInfo; sess: ShiftSession; setup: ShiftSetup; canShift: boolean }) {
  const floor = useFloor();
  const actions = useShiftActions();
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const start = sess.summary.start;
  const names = Object.fromEntries(setup.areas.map((a) => [a.code, a.name]));
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
  const close = () =>
    actions.close.mutate(
      { note: note.trim() || undefined },
      {
        onSuccess: (r) => {
          toast({ title: `Смена ${r.shift} сдана`, body: `Выпущено ${r.summary.finished ?? 0} из ${r.plan}. Итог записан в историю смен.`, tone: "run" });
          setClosing(false);
        },
        onError: (e) => toast({ title: "Не получилось сдать смену", body: e.message, tone: "down" }),
      },
    );
  return (
    <Panel
      i={1}
      title="Смена идёт"
      hint={`Принял ${sess.supervisor} в ${time(sess.started_at)}. План ${sess.plan} авто.`}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" icon={<FileDown className="size-4" />} loading={busy} onClick={report}>
            Сменный отчёт PDF
          </Button>
          {canShift && !closing && (
            <Button variant="primary" size="sm" onClick={() => setClosing(true)}>
              Сдать смену
            </Button>
          )}
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <Tile label="Брак в смене" value={floor ? `${num1(floor.kpi.defect_pct)}%` : "—"} bad={(floor?.kpi.defect_pct ?? 0) > 2} />
        <Tile label="На доработке" value={num(floor?.kpi.rework)} />
        <Tile label="Сейчас стоит" value={`${num(floor?.kpi.down_now)} ед.`} bad={(floor?.kpi.down_now ?? 0) > 0} />
        <Tile label="Узкое место" value={floor?.kpi.bottleneck ? (names[floor.kpi.bottleneck] ?? floor.kpi.bottleneck) : "—"} />
      </div>
      {start && (Object.keys(start.staff_by_area).length > 0 || start.missing.length > 0) && (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {Object.keys(start.staff_by_area).length > 0 && (
            <div className="rounded-[16px] bg-sunken px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-ink-3">
                <Users className="size-3.5" aria-hidden /> Люди на участках
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(start.staff_by_area).map(([k, v]) => (
                  <span key={k} className="rounded-full bg-panel px-2.5 py-1 text-xs">
                    {names[k] ?? k} <b className="num">{v}</b>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="rounded-[16px] bg-sunken px-4 py-3 text-sm">
            <div className="mb-1 text-xs font-semibold text-ink-3">При приёмке</div>
            {start.missing.length ? (
              <p className="text-blocked">Не отмечено: {start.missing.join("; ").toLowerCase()}</p>
            ) : (
              <p className="text-run">Все пункты готовности отмечены</p>
            )}
            {sess.note && <p className="mt-1 text-ink-2">{sess.note}</p>}
          </div>
        </div>
      )}
      {closing && (
        <div className="mt-5 rounded-[18px] border border-line-strong p-4">
          <div className="text-sm font-semibold">Сдать смену {info.number}</div>
          <p className="mt-1 text-xs text-ink-3">
            Итог запишется сейчас: выпущено {num(floor?.kpi.finished)} из {sess.plan}, брак {num1(floor?.kpi.defect_pct)}%. Следующая смена увидит вашу заметку.
          </p>
          <Field label="Что передать следующей смене" className="mt-3">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              rows={3}
              className="w-full resize-none rounded-[12px] border border-line-strong bg-sunken px-3.5 py-2.5 text-sm focus:border-accent focus:bg-panel focus:outline-none"
            />
          </Field>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" loading={actions.close.isPending} onClick={close}>
              Сдать смену
            </Button>
            <Button variant="ghost" onClick={() => setClosing(false)}>
              Отмена
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function Tile({ label, value, bad }: { label: string; value: ReactNode; bad?: boolean }) {
  return (
    <div className="rounded-[16px] bg-sunken px-4 py-3">
      <div className="text-xs text-ink-3">{label}</div>
      <div className={clsx("display num mt-1 truncate text-[1.5rem] leading-tight font-light", bad && "text-down")}>{value}</div>
    </div>
  );
}

function Handover({ prev }: { prev: ShiftSession | null }) {
  return (
    <Panel i={2} title="Передача от прошлой смены">
      {!prev ? (
        <p className="text-sm text-ink-3">Закрытых смен пока нет.</p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="text-xs text-ink-3">
            Смена {prev.shift} · {dayLabel(prev.day)} · {prev.supervisor}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Mini label="Выпущено" value={`${num(prev.summary.finished)} / ${prev.summary.plan ?? prev.plan}`} />
            <Mini label="Брак" value={prev.summary.defect_pct != null ? `${num1(prev.summary.defect_pct)}%` : "—"} />
            <Mini label="Простой" value={prev.summary.down_min != null ? `${num(prev.summary.down_min)} мин` : "—"} />
          </div>
          {prev.note ? <p className="rounded-[14px] bg-sunken px-3.5 py-2.5 whitespace-pre-line text-ink-2">{prev.note}</p> : <p className="text-ink-3">Заметок не оставили.</p>}
        </div>
      )}
    </Panel>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[12px] bg-sunken px-2.5 py-2">
      <div className="text-2xs text-ink-3">{label}</div>
      <div className="num mt-0.5 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function Schedule({ setup, info }: { setup: ShiftSetup; info: ShiftInfo }) {
  return (
    <Panel i={3} title="График смен" hint={`Рабочие дни: ${setup.workdays.join(", ")}`}>
      <ul className="flex flex-col gap-2">
        {setup.schedule.map((sh) => {
          const cfg = setup.shifts[String(sh.number)];
          const now = info.working && info.number === sh.number;
          return (
            <li key={sh.number} className={clsx("flex items-center gap-3 rounded-[16px] px-3.5 py-3", now ? "bg-brand-soft/60 ring-1 ring-brand/30" : "bg-sunken")}>
              <CalendarClock className={clsx("size-5 shrink-0", now ? "text-brand" : "text-ink-3")} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">
                  Смена {sh.number} · {sh.start}–{sh.end} {now && <span className="text-xs font-normal text-brand">· сейчас</span>}
                </div>
                <div className="truncate text-xs text-ink-3">
                  план {cfg?.plan ?? "—"} · людей {cfg ? Object.values(cfg.staff).reduce((a, b) => a + b, 0) : "—"}
                  {cfg?.supervisor ? ` · ${cfg.supervisor}` : ""}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function SetupPanel({ setup }: { setup: ShiftSetup }) {
  const save = useSaveShiftSetup();
  const [shifts, setShifts] = useState<Record<string, ShiftPlanSetup>>(setup.shifts);
  const [checklist, setChecklist] = useState<string[]>(setup.checklist);
  const [item, setItem] = useState("");
  useEffect(() => {
    setShifts(setup.shifts);
    setChecklist(setup.checklist);
  }, [setup]);
  const dirty = useMemo(() => JSON.stringify(shifts) !== JSON.stringify(setup.shifts) || JSON.stringify(checklist) !== JSON.stringify(setup.checklist), [shifts, checklist, setup]);
  const upd = (k: string, patch: Partial<ShiftPlanSetup>) => setShifts((s) => ({ ...s, [k]: { ...s[k], ...patch } }));
  const submit = () =>
    save.mutate(
      { shifts, checklist },
      {
        onSuccess: () => toast({ title: "Настройка смен сохранена", body: "Новые план и нормы применятся при приёмке следующей смены.", tone: "run" }),
        onError: (e) => toast({ title: "Не удалось сохранить", body: e.message, tone: "down" }),
      },
    );
  const add = () => {
    const t = item.trim();
    if (t && !checklist.includes(t)) setChecklist((c) => [...c, t]);
    setItem("");
  };
  return (
    <Panel
      i={4}
      className="col-span-12"
      title="Настройка смен"
      hint="План, ответственный и норма людей по участкам для каждой смены, чек-лист приёмки. Время смен задано графиком завода."
      actions={
        <div className="flex gap-2">
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw className="size-4" />}
              onClick={() => {
                setShifts(setup.shifts);
                setChecklist(setup.checklist);
              }}
            >
              Отменить
            </Button>
          )}
          <Button variant={dirty ? "primary" : "secondary"} size="sm" icon={<Save className="size-4" />} loading={save.isPending} disabled={!dirty} onClick={submit}>
            Сохранить
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {setup.schedule.map((sh) => {
          const k = String(sh.number);
          const cfg = shifts[k];
          if (!cfg) return null;
          const total = Object.values(cfg.staff).reduce((a, b) => a + b, 0);
          return (
            <div key={k} className="rounded-[18px] border border-line p-4">
              <div className="flex items-baseline justify-between">
                <div className="font-semibold">
                  Смена {sh.number} · {sh.start}–{sh.end}
                </div>
                <div className="num text-xs text-ink-3">{total} чел.</div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-sm text-ink-2">План, авто</span>
                <Stepper label={`План смены ${sh.number}`} value={cfg.plan} onChange={(v) => upd(k, { plan: Math.max(1, v) })} min={1} max={1000} />
              </div>
              <Field label="Ответственный по умолчанию" className="mt-3">
                <Select value={cfg.supervisor ?? ""} onChange={(e) => upd(k, { supervisor: e.target.value || null })}>
                  <option value="">не назначен</option>
                  {setup.supervisors.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="mt-3 text-xs font-semibold text-ink-3">Норма людей</div>
              <ul className="mt-1.5 flex flex-col gap-1">
                {setup.areas.map((a) => (
                  <li key={a.code} className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm">{a.name}</span>
                    <Stepper label={`${a.name}, смена ${sh.number}`} value={cfg.staff[a.code] ?? 0} onChange={(v) => upd(k, { staff: { ...cfg.staff, [a.code]: v } })} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        <div className="rounded-[18px] border border-line p-4">
          <div className="font-semibold">Чек-лист приёмки</div>
          <p className="mt-0.5 text-xs text-ink-3">Что начальник смены проверяет перед началом. Неотмеченное попадает в журнал.</p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {checklist.map((x) => (
              <li key={x} className="flex items-center gap-2 rounded-[12px] bg-sunken py-1.5 pr-1 pl-3 text-sm">
                <span className="min-w-0 flex-1">{x}</span>
                <button type="button" aria-label={`Убрать «${x}»`} onClick={() => setChecklist((c) => c.filter((y) => y !== x))} className="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-down-soft hover:text-down">
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input value={item} onChange={(e) => setItem(e.target.value.slice(0, 120))} aria-label="Новый пункт чек-листа" placeholder="Новый пункт" />
            <Button type="submit" variant="secondary" size="sm" disabled={!item.trim()} icon={<Plus className="size-4" />}>
              Добавить
            </Button>
          </form>
        </div>
      </div>
    </Panel>
  );
}

function History() {
  const h = useShiftHistory();
  return (
    <Panel i={5} className="col-span-12" title="История смен" hint="Последние смены: кто вёл, план и факт, брак, простои и сообщения с участков." bodyClass="px-0 pb-2">
      {!h.data ? (
        <div className="px-6">
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-3">
                {["Дата", "Смена", "Начальник смены", "План / факт", "Брак", "Простой", "Сообщения", "Потери", "Сдал"].map((t) => (
                  <th key={t} className="px-4 py-2 font-semibold first:pl-6">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {h.data.slice(0, 20).map((s) => {
                const f = s.summary.finished;
                const plan = s.summary.plan ?? s.plan;
                const low = f != null && f < plan * 0.95;
                return (
                  <tr key={s.id} className="border-t border-line">
                    <td className="px-4 py-2.5 pl-6 whitespace-nowrap">{dayLabel(s.day)}</td>
                    <td className="px-4 py-2.5">{s.shift}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">{s.supervisor}</td>
                    <td className={clsx("num px-4 py-2.5", low && "text-down")}>{s.closed_at ? `${num(plan)} / ${num(f)}` : <span className="text-run">идёт · план {plan}</span>}</td>
                    <td className="num px-4 py-2.5">{s.summary.defect_pct != null ? `${num1(s.summary.defect_pct)}%` : "—"}</td>
                    <td className="num px-4 py-2.5">{s.summary.down_min != null ? `${num(s.summary.down_min)} мин` : "—"}</td>
                    <td className="num px-4 py-2.5">{s.summary.reports ?? "—"}</td>
                    <td className="num px-4 py-2.5 whitespace-nowrap">{s.summary.cost_kzt ? kzt(s.summary.cost_kzt) : "—"}</td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap text-ink-3">{s.closed_at ? `${s.summary.closed_by ?? ""} · ${dateTime(s.closed_at)}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
