import { clsx } from "clsx";
import { CircleCheck, FileDown, Hand, LoaderCircle, MessageSquareQuote, OctagonAlert, Timer, TrendingDown, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { download } from "@/shared/api/client";
import { useImpact, useIncident, useIncidentActions } from "@/shared/api/queries";
import type { Impact, Incident } from "@/shared/api/types";
import { useAlerts, alerts } from "@/shared/alerts/store";
import { can, useSession } from "@/shared/auth/session";
import { LineChart } from "@/shared/charts/charts";
import { kzt, num, num1, plural, time } from "@/shared/lib/format";
import { useFloor } from "@/shared/realtime/live";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { ErrorNote } from "@/shared/ui/Panel";
import { Segmented } from "@/shared/ui/Segmented";
import { toast } from "@/shared/ui/Toaster";

const AREA: Record<string, string> = {
  WH_IN: "Склад комплектующих",
  WELD: "Сварка",
  PAINT: "Окраска",
  ASSY: "Сборка",
  QC: "Контроль качества",
  WH_OUT: "Склад готовой продукции",
};
const DURATIONS = [15, 30, 45, 60, 90];
const STATUS = { open: "Ждёт реакции", ack: "В работе", resolved: "Решено" } as const;

export function ImpactDrawer() {
  const { openId } = useAlerts();
  return (
    <Drawer open={openId != null} onClose={() => alerts.close()} title="Экспресс-анализ" width="max-w-[600px]">
      {openId != null && <ImpactBody id={openId} />}
    </Drawer>
  );
}

function ImpactBody({ id }: { id: number }) {
  const inc = useIncident(id);
  const [minutes, setMinutes] = useState<number | null>(null);
  const q = useImpact(id, minutes);
  const im = q.data;
  const chosen = minutes ?? im?.problem?.minutes ?? null;

  if (inc.isError) return <div className="p-6"><ErrorNote error={inc.error} /></div>;
  const i = inc.data;
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-5 px-5 py-5 sm:px-6">
        {i && <Head inc={i} />}
        <LossHero inc={i} im={im} loading={q.isFetching} />
        {q.isError && <ErrorNote error={q.error} />}
        {im?.available === false && <p className="rounded-[14px] bg-sunken px-4 py-3 text-sm text-ink-2">{im.note}</p>}
        {im?.available && (
          <>
            <section aria-label="Сколько продлится">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="text-[0.95rem] font-semibold">Сколько продлится?</h3>
                <span className="text-xs text-ink-3">пересчёт ~3 с</span>
              </div>
              <Segmented
                label="Длительность проблемы"
                value={chosen ?? 30}
                onChange={(v) => setMinutes(v)}
                options={[...new Set([...(chosen && !DURATIONS.includes(chosen) ? [chosen] : []), ...DURATIONS])].sort((a, b) => a - b).map((m) => ({ value: m, label: m === DURATIONS[0] ? `${m} мин` : `${m}` }))}
              />
            </section>
            <Outcome im={im} />
            <Runway im={im} />
            {im.timeline && im.timeline.labels.length > 1 && (
              <section>
                <h3 className="text-[0.95rem] font-semibold">Выпуск до конца смены</h3>
                <p className="mb-2 text-xs text-ink-3">Нарастающим итогом, среднее {im.runs} прогонов копии линии</p>
                <LineChart
                  height={170}
                  labels={im.timeline.labels}
                  xEvery={Math.max(1, Math.ceil(im.timeline.labels.length / 6))}
                  series={[
                    { name: "Без проблемы", color: "var(--color-ink-3)", values: im.timeline.without, dashed: true },
                    { name: "С проблемой", color: "var(--color-brand)", values: im.timeline.as_is },
                  ]}
                  target={{ value: im.plan, label: `план ${im.plan}` }}
                />
              </section>
            )}
            <Options im={im} />
            {im.summary && (
              <section className="rounded-[16px] bg-sunken px-4 py-3.5">
                <h3 className="mb-1 text-[0.8125rem] font-semibold text-ink-3">Коротко</h3>
                <p className="text-sm leading-relaxed text-ink-2">{im.summary}</p>
              </section>
            )}
          </>
        )}
      </div>
      {i && <Footer inc={i} />}
    </div>
  );
}

