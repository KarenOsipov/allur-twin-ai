import { clsx } from "clsx";
import { useState } from "react";
import { useOverview } from "@/shared/api/queries";
import type { Check, Overview, ParetoRow } from "@/shared/api/types";
import { BarChart, LineChart } from "@/shared/charts/charts";
import { dayLabel, dayLong, num, pct } from "@/shared/lib/format";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { Segmented } from "@/shared/ui/Segmented";
import { Takeaway, type TakeawayItem } from "@/shared/ui/Takeaway";
import { exportState } from "@/shared/export/ExportButton";
import { Meter, StatusPill } from "@/shared/ui/Status";

const PERIODS = [
  { value: 1, label: "Сутки" },
  { value: 7, label: "7 дней" },
  { value: 30, label: "30 дней" },
  { value: 60, label: "60 дней" },
  { value: 90, label: "90 дней" },
];

export function KpiPage() {
  const [days, setDays] = useState(exportState.days);
  const q = useOverview(days);
  exportState.days = days;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-2">
          {q.data ? periodText(q.data) : "Загрузка…"}
        </p>
        <Segmented label="Период" value={days} onChange={setDays} options={PERIODS} />
      </div>
      {q.error ? <ErrorNote error={q.error} /> : !q.data ? <Skeleton className="h-[640px]" /> : <Content o={q.data} days={days} />}
    </div>
  );
}

function periodText(o: Overview) {
  const p = o.period;
  const range = `${dayLong(p.start)} — ${dayLong(p.end)} · ${p.work_days} рабочих дн.`;
  if (p.clipped) return `${range} (данные есть только с ${dayLong(p.start)}) · сравнения с прошлым периодом нет`;
  return o.previous.available ? `${range}, сравнение с предыдущим периодом такой же длины` : `${range} · для сравнения с прошлым периодом не хватает данных`;
}

function Content({ o, days }: { o: Overview; days: number }) {
  const p = o.period;
  const prevKey: Record<string, number> = o.previous.available
    ? {
        oee: o.previous.oee,
        defect: o.previous.defect_pct,
        plan: o.previous.plan_pct,
      }
    : {};
  const labels = o.daily.map((d) => dayLabel(d.day));
  const dailyPlan = o.targets.shift_plan * 2;
  const fmt = (c: Check) => (c.unit === "%" ? pct(c.value) : `${num(c.value)} ${c.unit}`);
  const rank = { critical: 0, warning: 1, ok: 2 } as const;
  const items: TakeawayItem[] = [...p.checks]
    .sort((a, b) => rank[a.status] - rank[b.status])
    .slice(0, 3)
    .map((c) => ({
      tone: c.status === "critical" ? "bad" : c.status === "warning" ? "warn" : "ok",
      text: `${c.label}: ${fmt(c)} — ${c.status === "ok" ? "цель выполнена" : c.status === "warning" ? "у границы цели" : `цель ${c.op} ${c.unit === "%" ? pct(c.target, 0) : num(c.target)} не выполнена`}`,
    }));
  return (
    <>
      <Takeaway items={items} question="kpi" />
      <section aria-label="Цели заказчика" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {p.checks.map((c) => (
          <CheckTile key={c.key} c={c} prev={prevKey[c.key]} />
        ))}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Выпуск автомобилей по суткам" hint={`Факт Сборки-1. Пунктир — суточный план ${dailyPlan}`}>
          {days === 1 ? (
            <SingleDay o={o} />
          ) : (
            <BarChart labels={labels} values={o.daily.map((d) => d.output)} name="Выпуск" target={{ value: dailyPlan, label: `план ${dailyPlan}` }} />
          )}
        </Panel>
        <Panel title="OEE линий по суткам" hint="Среднее по трём линиям. Пунктир — цель 85%">
          {days === 1 ? (
            <SingleDay o={o} oee />
          ) : (
            <LineChart
              labels={labels}
              series={[{ name: "OEE", color: "var(--color-accent)", values: o.daily.map((d) => d.oee) }]}
              target={{ value: o.targets.oee_pct, label: `цель ${o.targets.oee_pct}%` }}
              format={(v) => `${Math.round(v)}%`}
            />
          )}
        </Panel>
      </div>

      <Panel title="Линии: из чего складывается OEE" hint="OEE = доступность × производительность × качество. Красным — то, что тянет показатель вниз">
        <LinesTable o={o} />
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Pareto o={o} />
        <MonthPlan o={o} />
      </div>
    </>
  );
}

function CheckTile({ c, prev }: { c: Check; prev?: number }) {
  const delta = prev !== undefined ? c.value - prev : null;
  const better = delta == null ? null : c.op === "≥" ? delta >= 0 : delta <= 0;
  return (
    <div className="panel rise flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[0.8125rem] text-ink-2">{c.label}</span>
        <StatusPill status={c.status} />
      </div>
      <span className="display num text-[2.5rem] leading-none font-light tracking-[-0.03em]">
        {c.unit === "%" ? pct(c.value) : `${num(c.value)}${c.unit}`}
      </span>
      <span className="text-xs text-ink-3">
        цель {c.op} {c.unit === "%" ? pct(c.target, 0) : `${num(c.target)}${c.unit}`}
        {delta != null && Math.abs(delta) >= 0.05 && (
          <span className={clsx("ml-2 font-medium", better ? "text-run" : "text-down")}>
            {delta > 0 ? "+" : "−"}
            {Math.abs(delta).toFixed(1).replace(".", ",")} п.п. к прошлому периоду
          </span>
        )}
      </span>
    </div>
  );
}

