import { clsx } from "clsx";
import { Takeaway, type TakeawayItem } from "@/shared/ui/Takeaway";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { useInsights } from "@/shared/api/queries";
import type { Insights, Recommendation } from "@/shared/api/types";
import { LineChart } from "@/shared/charts/charts";
import { dayLabel, dayLong, kzt, num, plural } from "@/shared/lib/format";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { Meter } from "@/shared/ui/Status";

export function ForecastPage() {
  const q = useInsights();
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Skeleton className="h-[720px]" />;
  const d = q.data;
  const f = d.forecast;
  const top = d.risks.filter((r) => r.level === "high");
  const items: TakeawayItem[] = [];
  if (f.available)
    items.push({
      tone: f.probability >= 70 ? "ok" : f.probability >= 40 ? "warn" : "bad",
      text: `План месяца: прогноз ${num(f.expected)} из ${num(f.target)}, вероятность ${f.probability}%`,
    });
  if (top.length) items.push({ tone: "bad", text: `Высокий риск отказа: ${top.map((r) => r.code).join(", ")}` });
  if (d.recommendations[0]) items.push({ tone: "warn", text: `Первым делом: ${d.recommendations[0].title}` });
  return (
    <div className="flex flex-col gap-4">
      <Takeaway items={items} question="forecast" />
      <Recommendations recs={d.recommendations} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <MonthForecastPanel d={d} />
        <BottleneckPanel d={d} />
      </div>
      <RiskPanel d={d} />
      <AnomalyPanel d={d} />
    </div>
  );
}

const PRIORITY = {
  critical: { label: "Срочно", cls: "bg-down text-white" },
  high: { label: "Важно", cls: "bg-ink text-white" },
  medium: { label: "Плановое", cls: "bg-sunken text-ink-2" },
};

