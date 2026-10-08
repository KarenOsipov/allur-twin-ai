import { clsx } from "clsx";
import { CircleCheck, LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { useAdvice, useEconomics, useEconomicsValues, usePlantEconomy } from "@/shared/api/queries";
import type { AdviceItem, PlantEconomy } from "@/shared/api/types";
import { can, useSession } from "@/shared/auth/session";
import { exportState } from "@/shared/export/ExportButton";
import { dayLabel, kzt, num, num1, pct } from "@/shared/lib/format";
import { Button } from "@/shared/ui/Button";
import { Field, Input } from "@/shared/ui/Field";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { toast } from "@/shared/ui/Toaster";

export function EconomicsPage() {
  const q = usePlantEconomy();
  useEffect(() => {
    exportState.days = 30;
  }, []);
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Skeleton className="h-[600px]" />;
  const r = q.data;
  return (
    <div className="grid gap-4">
      <Hero r={r} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Pnl r={r} />
        <Losses r={r} />
      </div>
      <Daily r={r} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Areas r={r} />
        <Equipment r={r} />
      </div>
      <Potential r={r} />
      <AdvicePanel />
      <Assumptions r={r} />
    </div>
  );
}

function Hero({ r }: { r: PlantEconomy }) {
  const m = r.month;
  return (
    <section className="panel-deep rise relative overflow-hidden px-6 py-7 sm:px-9 sm:py-9">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-end">
        <div>
          <p className="text-sm font-semibold text-deep-ink-2">Маржинальный доход завода в месяц</p>
          <p className="display mt-2 text-[clamp(2.6rem,7vw,4.8rem)] leading-none font-light tracking-[-0.035em] text-white">{kzt(m.margin_income_kzt)}</p>
          <p className="mt-4 max-w-[56ch] text-[0.95rem] text-deep-ink-2">
            {num(m.output)} автомобилей при плане {num(m.plan)}. Потери —{" "}
            <b className="text-white">{kzt(r.losses_total_kzt)} в месяц</b>. Расчёт по фактическим данным за {r.period.days} рабочих дней ({dayLabel(r.period.start)} —{" "}
            {dayLabel(r.period.end)}), приведён к месяцу из {r.basis.workdays_month} рабочих дней.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5">
          {[
            ["Выполнение плана", pct(r.plan_pct)],
            ["Результат линии", kzt(m.result_kzt)],
            ["Труд и накладные на авто", kzt(r.cost_per_car_kzt)],
            ["Минута линии в марже", kzt(r.minute_kzt)],
          ].map(([k, v]) => (
            <div key={k} className="border-t border-white/12 pt-3">
              <dt className="text-xs text-deep-ink-2">{k}</dt>
              <dd className="display num mt-1 text-[1.6rem] font-light text-white">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Pnl({ r }: { r: PlantEconomy }) {
  const m = r.month;
  const rows: [string, number, string][] = [
    ["Маржинальный доход", m.margin_income_kzt, `${num(m.output)} авто × ${kzt(r.basis.margin_per_car_kzt)}`],
    ["Оплата труда линии", -m.payroll_kzt, `${r.basis.line_staff} чел. × ${kzt(r.basis.labor_rate_kzt_h)} в час × ${num(Math.round((r.period.hours * r.basis.workdays_month) / Math.max(r.period.days, 1)))} ч`],
    ["Энергия и накладные", -m.overhead_kzt, `${kzt(r.minute_cost_kzt - Math.round((r.basis.line_staff * r.basis.labor_rate_kzt_h) / 60))} за минуту работы линии`],
    ["Переделка брака", -r.losses.rework_kzt, `${num(r.losses.defects)} дефектов × ${kzt(r.basis.rework_cost_kzt)}`],
  ];
  return (
    <Panel title="Доход и затраты за месяц" hint="Операционный результат сборочной линии. Стоимость комплектующих уже вычтена в маржинальном доходе." i={1}>
      <ul className="flex flex-col divide-y divide-line">
        {rows.map(([t, v, note]) => (
          <li key={t} className="py-3 first:pt-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold">{t}</span>
              <span className={clsx("num shrink-0 font-semibold", v < 0 && "text-down")}>{v < 0 ? `−${kzt(-v)}` : kzt(v)}</span>
            </div>
            <p className="mt-0.5 text-[0.8125rem] text-ink-3">{note}</p>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-baseline justify-between border-t-2 border-ink/80 pt-3">
        <span className="font-semibold">Операционный результат линии</span>
        <span className="display num text-[1.4rem]">{kzt(m.result_kzt)}</span>
      </div>
      <p className="mt-2 text-[0.8125rem] text-ink-3">
        Себестоимость сборки одного автомобиля (труд и накладные): {kzt(r.cost_per_car_kzt)}. Минута работы линии стоит {kzt(r.minute_cost_kzt)}, а приносит{" "}
        {kzt(r.minute_kzt)} маржи.
      </p>
    </Panel>
  );
}

function Losses({ r }: { r: PlantEconomy }) {
  const l = r.losses;
  const rows = [
    { t: "Недовыпуск против плана", v: l.shortfall_kzt, note: `${num1(l.shortfall_cars)} авто не собрано` },
    { t: "Внеплановые простои", v: l.downtime_kzt, note: `${num(l.downtime_min)} мин, ${num(l.downtime_stops)} остановок · ≈ ${num1(l.downtime_cars)} авто` },
    { t: "Переделка брака", v: l.rework_kzt, note: `${num(l.defects)} дефектов, из них ${num1(l.defects_excess)} сверх нормы (${kzt(l.rework_excess_kzt)})` },
  ];
  const max = Math.max(...rows.map((x) => x.v), 1);
  return (
    <Panel title="Куда уходят деньги" hint="Потери в пересчёте на рабочий месяц. Простои — причина недовыпуска, поэтому в итог входят один раз." i={2}>
      <ul className="flex flex-col gap-3">
        {rows.map((x) => (
          <li key={x.t} className="rounded-[16px] bg-sunken px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold">{x.t}</span>
              <span className="display num text-[1.35rem] font-light">{kzt(x.v)}</span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-floor">
              <div className="h-full rounded-full bg-down" style={{ width: `${(x.v / max) * 100}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-ink-3">{x.note}</p>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-baseline justify-between border-t border-line pt-3 text-sm">
        <span className="text-ink-2">Итого потерь в месяц</span>
        <span className="num font-semibold">{kzt(r.losses_total_kzt)}</span>
      </div>
      <p className="mt-1 text-xs text-ink-3">Плановые остановки: {num(l.planned_min)} мин — в потери не входят.</p>
    </Panel>
  );
}

function Daily({ r }: { r: PlantEconomy }) {
  const max = Math.max(...r.daily.map((d) => d.loss_kzt), 1);
  const worst = r.daily.reduce<PlantEconomy["daily"][number] | null>((w, d) => (!w || d.loss_kzt > w.loss_kzt ? d : w), null);
  return (
    <Panel title="Потери по дням" hint="Недовыпуск против плана и переделка брака за каждый рабочий день. Наведите на столбец — подробности." i={3}>
      {r.daily.length === 0 ? (
        <p className="text-sm text-ink-3">Нет данных за период.</p>
      ) : (
        <>
          <div className="flex h-44 items-end gap-1 overflow-x-auto pb-6">
            {r.daily.map((d) => (
              <div
                key={d.day}
                className="relative flex h-full min-w-[14px] flex-1 flex-col justify-end"
                title={`${dayLabel(d.day)}: ${num(d.output)} из ${num(d.plan)} авто · маржа ${kzt(d.margin_kzt)} · потери ${kzt(d.loss_kzt)}`}
              >
                <div className={clsx("rounded-t-[4px]", d === worst ? "bg-down" : "bg-down/45")} style={{ height: `${Math.max((d.loss_kzt / max) * 100, 1.5)}%` }} />
                <span className="num absolute -bottom-5 left-1/2 hidden -translate-x-1/2 text-[0.65rem] text-ink-3 sm:block">{dayLabel(d.day).slice(0, 2)}</span>
              </div>
            ))}
          </div>
          {worst && (
            <p className="mt-1 text-[0.8125rem] text-ink-3">
              Самый дорогой день — {dayLabel(worst.day)}: {num(worst.output)} из {num(worst.plan)} авто, потери {kzt(worst.loss_kzt)}.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function Areas({ r }: { r: PlantEconomy }) {
  return (
    <Panel title="Потери по участкам" hint="Простои и переделка, ₸ в месяц" i={4}>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-ink-3">
          <tr>
            <th className="pb-2 font-medium">Участок</th>
            <th className="pb-2 text-right font-medium">Простой</th>
            <th className="pb-2 text-right font-medium">Брак</th>
            <th className="pb-2 text-right font-medium">Итого</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {r.areas.map((a) => (
            <tr key={a.area}>
              <td className="py-2 pr-2">
                <span className="font-semibold">{a.name}</span>
                <span className="block text-xs text-ink-3">
                  {num(a.down_min)} мин · {num(a.stops)} ост. · {num(a.defects)} деф.
                </span>
              </td>
              <td className="num py-2 text-right">{kzt(a.downtime_kzt)}</td>
              <td className="num py-2 text-right">{kzt(a.rework_kzt)}</td>
              <td className="num py-2 text-right font-semibold">{kzt(a.total_kzt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Equipment({ r }: { r: PlantEconomy }) {
  return (
    <Panel title="Самое дорогое оборудование" hint="Внеплановые простои, ₸ потерянной маржи в месяц" i={5}>
      <ul className="flex flex-col divide-y divide-line">
        {r.equipment.map((e) => (
          <li key={e.code} className="flex items-baseline justify-between gap-3 py-2 first:pt-0">
            <div className="min-w-0">
              <span className="font-semibold">{e.name}</span>
              <span className="block truncate text-xs text-ink-3">
                {e.area} · {num(e.down_min)} мин, {num(e.stops)} ост. · чаще всего: {e.reason}
              </span>
            </div>
            <span className="num shrink-0 font-semibold">{kzt(e.kzt_month)}</span>
          </li>
        ))}
      </ul>
      {r.reasons.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-2 text-xs font-semibold text-ink-2">Причины простоев</p>
          <div className="flex flex-wrap gap-2">
            {r.reasons.map((x) => (
              <span key={x.reason} className="rounded-full bg-sunken px-3 py-1 text-xs">
                {x.reason} · <b className="num">{kzt(x.kzt_month)}</b>
              </span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function Potential({ r }: { r: PlantEconomy }) {
  const max = Math.max(...r.potential.map((p) => Math.abs(p.kzt_month)), 1);
  return (
    <Panel title="Что даст устранение потерь" hint="Сколько маржи в месяц вернёт каждое направление. Направления пересекаются — не складывайте их." i={6}>
      <ul className="grid gap-3 lg:grid-cols-2">
        {r.potential.map((p) => (
          <li key={p.id} className="rounded-[16px] border border-line px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold">{p.title}</span>
              <span className={clsx("num shrink-0 font-semibold", p.kzt_month >= 0 ? "text-run" : "text-down")}>
                {p.kzt_month >= 0 ? "+" : "−"}
                {kzt(Math.abs(p.kzt_month))} / мес
              </span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-full bg-floor">
              <div className={clsx("h-full rounded-full", p.kzt_month >= 0 ? "bg-run" : "bg-down")} style={{ width: `${(Math.abs(p.kzt_month) / max) * 100}%` }} />
            </div>
            <p className="mt-1.5 text-[0.8125rem] text-ink-3">{p.text}</p>
            {p.cost_kzt_month != null && <p className="mt-0.5 text-xs text-ink-2">Затраты {kzt(p.cost_kzt_month)} в месяц уже вычтены</p>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function AdvicePanel() {
  const adv = useAdvice();
  const items = adv.data?.items ?? [];
  const good = items.filter((x) => x.worth_it);
  const bad = items.filter((x) => !x.worth_it);
  return (
    <Panel
      title="Сделайте А — получите Б"
      hint="Каждое действие прогнано на модели линии: рабочий день, 6 прогонов на тех же случайных событиях, что и базовый день. Из эффекта вычтены затраты."
      i={7}
      actions={
        adv.data?.status === "computing" ? (
          <span className="inline-flex items-center gap-2 text-sm text-ink-3">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Считаю на модели…
          </span>
        ) : undefined
      }
    >
      {adv.isError && <ErrorNote error={adv.error} />}
      {!adv.data && <Skeleton className="h-48" />}
      {adv.data && !items.length && adv.data.status === "computing" && <Skeleton className="h-48" />}
      <ol className="grid gap-3 lg:grid-cols-2">
        {good.map((x, n) => (
          <AdviceCard key={x.id} x={x} n={n + 1} />
        ))}
      </ol>
      {bad.length > 0 && (
        <details className="mt-4 rounded-[16px] bg-sunken px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink-2">Не окупается сейчас — {bad.length}</summary>
          <ul className="mt-3 flex flex-col gap-2">
            {bad.map((x) => (
              <li key={x.id} className="text-sm">
                <span className="font-semibold">{x.title}</span>
                <span className="text-ink-3"> — {x.result}; затраты {x.cost_note || "—"}. {x.valuation}.</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

export function AdviceCard({ x, n }: { x: AdviceItem; n: number }) {
  return (
    <li className="flex flex-col rounded-[18px] border border-line bg-panel px-5 py-4" style={{ "--i": n } as CSSProperties}>
      <div className="flex items-start gap-3">
        <span className="display num grid size-8 shrink-0 place-items-center rounded-full bg-brand text-sm font-medium text-white">{n}</span>
        <div className="min-w-0">
          <h3 className="font-semibold">{x.title}</h3>
          <p className="mt-1 text-[0.8125rem] text-ink-2">{x.why}</p>
        </div>
      </div>
      <div className="mt-3 rounded-[14px] bg-run-soft px-3.5 py-2.5 text-sm font-semibold text-run">→ {x.result}</div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[0.8125rem] sm:grid-cols-3">
        <div>
          <dt className="text-ink-3">Чистый эффект</dt>
          <dd className="num font-semibold">{kzt(x.net_kzt_month)} / мес</dd>
        </div>
        <div>
          <dt className="text-ink-3">Затраты</dt>
          <dd>{x.cost_note || "нет"}</dd>
        </div>
        <div>
          <dt className="text-ink-3">{x.payback_months != null ? "Окупаемость" : "Надёжность"}</dt>
          <dd className="font-semibold">{x.payback_months != null ? `${num1(x.payback_months)} мес` : x.confidence}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-ink-3">
        {x.cars_low || x.cars_high ? `По модели: от ${num1(x.cars_low)} до ${num1(x.cars_high)} авто в день в разных прогонах · ` : ""}оценка: {x.valuation}
      </p>
    </li>
  );
}

function Assumptions({ r }: { r: PlantEconomy }) {
  const s = useSession();
  const admin = can(s, "manage_data");
  const econ = useEconomicsValues();
  const save = useEconomics();
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [base, setBase] = useState<Record<string, string>>({});
  useEffect(() => {
    setExtra(Object.fromEntries(r.assumptions.map((a) => [a.key, String(a.value)])));
  }, [r]);
  useEffect(() => {
    if (econ.data)
      setBase({
        margin_per_car_kzt: String(econ.data.margin_per_car_kzt),
        rework_cost_kzt: String(econ.data.rework_cost_kzt),
        labor_rate_kzt_h: String(econ.data.labor_rate_kzt_h),
        overtime_rate_kzt_h: String(econ.data.overtime_rate_kzt_h),
        line_staff: String(econ.data.line_staff),
      });
  }, [econ.data]);
  const baseLabels: [string, string][] = [
    ["margin_per_car_kzt", "Маржинальный доход на автомобиль, ₸"],
    ["rework_cost_kzt", "Переделка одного дефектного кузова, ₸"],
    ["labor_rate_kzt_h", "Час работы рабочего с налогами, ₸"],
    ["overtime_rate_kzt_h", "Час сверхурочной работы, ₸"],
    ["line_staff", "Рабочих на линии в смену"],
  ];
  const submit = () => {
    const toNum = (v: string) => Number(v.replace(",", ".").replace(/\s/g, ""));
    const bad = [...Object.values(extra), ...Object.values(base)].some((v) => !Number.isFinite(toNum(v)) || v.trim() === "");
    if (bad) {
      toast({ title: "Проверьте значения", body: "Во всех полях должны быть числа.", tone: "down" });
      return;
    }
    save.mutate(
      {
        ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(toNum(v))])),
        economy: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, toNum(v)])),
      },
      {
        onSuccess: () => toast({ title: "Допущения сохранены", body: "Экономика, рекомендации и документы пересчитаны.", tone: "run" }),
        onError: (e) => toast({ title: "Не сохранилось", body: e.message, tone: "down" }),
      },
    );
  };
  return (
    <Panel
      title="Допущения расчёта"
      hint={admin ? "Меняйте — экономика, рекомендации и документы пересчитаются сразу." : "Меняет администратор. Значения по умолчанию — типичные для сборочного производства."}
      i={8}
      actions={
        admin ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw className="size-4" />}
            onClick={() => setExtra(Object.fromEntries(r.assumptions.map((a) => [a.key, String(a.default)])))}
          >
            По умолчанию
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
        {baseLabels.map(([k, label]) => (
          <Field key={k} label={label}>
            <Input inputMode="decimal" value={base[k] ?? ""} disabled={!admin} onChange={(e) => setBase((b) => ({ ...b, [k]: e.target.value }))} />
          </Field>
        ))}
        {r.assumptions.map((a) => (
          <Field
            key={a.key}
            label={a.label}
            hint={
              Number(extra[a.key]) !== a.default ? (
                <span className="inline-flex items-center gap-1 text-blocked">
                  <TriangleAlert className="size-3" aria-hidden /> по умолчанию {String(a.default).replace(".", ",")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <CircleCheck className="size-3" aria-hidden /> значение по умолчанию
                </span>
              )
            }
          >
            <Input inputMode="decimal" value={extra[a.key] ?? ""} disabled={!admin} onChange={(e) => setExtra((x) => ({ ...x, [a.key]: e.target.value }))} />
          </Field>
        ))}
      </div>
      {admin && (
        <Button variant="primary" className={clsx("mt-6")} loading={save.isPending} onClick={submit}>
          Сохранить и пересчитать
        </Button>
      )}
    </Panel>
  );
}
