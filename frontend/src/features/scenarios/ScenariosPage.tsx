import { clsx } from "clsx";
import { Play } from "lucide-react";
import { useState } from "react";
import { useInsights, useMe, usePlant, usePresets, useRunScenario } from "@/shared/api/queries";
import type { Preset, ScenarioInput, WhatIfResult } from "@/shared/api/types";
import { LineChart } from "@/shared/charts/charts";
import { kzt, num, num1 } from "@/shared/lib/format";
import { Button } from "@/shared/ui/Button";
import { Field, Input, Select } from "@/shared/ui/Field";
import { Empty, ErrorNote, Panel } from "@/shared/ui/Panel";

interface Form {
  stopEq: string;
  stopAt: number;
  stopMin: number;
  paintFaster: number;
  weldBuffer: number;
  paintDefect: string;
  supply: number;
  overtime: number;
}

const EMPTY: Form = { stopEq: "", stopAt: 150, stopMin: 55, paintFaster: 0, weldBuffer: 6, paintDefect: "", supply: 0, overtime: 0 };

function fromPreset(p: Preset): Form {
  const s = p.scenario;
  const stop = s.stops?.[0];
  return {
    ...EMPTY,
    stopEq: stop?.equipment ?? "",
    stopAt: stop?.at_min ?? EMPTY.stopAt,
    stopMin: stop?.minutes ?? EMPTY.stopMin,
    paintFaster: s.cycle_factor?.PAINT ? Math.round((1 - s.cycle_factor.PAINT) * 100) : 0,
    weldBuffer: s.buffer_override?.WELD ?? 6,
    paintDefect: s.defect_pct?.PAINT != null ? String(s.defect_pct.PAINT) : "",
    supply: s.supply_delay?.[1] ?? 0,
    overtime: s.overtime_min ?? 0,
  };
}

function toScenario(f: Form): ScenarioInput {
  return {
    stops: f.stopEq ? [{ equipment: f.stopEq, at_min: f.stopAt, minutes: f.stopMin, shift: 1 }] : [],
    cycle_factor: f.paintFaster ? { PAINT: 1 - f.paintFaster / 100 } : {},
    buffer_override: f.weldBuffer !== 6 ? { WELD: f.weldBuffer } : {},
    defect_pct: f.paintDefect !== "" ? { PAINT: Number(f.paintDefect) } : {},
    supply_delay: f.supply ? [60, f.supply] : null,
    overtime_min: f.overtime,
  };
}

