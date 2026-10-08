import { clsx } from "clsx";
import { ArrowUpRight, Box as BoxIcon, HardHat, PackageX, RefreshCw, Sparkles, UserRound, Workflow, Wrench, Zap } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { useDemoProblem, useFloorControl, useFloorLayout, useFloorSnapshot, useIncidents, useMe, usePlant, useShiftForecast } from "@/shared/api/queries";
import { alerts } from "@/shared/alerts/store";
import { SimLog, SimPlayer, SimResultPanel } from "@/features/sim/SimPanels";
import type { Floor, Incident, SandboxResult, ShiftForecast } from "@/shared/api/types";
import { LineChart } from "@/shared/charts/charts";
import { AREA_STATE, EQ_STATUS, STATE_COLOR, kzt, num, num1, pct, time } from "@/shared/lib/format";
import { seedFloor, useFloor } from "@/shared/realtime/live";
import { sim, useSim } from "@/shared/sim/store";
import { Button } from "@/shared/ui/Button";
import { CountUp } from "@/shared/ui/CountUp";
import { Field, Select } from "@/shared/ui/Field";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { Dot } from "@/shared/ui/Status";
import { toast } from "@/shared/ui/Toaster";
import { AreaDrawer } from "./AreaDrawer";
import { EquipmentDrawer } from "./EquipmentDrawer";
import { IsoPlant } from "./IsoPlant";
import { type FloorProject, LiveSchema, useFloorProject } from "./LiveSchema";

type FloorView = "iso" | "schema";
const VIEW_KEY = "allur.floor.view";
const readView = (): FloorView => {
  try {
    return localStorage.getItem(VIEW_KEY) === "schema" ? "schema" : "iso";
  } catch {
    return "iso";
  }
};