function Head({ inc }: { inc: Incident }) {
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
        <span
          className={clsx(
            "inline-flex h-6 items-center gap-1 rounded-full px-2.5 font-semibold",
            inc.status === "open" ? "bg-down-soft text-down" : inc.status === "ack" ? "bg-blocked-soft text-blocked" : "bg-run-soft text-run",
          )}
        >
          {inc.status === "resolved" ? <CircleCheck className="size-3.5" aria-hidden /> : <OctagonAlert className="size-3.5" aria-hidden />}
          {STATUS[inc.status]}
        </span>
        <span className="text-ink-3">
          {AREA[inc.area ?? ""] ?? "Линия"} · {time(inc.created_at)}
        </span>
      </div>
      <h2 className="text-[1.35rem] leading-snug font-medium">{inc.title}</h2>
      {inc.reported_by && (
        <div className="flex gap-3 rounded-[16px] border border-line bg-panel px-4 py-3">
          <MessageSquareQuote className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="text-ink-2">«{inc.details}»</p>
            <p className="mt-1 text-xs text-ink-3">
              {inc.reported_by}
              {inc.acked_by && ` · принял ${inc.acked_by}`}
            </p>
          </div>
        </div>
      )}
      {!inc.reported_by && <p className="text-sm text-ink-2">{inc.details}</p>}
      {inc.resolution && (
        <p className="rounded-[14px] bg-run-soft px-4 py-2.5 text-sm text-run">
          <b>Что сделано:</b> {inc.resolution}
          {inc.resolved_by && ` — ${inc.resolved_by}`}
        </p>
      )}
    </header>
  );
}

function LossHero({ inc, im, loading }: { inc?: Incident; im?: Impact; loading: boolean }) {
  const floor = useFloor();
  const stops = im?.line_stops ?? inc?.line_stopped ?? false;
  const perMin = im?.cost_per_min_kzt ?? 112_500;
  const elapsed = useMemo(() => {
    if (!inc || !floor?.clock) return 0;
    const end = inc.resolved_at ?? floor.clock;
    return Math.max(0, (new Date(end).getTime() - new Date(inc.created_at).getTime()) / 60000);
  }, [inc, floor?.clock]);
  const lost = stops ? elapsed * perMin : 0;
  return (
    <section className="panel-deep relative overflow-hidden rounded-[22px] px-5 py-5 sm:px-6">
      <div className="flex items-center gap-2 text-[0.8125rem] font-semibold text-deep-ink-2">
        <Timer className="size-4 text-brand-2" aria-hidden />
        {stops
          ? inc?.status === "resolved"
            ? `Линия простояла ${num(elapsed)} мин`
            : elapsed < 1
              ? "Линия стоит меньше минуты"
              : `Линия стоит ${num(elapsed)} ${plural(Math.round(elapsed), "минуту", "минуты", "минут")}`
          : "Линия работает"}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-1">
        <span className="display num text-[clamp(2.4rem,9vw,3.4rem)] leading-none font-light tracking-[-0.03em] text-white">{stops ? kzt(lost) : kzt(im?.lost_kzt ?? 0)}</span>
        <span className="pb-1 text-sm text-deep-ink-2">{stops ? "уже упущено" : "потери к концу смены"}</span>
      </div>
      <p className="mt-3 text-sm text-deep-ink-2">
        Минута остановки линии — <b className="text-white">{kzt(perMin)}</b>: за такт {num1(im?.takt_min ?? 4)} мин линия выпускает один автомобиль.
      </p>
      {loading && (
        <p className="mt-3 inline-flex items-center gap-2 text-xs text-white/70">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Прогоняю копию линии до конца смены…
        </p>
      )}
    </section>
  );
}

function Outcome({ im }: { im: Impact }) {
  const tiles = [
    { label: "Потеря к концу смены", value: `${num1(im.lost_cars ?? 0)} авто`, note: kzt(im.lost_kzt ?? 0), bad: (im.lost_cars ?? 0) >= 1 },
    { label: "Прогноз смены", value: `${im.plan_expected} из ${im.plan}`, note: `без проблемы — ${im.plan_without}`, bad: (im.plan_expected ?? 0) < im.plan },
    { label: "Вероятность плана", value: `${im.plan_probability}%`, note: `${im.minutes_left} мин до конца смены`, bad: (im.plan_probability ?? 0) < 50 },
  ];
  return (
    <section className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-[16px] border border-line bg-panel px-4 py-3">
          <div className="text-xs text-ink-3">{t.label}</div>
          <div className={clsx("display num mt-1 text-[1.45rem] font-light", t.bad ? "text-down" : "text-ink")}>{t.value}</div>
          <div className="text-xs text-ink-3">{t.note}</div>
        </div>
      ))}
    </section>
  );
}

function Runway({ im }: { im: Impact }) {
  const d = im.runway?.downstream;
  const u = im.runway?.upstream;
  if (!im.line_stops || (!d && !u)) return null;
  return (
    <section className="space-y-2">
      {d && (
        <div className="flex items-start gap-3 rounded-[16px] bg-down-soft px-4 py-3 text-sm">
          <TrendingDown className="mt-0.5 size-4 shrink-0 text-down" aria-hidden />
          <p>
            <b>{d.name}</b> встанет через ~{Math.max(1, Math.round(d.minutes))} мин: в буфере {d.bodies} {plural(d.bodies, "кузов", "кузова", "кузовов")}.
          </p>
        </div>
      )}
      {u && u.minutes != null && (
        <div className="flex items-start gap-3 rounded-[16px] bg-blocked-soft px-4 py-3 text-sm">
          <Hand className="mt-0.5 size-4 shrink-0 text-blocked" aria-hidden />
          <p>
            <b>{u.name}</b> упрётся в полный буфер через ~{Math.max(1, Math.round(u.minutes))} мин (свободно мест: {u.free}).
          </p>
        </div>
      )}
    </section>
  );
}