function Recommendations({ recs }: { recs: Recommendation[] }) {
  const total = recs.reduce((s, r) => s + r.effect_kzt_month, 0);
  return (
    <Panel title="Что сделать в первую очередь" hint={`Выводы всех модулей с оценкой эффекта. Суммарно ~${kzt(total)} в месяц`}>
      <ol className="flex flex-col">
        {recs.map((r, i) => (
          <li key={r.id} className="grid gap-x-5 gap-y-2 border-t border-line py-4 first:border-t-0 first:pt-1 md:grid-cols-[2rem_minmax(0,1fr)_11rem]">
            <span className="num hidden pt-0.5 text-lg font-semibold text-ink-3 md:block">{i + 1}</span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={clsx("rounded-full px-1.5 py-0.5 text-2xs font-semibold", PRIORITY[r.priority].cls)}>{PRIORITY[r.priority].label}</span>
                <h3 className="text-[0.9375rem]">{r.title}</h3>
              </div>
              <p className="mt-1.5 text-sm text-ink-2">{r.problem}</p>
              <p className="mt-1.5 text-sm">
                <span className="font-medium">Действие: </span>
                {r.action}
              </p>
            </div>
            <div className="flex flex-row items-baseline justify-between gap-3 md:flex-col md:items-end md:justify-start">
              {r.effect_kzt_month > 0 ? (
                <span className="text-right">
                  <span className="num block text-lg font-semibold">{kzt(r.effect_kzt_month)}</span>
                  <span className="text-xs text-ink-3">оценка эффекта в месяц</span>
                </span>
              ) : (
                <span className="text-xs text-ink-3">эффект — в выполнении плана</span>
              )}
              {r.link && (
                <Link to={r.link} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                  Подробнее <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function MonthForecastPanel({ d }: { d: Insights }) {
  const f = d.forecast;
  if (!f.available) return <Panel title="План месяца">Недостаточно данных.</Panel>;
  const labels = f.series.map((s) => dayLabel(s.day));
  const lastFact = f.series.filter((s) => s.fact != null).length - 1;
  const forecast = f.series.map((s, i) => (s.forecast ?? (i === lastFact ? s.fact : null)) ?? null);
  const verdict = f.probability >= 70 ? "Выполним" : f.probability >= 40 ? "Под угрозой" : "Не выполним без мер";
  return (
    <Panel title="План месяца: прогноз" hint={`${f.workdays_left} ${plural(f.workdays_left, "рабочий день", "рабочих дня", "рабочих дней")} до конца месяца`}>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
        <div>
          <span className="text-[0.8125rem] text-ink-2">Ожидаемый выпуск</span>
          <p className="display num text-[2.5rem] leading-none font-light tracking-[-0.03em]">{num(f.expected)}</p>
          <span className="num text-xs text-ink-3">
            коридор {num(f.p10)}–{num(f.p90)}
          </span>
        </div>
        <div>
          <span className="text-[0.8125rem] text-ink-2">Цель</span>
          <p className="display num text-[2.5rem] leading-none font-light tracking-[-0.03em]">{num(f.target)}</p>
          <span className={clsx("text-xs font-medium", f.gap >= 0 ? "text-run" : "text-down")}>
            {f.gap >= 0 ? "+" : "−"}
            {num(Math.abs(f.gap))} к цели
          </span>
        </div>
        <div>
          <span className="text-[0.8125rem] text-ink-2">Вероятность</span>
          <p className={clsx("display num text-[2.5rem] leading-none font-light tracking-[-0.03em]", f.probability < 70 && "text-down")}>{f.probability}%</p>
          <span className="text-xs text-ink-3">{verdict}</span>
        </div>
      </div>
      <div className="mt-4">
        <LineChart
          labels={labels}
          series={[
            { name: "Факт нарастающим итогом", color: "var(--color-ink)", values: f.series.map((s) => s.fact ?? null) },
            { name: "Прогноз", color: "var(--color-accent)", values: forecast, dashed: true },
          ]}
          band={{ low: f.series.map((s) => s.low ?? null), high: f.series.map((s) => s.high ?? null), color: "var(--color-accent)" }}
          target={{ value: f.target, label: `цель ${num(f.target)}` }}
          yMin={0}
          format={(v) => num(v)}
          height={230}
        />
      </div>
      <p className="mt-2 text-[0.8125rem] text-ink-2">
        Темп — {String(f.daily_rate).replace(".", ",")} авт./сутки (взвешенное среднее 15 рабочих дней). Для цели нужно{" "}
        {f.need_daily != null ? String(f.need_daily).replace(".", ",") : "—"}, мощность линии — {f.capacity_daily}.
      </p>
    </Panel>
  );
}

function BottleneckPanel({ d }: { d: Insights }) {
  const b = d.bottleneck;
  const max = Math.max(...b.lines.map((l) => l.good_capacity_per_shift), 125);
  return (
    <Panel title="Узкое место" hint={`Годная мощность линий за смену (последние ${b.shifts} смен). Метка — план 120`}>
      <ul className="flex flex-col gap-4">
        {b.lines.map((l) => {
          const main = l.area === b.constraint;
          return (
            <li key={l.area}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className={clsx("font-medium", main && "text-ink")}>
                  {l.name}
                  {main && <span className="ml-2 rounded-full bg-ink px-1.5 py-0.5 text-2xs font-semibold text-white">ограничение</span>}
                </span>
                <span className="num">
                  <span className="font-semibold">{String(l.good_capacity_per_shift).replace(".", ",")}</span>
                  <span className="text-ink-3"> авт./смену</span>
                </span>
              </div>
              <Meter className="mt-2" value={l.good_capacity_per_shift} max={max} mark={120} tone={main ? "down" : "accent"} />
              <p className="mt-1.5 text-xs text-ink-3">
                цикл {l.cycle_s} с при такте {l.takt_s} с · ограничивала выпуск в {l.share}% смен
              </p>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-[0.8125rem] text-ink-2">
        Годная мощность = идеальный темп × фактическое время работы × доля годных. Минута, выигранная на узком месте, — минута всего завода.
      </p>
    </Panel>
  );
}

function RiskPanel({ d }: { d: Insights }) {
  const rows = d.risks.filter((r) => r.level !== "low").slice(0, 8);
  const m = d.risk_model;
  return (
    <Panel
      title="Риск отказа оборудования в ближайшие 7 дней"
      hint={`${m.model}: обучен на ${num(m.trained_on)} примерах из истории простоев${m.auc ? `, точность на отложенных данных AUC ${String(m.auc).replace(".", ",")}` : ""}`}
    >
      <div className="scroll-thin -mx-6 overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[0.8125rem] text-ink-3">
              <th className="px-5 py-2 font-medium">Оборудование</th>
              <th className="px-3 py-2 font-medium">Риск</th>
              <th className="px-3 py-2 font-medium">Следующий отказ</th>
              <th className="px-3 py-2 font-medium">Почему</th>
              <th className="px-5 py-2 text-right font-medium">Потери за неделю</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className="border-b border-line align-top last:border-b-0">
                <td className="px-5 py-3">
                  <div className="font-medium">{r.code}</div>
                  <div className="text-xs text-ink-3">{r.critical ? "критичное" : "некритичное"}</div>
                </td>
                <td className="w-40 px-3 py-3">
                  <div className="flex items-center gap-2">
                    <Meter className="w-16" value={r.probability} max={1} tone={r.level === "high" ? "down" : "blocked"} />
                    <span className="num font-semibold">{Math.round(r.probability * 100)}%</span>
                  </div>
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {r.overdue ? <span className="font-medium text-down">уже ожидался</span> : r.next_failure ? dayLong(r.next_failure) : "не прогнозируется"}
                </td>
                <td className="px-3 py-3 text-ink-2">{r.factors.slice(0, 2).join(". ")}</td>
                <td className="num px-5 py-3 text-right whitespace-nowrap">{kzt(r.expected_loss_kzt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function AnomalyPanel({ d }: { d: Insights }) {
  return (
    <Panel title="Необычные смены" hint="Isolation Forest сравнивает каждую смену с обычным профилем завода и объясняет, чем она отличается">
      {d.anomalies.length === 0 ? (
        <p className="text-sm text-ink-2">Аномальных смен не найдено.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {d.anomalies.slice(0, 6).map((a) => (
            <li key={`${a.day}-${a.shift}`} className="rounded-[14px] border border-line bg-sunken px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">
                  {dayLong(a.day)}, смена {a.shift}
                </span>
                <span className="num text-sm text-ink-2">{a.output} авт.</span>
              </div>
              <ul className="mt-1.5 text-sm text-ink-2">
                {a.drivers.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              {a.events.length > 0 && <p className="mt-1.5 text-xs text-ink-3">{a.events.join(" · ")}</p>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
