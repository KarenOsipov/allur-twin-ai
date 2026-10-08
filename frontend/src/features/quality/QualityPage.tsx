import { clsx } from "clsx";
import { Takeaway } from "@/shared/ui/Takeaway";
import { Search } from "lucide-react";
import { useInsights } from "@/shared/api/queries";
import type { QualityArea } from "@/shared/api/types";
import { LineChart } from "@/shared/charts/charts";
import { dayLabel, dayLong, num1, pct } from "@/shared/lib/format";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { StatusPill } from "@/shared/ui/Status";

export function QualityPage() {
  const q = useInsights();
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Skeleton className="h-[640px]" />;
  const order = { critical: 0, warning: 1, ok: 2 };
  const areas = [...q.data.quality].sort((a, b) => order[a.status] - order[b.status]);
  return (
    <div className="flex flex-col gap-4">
      <Takeaway
        question="quality"
        items={areas.slice(0, 3).map((a) => ({
          tone: a.status === "ok" ? "ok" : a.status === "warning" ? "warn" : "bad",
          text:
            a.status === "ok"
              ? `${a.name}: ${pct(a.level)} — в норме`
              : `${a.name}: ${pct(a.level)} при норме ${pct(a.target, 0)}${a.slope_week > 0.05 ? `, растёт на ${num1(a.slope_week)} п.п. в неделю` : ""}`,
        }))}
      />
      <p className="max-w-[80ch] px-1 text-sm text-ink-3">
        Для каждого участка система проверяет гипотезы о причинах брака — смена, отказы оборудования, плановое обслуживание, долгий тренд — и
        показывает только подтверждённые данными.
      </p>
      {areas.map((a, i) => (
        <AreaQuality key={a.area} a={a} wide={i === 0} />
      ))}
    </div>
  );
}

function AreaQuality({ a, wide }: { a: QualityArea; wide: boolean }) {
  const labels = a.series.map((s) => dayLabel(s.day));
  const color = a.status === "ok" ? "var(--color-run)" : "var(--color-down)";
  return (
    <Panel title={a.name} actions={<StatusPill status={a.status} label={a.status === "ok" ? "В норме" : a.status === "warning" ? "Выше нормы" : "Сильно выше нормы"} />}>
      <div className={clsx("grid gap-6", wide ? "xl:grid-cols-[15rem_minmax(0,1fr)_minmax(0,22rem)]" : "lg:grid-cols-[15rem_minmax(0,1fr)]")}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 self-start lg:grid-cols-1">
          <div>
            <dt className="text-[0.8125rem] text-ink-2">Уровень по тренду</dt>
            <dd className={clsx("display num text-[2.5rem] leading-none font-light tracking-[-0.03em]", a.status !== "ok" && "text-down")}>{pct(a.level)}</dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] text-ink-2">Изменение за неделю</dt>
            <dd className="num font-medium">
              {a.slope_week > 0 ? "+" : ""}
              {a.slope_week.toFixed(2).replace(".", ",")} п.п.
            </dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] text-ink-2">Прогноз через 7 дней</dt>
            <dd className="num font-medium">{pct(a.forecast_7)}</dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] text-ink-2">{a.days_over ? "Выше нормы подряд" : "Превысит норму"}</dt>
            <dd className="font-medium">{a.days_over ? `${a.days_over} дн.` : a.crossing ? dayLong(a.crossing) : "не ожидается"}</dd>
          </div>
        </dl>
        <div className="min-w-0">
          <LineChart
            labels={labels}
            series={[{ name: "Брак, %", color, values: a.series.map((s) => s.pct) }]}
            target={{ value: a.target, label: `норма ${a.target}%` }}
            yMin={0}
            format={(v) => `${v.toFixed(v < 10 ? 1 : 0).replace(".", ",")}%`}
            height={wide ? 240 : 180}
          />
        </div>
        {(wide || a.causes.length > 0) && (
          <div className={clsx(!wide && "lg:col-span-2")}>
            <h3 className="flex items-center gap-2 text-sm">
              <Search className="size-4 text-ink-3" aria-hidden />
              Что показал разбор
            </h3>
            {a.causes.length === 0 ? (
              <p className="mt-2 text-sm text-ink-2">Устойчивых закономерностей не найдено — брак случайный и в пределах нормы.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2.5">
                {a.causes.map((c) => (
                  <li key={c.text} className="rounded-[14px] border border-line bg-sunken px-3 py-2.5 text-sm">
                    {c.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