function SingleDay({ o, oee }: { o: Overview; oee?: boolean }) {
  const d = o.daily[o.daily.length - 1];
  if (!d) return <p className="text-sm text-ink-2">Нет данных за сутки.</p>;
  return (
    <div className="flex h-[200px] flex-col justify-center gap-2">
      <span className="display num text-[3.5rem] leading-none font-light">{oee ? pct(d.oee) : num(d.output)}</span>
      <span className="text-sm text-ink-2">{oee ? `цель ${o.targets.oee_pct}%` : `из ${d.plan} по плану`}</span>
    </div>
  );
}

function LinesTable({ o }: { o: Overview }) {
  const t = o.targets;
  const cell = (v: number, warn: boolean) => <td className={clsx("num px-3 py-2.5 text-right", warn && "font-medium text-down")}>{pct(v)}</td>;
  return (
    <div className="scroll-thin -mx-6 overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[0.8125rem] text-ink-3">
            <th className="px-5 py-2 font-medium">Линия</th>
            <th className="px-3 py-2 text-right font-medium">План</th>
            <th className="px-3 py-2 text-right font-medium">Факт</th>
            <th className="px-3 py-2 text-right font-medium">Доступность</th>
            <th className="px-3 py-2 text-right font-medium">Производит.</th>
            <th className="px-3 py-2 text-right font-medium">Качество</th>
            <th className="px-3 py-2 text-right font-medium">Брак</th>
            <th className="px-5 py-2 text-right font-medium">OEE</th>
          </tr>
        </thead>
        <tbody>
          {o.period.lines.map((l) => (
            <tr key={l.area} className="border-b border-line last:border-b-0">
              <td className="px-5 py-2.5 font-medium">{l.line}</td>
              <td className="num px-3 py-2.5 text-right text-ink-2">{num(l.plan)}</td>
              <td className="num px-3 py-2.5 text-right">{num(l.fact)}</td>
              {cell(l.availability, l.availability < 95)}
              {cell(l.performance, l.performance < 93)}
              {cell(l.quality, l.quality < 98)}
              <td className={clsx("num px-3 py-2.5 text-right", l.defect_pct > t.defect_pct && "font-medium text-down")}>{pct(l.defect_pct, 2)}</td>
              <td className="px-5 py-2.5">
                <div className="flex items-center justify-end gap-3">
                  <Meter value={l.oee} max={100} mark={t.oee_pct} tone={l.oee >= t.oee_pct ? "run" : "down"} className="w-24" />
                  <span className={clsx("num w-12 text-right font-semibold", l.oee < t.oee_pct && "text-down")}>{pct(l.oee)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pareto({ o }: { o: Overview }) {
  const [by, setBy] = useState<"reason" | "equipment">("reason");
  const rows: ParetoRow[] = (by === "reason" ? o.pareto_reason : o.pareto_equipment).slice(0, 8);
  const max = Math.max(...rows.map((r) => r.minutes), 1);
  return (
    <Panel
      title="Куда уходит время: простои"
      hint={`Внеплановые ${num(o.period.downtime_unplanned_min)} мин, плановые ${num(o.period.downtime_planned_min)} мин`}
      actions={
        <Segmented
          label="Группировка"
          value={by}
          onChange={setBy}
          options={[
            { value: "reason", label: "Причины" },
            { value: "equipment", label: "Оборудование" },
          ]}
        />
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-ink-2">Простоев за период не было.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_4.5rem] items-center gap-3 text-sm">
              <span className="truncate" title={r.key}>
                {r.key}
                {r.planned && by === "reason" && <span className="ml-1.5 text-xs text-maint">план</span>}
              </span>
              <div className="h-2.5 rounded-[3px] bg-floor">
                <div className={clsx("h-full rounded-[3px]", r.planned ? "bg-maint" : "bg-ink")} style={{ width: `${(r.minutes / max) * 100}%` }} />
              </div>
              <span className="num text-right">
                <span className="font-medium">{r.minutes}</span>
                <span className="text-ink-3"> мин</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 2 && (
        <p className="mt-4 text-[0.8125rem] text-ink-2">
          Первые две позиции — {pct(rows[1].cumulative, 0)} всех потерь времени. Начинать стоит с них.
        </p>
      )}
    </Panel>
  );
}

function MonthPlan({ o }: { o: Overview }) {
  const m = o.month;
  const unassigned = m.target - m.models_plan_total;
  return (
    <Panel title="План месяца по моделям" hint={`Таблица 3 заказчика · цель — не менее ${num(m.target)} автомобилей`}>
      <ul className="flex flex-col gap-4">
        {m.models.map((x) => (
          <li key={x.model}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">{x.model}</span>
              <span className="num text-ink-2">
                <span className="font-medium text-ink">{num(x.fact)}</span> из {num(x.plan)}
              </span>
            </div>
            <Meter className="mt-2" value={x.fact} max={x.plan} />
          </li>
        ))}
      </ul>
      {unassigned > 0 && (
        <div className="mt-5 rounded-[14px] border border-down/25 bg-down-soft px-4 py-3 text-sm">
          <p className="font-medium text-down">Не распределено по моделям: {num(unassigned)} автомобилей</p>
          <p className="mt-0.5 text-ink-2">
            Сумма плана по моделям — {num(m.models_plan_total)}, цель — {num(m.target)}. Под остаток не заказаны комплекты.
          </p>
        </div>
      )}
    </Panel>
  );
}