function Options({ im }: { im: Impact }) {
  const opts = im.options ?? [];
  if (!opts.length) return null;
  const best = opts.find((o) => o.net_kzt > 0);
  return (
    <section>
      <h3 className="text-[0.95rem] font-semibold">Что делать</h3>
      <p className="mb-2 text-xs text-ink-3">Каждый вариант проверен на копии линии. Чистый эффект — за вычетом затрат.</p>
      <ul className="space-y-2">
        {opts.map((o) => (
          <li key={o.id} className={clsx("rounded-[16px] border px-4 py-3", o === best ? "border-brand bg-brand-soft/60" : "border-line bg-panel")}>
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Wrench className="size-4 text-ink-3" aria-hidden />
                {o.title}
                {o === best && <span className="rounded-full bg-brand px-2 py-0.5 text-2xs font-bold text-white">рекомендуем</span>}
              </span>
              <span className={clsx("num text-sm font-bold", o.net_kzt > 0 ? "text-run" : "text-down")}>
                {o.net_kzt > 0 ? "+" : "−"}
                {kzt(Math.abs(o.net_kzt))}
              </span>
            </div>
            <p className="mt-1 text-[0.8125rem] text-ink-2">{o.action}</p>
            <p className="mt-1 text-xs text-ink-3">
              Сохранит {num1(o.cars)} авто{o.cost_kzt ? ` · затраты ${kzt(o.cost_kzt)}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Footer({ inc }: { inc: Incident }) {
  const s = useSession();
  const act = useIncidentActions();
  const [closing, setClosing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setClosing(false), [inc.id]);
  const operate = can(s, "operate");
  const pdf = async () => {
    setBusy(true);
    try {
      await download(`/documents/incident/${inc.id}.pdf`, `akt_${inc.id}.pdf`);
    } catch (e) {
      toast({ title: "Не удалось сформировать акт", body: (e as Error).message, tone: "down" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <footer className="sticky bottom-0 border-t border-line bg-panel/95 px-5 py-3 backdrop-blur sm:px-6">
      {closing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            act.resolve.mutate(
              { id: inc.id, resolution: text.trim() || undefined },
              {
                onSuccess: () => toast({ title: "Решено", body: "Рабочий видит, что проблема закрыта. Станок снова работает и в модели цеха.", tone: "run" }),
              },
            );
            setClosing(false);
          }}
        >
          <label className="block text-[0.8125rem] font-semibold text-ink-2" htmlFor="resolution">
            Что сделано
          </label>
          <textarea
            id="resolution"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="Например: заменён фильтр насоса подачи краски"
            className="w-full resize-none rounded-[12px] border border-line-strong bg-sunken px-3 py-2 text-sm focus:border-accent focus:bg-panel focus:outline-none"
          />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={act.resolve.isPending} icon={<CircleCheck className="size-4" />}>
              Закрыть проблему
            </Button>
            <Button variant="ghost" onClick={() => setClosing(false)}>
              Отмена
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {operate && inc.status === "open" && (
            <Button variant="primary" loading={act.ack.isPending} onClick={() => act.ack.mutate(inc.id, { onSuccess: () => toast({ title: "Принято в работу", body: `${inc.reported_by ?? "Участок"} видит, что вы приняли сообщение.`, tone: "run" }) })}>
              Принять в работу
            </Button>
          )}
          {operate && inc.status !== "resolved" && (
            <Button variant={inc.status === "ack" ? "primary" : "secondary"} onClick={() => setClosing(true)} icon={<CircleCheck className="size-4" />}>
              Решено
            </Button>
          )}
          <Button variant="ghost" loading={busy} onClick={pdf} icon={<FileDown className="size-4" />} className="ml-auto" title="Акт об инциденте в PDF">
            <span className="hidden sm:inline">Акт PDF</span>
            <span className="sm:hidden">PDF</span>
          </Button>
        </div>
      )}
    </footer>
  );
}

export function AlertStrip() {
  const { alerts: list } = useAlerts();
  if (!list.length) return null;
  const a = list[0];
  return (
    <div className="mx-auto mt-3 max-w-[1600px] px-3 sm:px-5" role="alert">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[20px] border-2 border-down bg-panel px-4 py-3 shadow-[var(--shadow-float)] [animation:alarm_1.6s_ease-in-out_infinite]">
        <span className="relative grid size-9 shrink-0 place-items-center rounded-full bg-down text-white">
          <OctagonAlert className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">
            {AREA[a.area ?? ""] ?? "Участок"}: {a.title}
          </div>
          <div className="truncate text-[0.8125rem] text-ink-2">
            {a.reported_by} · {time(a.created_at)} · «{a.details}»{list.length > 1 && ` · ещё ${list.length - 1}`}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => alerts.open(a.id)}>
            Анализ за минуту
          </Button>
          <Button variant="ghost" size="sm" onClick={() => alerts.dismiss(a.id)}>
            Скрыть
          </Button>
        </div>
      </div>
    </div>
  );
}