export function FloorPage() {
  const snapshot = useFloorSnapshot();
  const live = useFloor();
  const plant = usePlant();
  const layout = useFloorLayout();
  const fp = useFloorProject(plant.data, layout.data);
  const forecast = useShiftForecast();
  const s = useSim();
  const [selected, setSelected] = useState<string | null>(null);
  const [area, setArea] = useState<string | null>(null);
  const [view, setViewState] = useState<FloorView>(readView);
  const setView = (v: FloorView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
    }
  };

  useEffect(() => {
    if (snapshot.data) seedFloor(snapshot.data);
  }, [snapshot.data]);

  const r = s.result;
  const frame = r ? r.frames[Math.floor(s.playhead)] : null;
  const floor = frame ?? live ?? snapshot.data ?? null;
  if (snapshot.error && !floor) return <ErrorNote error={snapshot.error} />;
  if (!floor || !floor.ready || !plant.data || !fp) return <FloorSkeleton />;
  const ownScheme = fp.custom && !fp.standard;

  const simEnd = r ? shiftEndOf(r, floor) : null;

  return (
    <div className="grid grid-cols-12 gap-4" style={{ "--frame-ms": r ? `${sim.frameMs()}ms` : "500ms" } as CSSProperties}>
      {r && <SimPlayer r={r} />}
      <ShiftHero floor={floor} expected={r ? simEnd : forecast.data?.available ? forecast.data.expected : null} sim={!!r} />
      <StatTiles floor={floor} forecast={forecast.data} sim={r} />

      <Panel
        tone="deep"
        i={5}
        className="col-span-12"
        title={r ? `Цех в симуляции · ${time(floor.clock)}` : "Цех сейчас"}
        hint={
          r
            ? "Это запись симуляции: кузова, отказы и буферы — как они будут при введённых событиях. Живой цех идёт отдельно."
            : view === "schema"
              ? "Тот же цех схемой узлов, как в конструкторе: состояние участков, буферов и оборудования. Нажмите на узел — откроются его цифры."
              : "Кузова едут в своих настоящих цветах. Нажмите на робота или привод — откроется риск отказа; на карточку участка или склада — его цифры и оборудование."
        }
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {view === "iso" && !ownScheme && <Legend />}
            <div role="radiogroup" aria-label="Вид цеха" className="flex rounded-full bg-white/10 p-1">
              {(
                [
                  ["iso", "3D цех", <BoxIcon key="i" className="size-3.5" aria-hidden />],
                  ["schema", "Схема узлов", <Workflow key="s" className="size-3.5" aria-hidden />],
                ] as const
              ).map(([v, l, icon]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={view === v}
                  onClick={() => setView(v)}
                  className={clsx(
                    "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-semibold transition-colors",
                    view === v ? "bg-white text-ink" : "text-white/70 hover:text-white",
                  )}
                >
                  {icon}
                  {l}
                </button>
              ))}
            </div>
            {!r && (
              <Link
                to="/app/sim"
                className="inline-flex h-9 items-center gap-2 rounded-full bg-brand px-4 text-sm font-semibold text-white shadow-[0_8px_20px_-10px_rgb(227_36_27/0.9)] hover:bg-brand-2"
              >
                <Sparkles className="size-4" aria-hidden /> Смоделировать событие
              </Link>
            )}
          </div>
        }
        bodyClass="px-3 pt-2 pb-4 sm:px-4"
      >
        {view === "schema" ? (
          <>
            <LiveSchema floor={floor} fp={fp} onArea={setArea} />
            <SchemeNote fp={fp} layoutId={layout.data?.id ?? null} sim={!!r} />
          </>
        ) : ownScheme ? (
          <>
            <LiveSchema floor={floor} fp={fp} onArea={setArea} view="3d" />
            <SchemeNote fp={fp} layoutId={layout.data?.id ?? null} sim={!!r} />
          </>
        ) : (
          <IsoPlant floor={floor} onEquipment={setSelected} onArea={setArea} selected={selected} />
        )}
        <EquipmentStrip floor={floor} onEquipment={setSelected} selected={selected} />
      </Panel>

      {r ? (
        <>
          <SimResultPanel r={r} className="col-span-12 xl:col-span-7" />
          <SimLog r={r} className="col-span-12 xl:col-span-5" />
        </>
      ) : (
        <>
          <ForecastPanel f={forecast.data} loading={forecast.isFetching} refresh={() => forecast.refetch()} />
          <ShiftEvents />
          <DemoControls floor={floor} />
        </>
      )}
      <RecentCars floor={floor} wide={!!r} />
      <AreaDrawer
        code={area}
        floor={floor}
        onClose={() => setArea(null)}
        onEquipment={(c) => {
          setArea(null);
          setSelected(c);
        }}
      />
      <EquipmentDrawer code={selected} floor={floor} onClose={() => setSelected(null)} />
    </div>
  );
}

function SchemeNote({ fp, layoutId, sim: inSim }: { fp: FloorProject; layoutId: number | null; sim: boolean }) {
  const extra = fp.extra.length;
  return (
    <p className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-deep-ink-2">
      <span>
        Схема цеха: <b className="font-semibold text-white">«{fp.name}»</b>
        {extra > 0 && ` · ${extra} новых узлов считает модель схемы`}. Состояние участков — из живого цеха
        {inSim ? " (сейчас — из записи симуляции)" : ""}.
      </span>
      <Link to={layoutId ? `/app/builder?project=${layoutId}` : "/app/builder"} className="inline-flex items-center gap-1 font-semibold text-white hover:underline">
        Изменить схему цеха <ArrowUpRight className="size-3.5" aria-hidden />
      </Link>
    </p>
  );
}

function shiftEndOf(r: SandboxResult, floor: Floor): number | null {
  const n = floor.shift.number;
  for (let i = r.frames.length - 1; i >= 0; i--) {
    if (r.frames[i].shift.number === n) return r.frames[i].kpi.finished;
  }
  return null;
}