export function ScenariosPage() {
  const presets = usePresets();
  const plant = usePlant();
  const insights = useInsights();
  const me = useMe();
  const run = useRunScenario();
  const [form, setForm] = useState<Form>(EMPTY);
  const [active, setActive] = useState<string | null>(null);
  const canRun = me.data?.permissions.includes("operate");
  const paintNow = insights.data?.quality.find((q) => q.area === "PAINT")?.level;

  const launch = (f: Form) => run.mutate({ scenario: toScenario(f), runs: 6 });
  const choose = (p: Preset) => {
    const f = fromPreset(p);
    setForm(f);
    setActive(p.id);
    if (canRun) launch(f);
  };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setActive(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[80ch] text-sm text-ink-2">
        Модель линии проживает следующий рабочий день (две смены) шесть раз с тем же случайным потоком событий — сначала как обычно,
        потом с вашим изменением. Разница — это эффект изменения, а не случайность.
      </p>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Panel title="Готовые сценарии">
            <ul className="flex flex-col gap-2">
              {presets.data?.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => choose(p)}
                    aria-pressed={active === p.id}
                    className={clsx(
                      "w-full rounded-[14px] border px-3.5 py-2.5 text-left transition-colors",
                      active === p.id ? "border-ink bg-panel shadow-[inset_0_0_0_1px_var(--color-ink)]" : "border-line bg-sunken hover:border-ink-3",
                    )}
                  >
                    <span className="block text-sm font-medium">{p.title}</span>
                    <span className="mt-0.5 block text-[0.8125rem] text-ink-2">{p.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Свой сценарий" hint="Можно сочетать несколько изменений">
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                launch(form);
              }}
            >
              <div className="grid grid-cols-[minmax(0,1fr)_6rem_6rem] gap-3">
                <Field label="Остановка оборудования">
                  <Select value={form.stopEq} onChange={(e) => set("stopEq", e.target.value)}>
                    <option value="">Без остановки</option>
                    {plant.data?.equipment.map((e) => (
                      <option key={e.code} value={e.code}>
                        {e.code}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Во сколько">
                  <Select value={form.stopAt} disabled={!form.stopEq} onChange={(e) => set("stopAt", Number(e.target.value))}>
                    {[30, 90, 150, 240, 360].map((m) => (
                      <option key={m} value={m}>
                        {String(8 + Math.floor(m / 60)).padStart(2, "0")}:{String(m % 60).padStart(2, "0")}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Минут">
                  <Input type="number" min={5} max={480} value={form.stopMin} disabled={!form.stopEq} onChange={(e) => set("stopMin", Number(e.target.value))} />
                </Field>
              </div>
              <Field label={`Ускорить окраску: ${form.paintFaster}%`} hint="Сокращение цикла узкого места">
                <input type="range" min={0} max={10} step={1} value={form.paintFaster} onChange={(e) => set("paintFaster", Number(e.target.value))} className="accent-[var(--color-ink)]" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Буфер перед окраской">
                  <Input type="number" min={1} max={40} value={form.weldBuffer} onChange={(e) => set("weldBuffer", Number(e.target.value))} />
                </Field>
                <Field label="Брак окраски, %" hint={paintNow ? `сейчас ${num1(paintNow)}%` : undefined}>
                  <Input type="number" min={0} max={30} step={0.1} placeholder="как сейчас" value={form.paintDefect} onChange={(e) => set("paintDefect", e.target.value)} />
                </Field>
                <Field label="Задержка поставки">
                  <Select value={form.supply} onChange={(e) => set("supply", Number(e.target.value))}>
                    <option value={0}>Нет</option>
                    <option value={60}>60 минут</option>
                    <option value={90}>90 минут</option>
                    <option value={150}>150 минут</option>
                  </Select>
                </Field>
                <Field label="Сверхурочно">
                  <Select value={form.overtime} onChange={(e) => set("overtime", Number(e.target.value))}>
                    <option value={0}>Нет</option>
                    <option value={60}>+1 час</option>
                    <option value={120}>+2 часа</option>
                  </Select>
                </Field>
              </div>
              <Button type="submit" variant="primary" icon={<Play className="size-4" />} loading={run.isPending} disabled={!canRun}>
                Прогнать сценарий
              </Button>
              {!canRun && <p className="text-xs text-ink-3">Запуск доступен диспетчеру и администратору.</p>}
            </form>
          </Panel>
        </div>
        <div>
          {run.error ? (
            <ErrorNote error={run.error} />
          ) : run.data ? (
            <Result r={run.data} busy={run.isPending} />
          ) : (
            <Panel title="Результат">
              <Empty title={run.isPending ? "Модель проживает день…" : "Выберите сценарий"} text="Готовый сценарий запускается сразу. Расчёт занимает пару секунд." />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

const AREA_NAME: Record<string, string> = { WELD: "сварка", PAINT: "окраска", ASSY: "сборка" };

function Result({ r, busy }: { r: WhatIfResult; busy: boolean }) {
  const d = r.delta;
  const good = d.effect_kzt_day >= 0;
  const n = Math.max(r.baseline.timeline.length, r.scenario.timeline.length);
  const labels = Array.from({ length: n }, (_, i) => {
    const m = 8 * 60 + i * 30;
    return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  });
  return (
    <div className={clsx("flex flex-col gap-4 transition-opacity", busy && "opacity-50")}>
      <section className="grid gap-4 sm:grid-cols-3">
        <div className="panel rise p-5">
          <span className="text-[0.8125rem] text-ink-2">Автомобилей за день</span>
          <p className={clsx("display num text-[2.5rem] leading-none font-light tracking-[-0.03em]", d.cars < 0 ? "text-down" : d.cars > 0 ? "text-run" : "")}>
            {d.cars > 0 ? "+" : d.cars < 0 ? "−" : ""}
            {num1(Math.abs(d.cars))}
          </p>
          <span className="num text-xs text-ink-3">
            {num1(r.scenario.finished)} вместо {num1(r.baseline.finished)}
          </span>
        </div>
        <div className="panel rise p-5">
          <span className="text-[0.8125rem] text-ink-2">Эффект за день</span>
          <p className={clsx("display num text-[2.5rem] leading-none font-light tracking-[-0.03em]", good ? "text-run" : "text-down")}>
            {d.effect_kzt_day >= 0 ? "+" : "−"}
            {kzt(Math.abs(d.effect_kzt_day))}
          </p>
          <span className="text-xs text-ink-3">
            {d.effect_kzt_month >= 0 ? "+" : "−"}
            {kzt(Math.abs(d.effect_kzt_month))} за {r.assumptions.workdays_month} рабочих дней
          </span>
        </div>
        <div className="panel rise p-5">
          <span className="text-[0.8125rem] text-ink-2">Брак и простой</span>
          <p className="display num text-[1.75rem] leading-tight font-light">
            {d.defects > 0 ? "+" : d.defects < 0 ? "−" : ""}
            {num1(Math.abs(d.defects))} брак
          </p>
          <span className="num text-xs text-ink-3">
            простой критичного оборудования {d.downtime_min >= 0 ? "+" : "−"}
            {num(Math.abs(d.downtime_min))} мин
          </span>
        </div>
      </section>
      <Panel title="Выпуск нарастающим итогом за день" hint="Среднее по прогонам. 08:00–24:00, две смены">
        <LineChart
          labels={labels}
          series={[
            { name: "Обычный день", color: "var(--color-ink-3)", values: r.baseline.timeline },
            { name: "Со сценарием", color: "var(--color-accent)", values: r.scenario.timeline },
          ]}
          yMin={0}
          format={(v) => num(v)}
          height={260}
        />
      </Panel>
      <Panel title="Что изменилось на линии">
        <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {(["WELD", "PAINT", "ASSY", "QC"] as const).map((a) => {
            const delta = r.scenario.areas[a] - r.baseline.areas[a];
            return (
              <div key={a}>
                <dt className="text-ink-3">{a === "QC" ? "Через ОТК" : `Выпуск: ${AREA_NAME[a]}`}</dt>
                <dd className="num font-medium">
                  {num1(r.scenario.areas[a])}{" "}
                  <span className={clsx("text-xs", delta < 0 ? "text-down" : delta > 0 ? "text-run" : "text-ink-3")}>
                    ({delta >= 0 ? "+" : "−"}
                    {num1(Math.abs(delta))})
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="mt-4 text-[0.8125rem] text-ink-2">
          Ограничение дня: {AREA_NAME[r.baseline.bottleneck ?? ""] ?? "—"}
          {r.scenario.bottleneck !== r.baseline.bottleneck && ` → ${AREA_NAME[r.scenario.bottleneck ?? ""] ?? "—"}`}. Разброс выпуска по прогонам:{" "}
          {r.scenario.finished_min}–{r.scenario.finished_max}. Оценка в тенге: маржинальный доход {kzt(r.assumptions.margin_per_car_kzt)} на
          автомобиль, переделка брака {kzt(r.assumptions.rework_cost_kzt)} — допущения меняются в разделе «Данные».
        </p>
      </Panel>
    </div>
  );
}