function EquipmentStrip({ floor, onEquipment, selected }: { floor: Floor; onEquipment: (c: string) => void; selected: string | null }) {
  const groups = floor.areas.filter((a) => a.kind !== "store");
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {groups.map((a) => (
        <div key={a.code} className="rounded-[14px] bg-white/[0.04] p-2.5">
          <p className="px-1 text-[11px] font-semibold text-deep-ink-2">{a.name}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {floor.equipment
              .filter((e) => e.area === a.code)
              .map((e) => {
                const bad = e.status === "down" || e.status === "maint";
                return (
                  <button
                    key={e.code}
                    type="button"
                    onClick={() => onEquipment(e.code)}
                    title={`${e.code}: ${EQ_STATUS[e.status].toLowerCase()}`}
                    className={clsx(
                      "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-semibold transition-colors",
                      selected === e.code ? "bg-white text-ink" : bad ? "bg-down/25 text-white ring-1 ring-down/70" : "bg-white/[0.06] text-white/80 hover:bg-white/12",
                    )}
                  >
                    <span className={clsx("size-1.5 rounded-full", bad && "animate-[blink_1s_ease-in-out_infinite]")} style={{ background: STATE_COLOR[e.status] }} />
                    {e.code}
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ShiftHero({ floor, expected: expectedCars, sim: inSim }: { floor: Floor; expected: number | null; sim: boolean }) {
  const k = floor.kpi;
  const ahead = k.finished - k.plan_to_now;
  const done = Math.min(100, (k.finished / k.shift_plan) * 100);
  const expected = expectedCars != null ? Math.min(100, (expectedCars / k.shift_plan) * 100) : null;
  const planNow = Math.min(100, (k.plan_to_now / k.shift_plan) * 100);
  return (
    <section className="panel rise col-span-12 flex flex-col justify-between gap-6 p-6 lg:col-span-6 xl:col-span-5" style={{ "--i": 0 } as CSSProperties}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">{floor.working ? `Смена ${floor.shift.number}, ${time(floor.shift.start)}–${time(floor.shift.end)}` : "Смена не идёт"}</p>
          <p className="mt-1 text-sm text-ink-2">{inSim ? "Выпущено к этому моменту симуляции" : "Выпущено автомобилей"}</p>
        </div>
        {floor.working && (
          <span className={clsx("rounded-full px-3 py-1 text-xs font-bold", ahead >= 0 ? "bg-run-soft text-run" : "bg-down-soft text-down")}>
            {ahead >= 0 ? "+" : "−"}
            {Math.abs(ahead)} к плану на {time(floor.clock)}
          </span>
        )}
      </div>
      <div className="flex items-end gap-3">
        <span className="display num text-[clamp(4.5rem,8vw,6.5rem)] leading-[0.85] font-extralight tracking-[-0.04em]">
          <CountUp value={k.finished} />
        </span>
        <span className="display pb-2 text-2xl font-light text-ink-3">/ {k.shift_plan}</span>
      </div>
      <div>
        <div className="relative h-3 overflow-hidden rounded-full bg-sunken" aria-hidden>
          {expected != null && <div className="absolute inset-y-0 left-0 rounded-full bg-brand/20 transition-[width] duration-700" style={{ width: `${expected}%` }} />}
          <div className="absolute inset-y-0 left-0 rounded-full bg-deep transition-[width] duration-700" style={{ width: `${done}%` }} />
          <div className="absolute inset-y-0 w-0.5 bg-brand" style={{ left: `${planNow}%` }} />
        </div>
        <div className="mt-2.5 flex flex-wrap justify-between gap-2 text-xs font-semibold text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-deep" /> факт
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-0.5 bg-brand" /> план к этому часу
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-brand/30" />
            {expectedCars != null ? `${inSim ? "в симуляции" : "прогноз"} ${expectedCars} к ${time(floor.shift.end)}` : "прогноз появится в смену"}
          </span>
        </div>
      </div>
    </section>
  );
}

function Tile({ i, label, children, note, tone = "light", className }: { i: number; label: string; children: ReactNode; note?: ReactNode; tone?: "light" | "deep" | "alert" | "brand"; className?: string }) {
  return (
    <section
      className={clsx(
        "rise flex flex-col justify-between gap-4 p-5",
        tone === "deep" ? "panel-deep" : tone === "brand" ? "panel-deep bg-brand" : "panel",
        tone === "alert" && "ring-2 ring-down/40",
        className,
      )}
      style={{ "--i": i } as CSSProperties}
    >
      <span className={clsx("eyebrow", tone === "deep" && "text-deep-ink-2", tone === "brand" && "text-white/80")}>{label}</span>
      <div className="display num text-[2.6rem] leading-none font-light tracking-[-0.03em]">{children}</div>
      {note && <div className={clsx("text-xs font-semibold", tone === "deep" ? "text-deep-ink-2" : tone === "brand" ? "text-white/80" : "text-ink-3")}>{note}</div>}
    </section>
  );
}

function StatTiles({ floor, forecast, sim: r }: { floor: Floor; forecast?: ShiftForecast; sim: SandboxResult | null }) {
  const k = floor.kpi;
  const down = floor.equipment.filter((e) => e.status === "down" || e.status === "maint");
  const area = floor.areas.find((a) => a.code === k.bottleneck);
  return (
    <div className="col-span-12 grid grid-cols-2 gap-4 lg:col-span-6 xl:col-span-7 xl:grid-cols-4">
      <Tile i={1} label="Брак в смене" note={<span className={k.defect_pct > 2 ? "text-down" : "text-run"}>{k.defect_pct > 2 ? "выше нормы 2%" : "в норме"}</span>}>
        <CountUp value={k.defect_pct} format={(v) => pct(v)} />
      </Tile>
      {r ? (
        <Tile i={2} label="Цена событий" tone={r.summary.mean.lost >= 0.5 ? "alert" : "light"} note={r.summary.mean.lost >= 0.5 ? `≈ −${num1(r.summary.mean.lost)} авто за окно` : "выпуск почти не страдает"}>
          <span className="text-[2rem]">{kzt(r.summary.money_kzt)}</span>
        </Tile>
      ) : (
        <Tile i={2} label="Вероятность плана" note={forecast?.available ? `${forecast.low}–${forecast.high} авто к концу смены` : "считается в смену"}>
          {forecast?.available ? <CountUp value={forecast.probability} format={(v) => `${Math.round(v)}%`} /> : "—"}
        </Tile>
      )}
      <Tile i={3} label="Оборудование в отказе" tone={down.length ? "alert" : "light"} note={down.length ? down.map((d) => d.code).join(", ") : "всё работает"}>
        <span className={down.length ? "text-down" : undefined}>{down.length}</span>
      </Tile>
      <Tile i={4} label="Ограничивает выпуск" tone="brand" note="участок без пауз дольше всех">
        <span className="text-[1.9rem]">{area?.name ?? "—"}</span>
      </Tile>
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["run", AREA_STATE.run],
    ["starved", AREA_STATE.starved],
    ["blocked", AREA_STATE.blocked],
    ["down", AREA_STATE.down],
    ["maint", EQ_STATUS.maint],
  ];
  return (
    <ul className="hidden flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-deep-ink-2 md:flex">
      {items.map(([k, l]) => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <Dot color={STATE_COLOR[k]} />
          {l}
        </li>
      ))}
    </ul>
  );
}

function ForecastPanel({ f, loading, refresh }: { f?: ShiftForecast; loading: boolean; refresh: () => void }) {
  const wrap = "col-span-12 xl:col-span-7";
  if (!f) return <Skeleton className={clsx(wrap, "h-80")} />;
  if (!f.available)
    return (
      <Panel i={6} className={wrap} title="Прогноз до конца смены">
        <p className="text-sm text-ink-2">Смена не идёт — прогноз появится с началом следующей смены.</p>
      </Panel>
    );
  const good = f.probability >= 70;
  return (
    <Panel
      i={6}
      className={wrap}
      title="Прогноз до конца смены"
      hint={`Копия линии в текущем состоянии ${f.runs} раз проматывается до ${time(f.end)}. Живой цех при этом не меняется.`}
      actions={
        <Button size="sm" variant="ghost" icon={<RefreshCw className={clsx("size-4", loading && "animate-spin")} />} onClick={refresh}>
          Пересчитать
        </Button>
      }
    >
      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <dl className="grid grid-cols-2 gap-4 self-start md:grid-cols-1">
          <div className="rounded-[16px] bg-sunken p-4">
            <dt className="eyebrow">Выйдет к {time(f.end)}</dt>
            <dd className="display num mt-1 text-[2.4rem] leading-none font-light">{num(f.expected)}</dd>
            <dd className="num mt-1 text-xs text-ink-3">
              от {f.low} до {f.high}, сейчас {f.finished_now}
            </dd>
          </div>
          <div className="rounded-[16px] bg-sunken p-4">
            <dt className="eyebrow">План {f.plan}</dt>
            <dd className={clsx("display num mt-1 text-[2.4rem] leading-none font-light", good ? "text-run" : "text-down")}>{f.probability}%</dd>
            <dd className="mt-1 text-xs text-ink-3">
              брак ~{num1(f.defects_expected)}, простой ~{f.downtime_expected_min} мин
            </dd>
          </div>
        </dl>
        <LineChart
          labels={f.timeline.map((p) => time(p.t))}
          series={[{ name: "Прогноз выпуска", color: "var(--color-brand)", values: f.timeline.map((p) => p.mean) }]}
          band={{ low: f.timeline.map((p) => p.low), high: f.timeline.map((p) => p.high), color: "var(--color-brand)" }}
          target={{ value: f.plan, label: `план ${f.plan}` }}
          format={(v) => num(v)}
          height={230}
        />
      </div>
    </Panel>
  );
}

const SEV = {
  critical: { color: "var(--color-down)", bg: "bg-down-soft", label: "Авария" },
  warning: { color: "var(--color-blocked)", bg: "bg-blocked-soft", label: "Отклонение" },
  info: { color: "var(--color-maint)", bg: "bg-maint-soft", label: "Плановое" },
};

function ShiftEvents() {
  const q = useIncidents("", "");
  const items = q.data?.items.slice(0, 4) ?? [];
  return (
    <Panel
      i={7}
      className="col-span-12 xl:col-span-5"
      title="События"
      hint="Сообщения рабочих с участков и то, что система заметила сама: отказы, брак, поставки"
      actions={
        <Link to="/app/incidents" className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-semibold text-ink-2 hover:bg-sunken hover:text-ink">
          Все <ArrowUpRight className="size-4" aria-hidden />
        </Link>
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-48" />
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-2">За смену событий не было.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {items.map((i) => (
            <EventRow key={i.id} i={i} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function EventRow({ i }: { i: Incident }) {
  const active = i.status !== "resolved";
  const s = SEV[i.severity];
  const worker = i.source === "worker";
  return (
    <li>
      <button type="button" onClick={() => alerts.open(i.id)} className={clsx("flex w-full gap-3 rounded-[16px] p-3 text-left transition-colors hover:ring-2 hover:ring-line-strong", active ? s.bg : "bg-sunken")}>
      <span className="mt-1 shrink-0">
        {worker ? (
          <span className="grid size-6 place-items-center rounded-full bg-brand text-white" title="Сообщение с участка">
            <UserRound className="size-3.5" aria-hidden />
          </span>
        ) : (
          <Dot color={s.color} pulse={active && i.severity === "critical"} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-bold">{i.title}</span>
          <span className="num shrink-0 text-xs font-semibold text-ink-3">{time(i.created_at)}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-[0.8125rem] text-ink-2">{worker ? `«${i.details}» — ${i.reported_by}` : i.details}</p>
        <p className="mt-1 text-xs font-semibold text-ink-3">
          {s.label} · {active ? (i.status === "ack" ? `в работе${i.acked_by ? ` · ${i.acked_by}` : ""}` : "ждёт реакции") : i.downtime_min != null ? `решено, ${Math.round(i.downtime_min)} мин` : "решено"}
          {active && <span className="ml-1 text-accent">· анализ потерь →</span>}
        </p>
      </div>
      </button>
    </li>
  );
}

function DemoControls({ floor }: { floor: Floor }) {
  const me = useMe();
  const plant = usePlant();
  const ctl = useFloorControl();
  const [eq, setEq] = useState("Конвейер-03");
  const [minutes, setMinutes] = useState(40);
  const canOperate = me.data?.permissions.includes("operate");
  const status = floor.equipment.find((e) => e.code === eq)?.status;
  const isDown = status === "down" || status === "maint";

  return (
    <Panel
      i={8}
      className="col-span-12 lg:col-span-6 xl:col-span-5"
      title="Событие в живом цехе"
      hint="Остановите оборудование прямо сейчас — двойник сам заведёт инцидент и пересчитает прогноз. Чтобы сначала посмотреть последствия, не трогая цех, — смоделируйте."
    >
      {!canOperate ? (
        <p className="text-sm text-ink-2">Доступно диспетчеру и администратору.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <Field label="Оборудование">
              <Select value={eq} onChange={(e) => setEq(e.target.value)}>
                {(plant.data?.equipment ?? []).map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.code} — {o.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Минут">
              <Select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {[10, 20, 40, 55, 90].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            {isDown ? (
              <Button
                variant="deep"
                icon={<Wrench className="size-4" />}
                loading={ctl.repair.isPending}
                onClick={() => ctl.repair.mutate(eq, { onSuccess: () => toast({ title: `${eq}: ремонт завершён`, tone: "run" }) })}
              >
                Завершить ремонт
              </Button>
            ) : (
              <Button variant="primary" icon={<Zap className="size-4" />} loading={ctl.fail.isPending} onClick={() => ctl.fail.mutate({ equipment: eq, minutes })}>
                Остановить {eq}
              </Button>
            )}
            <Button icon={<PackageX className="size-4" />} loading={ctl.supply.isPending} onClick={() => ctl.supply.mutate(60)}>
              Задержать поставку
            </Button>
            <Link
              to={`/app/sim?eq=${encodeURIComponent(eq)}`}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-line-strong bg-panel px-5 text-sm font-semibold hover:border-ink-3"
            >
              <Sparkles className="size-4 text-brand" aria-hidden /> Смоделировать
            </Link>
          </div>
          <DemoReport />
          {!floor.working && <p className="text-xs text-ink-3">Сейчас нерабочее время — событие сработает со следующей смены.</p>}
        </div>
      )}
    </Panel>
  );
}

function DemoReport() {
  const demo = useDemoProblem();
  return (
    <div className="rounded-[16px] border border-dashed border-line-strong px-4 py-3">
      <p className="text-[0.8125rem] text-ink-2">
        <b>Сценарий для показа:</b> оператор окраски сообщает с телефона, что Камера-02 встала. Начальник смены получает тревогу и за минуту видит, во что обойдётся остановка.
      </p>
      <Button
        size="sm"
        className="mt-2"
        icon={<HardHat className="size-4" />}
        loading={demo.isPending}
        onClick={() =>
          demo.mutate(undefined, {
            onSuccess: (r) => alerts.push(r.incident),
            onError: (e) => toast({ title: "Не получилось", body: e.message, tone: "down" }),
          })
        }
      >
        Показать: сообщение с участка
      </Button>
    </div>
  );
}

function RecentCars({ floor, wide }: { floor: Floor; wide?: boolean }) {
  const models = Object.entries(floor.kpi.models);
  const total = models.reduce((s, [, v]) => s + v, 0) || 1;
  return (
    <Panel i={9} className={wide ? "col-span-12" : "col-span-12 lg:col-span-6 xl:col-span-7"} title="Сошли с линии" hint={`За смену ${floor.kpi.finished}, на переделку ${floor.kpi.rework}`}>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          {models.map(([m, v]) => (
            <div key={m}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-semibold">{m}</span>
                <span className="display num text-lg font-light">{v}</span>
              </div>
              <div className="mt-1.5 h-2 rounded-full bg-sunken">
                <div className="h-full rounded-full bg-deep transition-[width] duration-700" style={{ width: `${(v / total) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
        <ul className="flex flex-col gap-1.5">
          {floor.recent.slice(0, 5).map((r, n) => (
            <li
              key={r.vin}
              className="flex items-center justify-between gap-3 rounded-[12px] bg-sunken px-3 py-2 text-[0.8125rem]"
              style={n === 0 ? { animation: "fade-up .4s var(--ease-out)" } : undefined}
            >
              <span className="display font-medium tracking-wide">{r.vin}</span>
              <span className="truncate text-ink-3">{r.model.replace("Chevrolet ", "")}</span>
              <span className="num font-semibold text-ink-2">{time(r.at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function FloorSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-4">
      <Skeleton className="col-span-12 h-60 xl:col-span-5" />
      <Skeleton className="col-span-12 h-60 xl:col-span-7" />
      <Skeleton className="col-span-12 h-[420px]" />
    </div>
  );
}
