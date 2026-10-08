import { clsx } from "clsx";
import { FlaskConical, RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useParams, useResetParams, useRunScenario, useSaveParams } from "@/shared/api/queries";
import type { LineParams, WhatIfResult } from "@/shared/api/types";
import { kzt, num1 } from "@/shared/lib/format";
import { Button } from "@/shared/ui/Button";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { toast } from "@/shared/ui/Toaster";

type Draft = Record<string, string>;

function toDraft(p: LineParams): Draft {
  const d: Draft = {};
  for (const a of p.areas) {
    d[`area:${a.code}:cycle_s`] = String(a.value.cycle_s);
    if (a.has_buffer) d[`area:${a.code}:buffer`] = String(a.value.buffer);
    if (a.has_defects) d[`area:${a.code}:defect_pct`] = String(a.value.defect_pct);
  }
  for (const e of p.equipment) {
    d[`eq:${e.code}:mtbf_h`] = String(e.value.mtbf_h);
    d[`eq:${e.code}:mttr_min`] = String(e.value.mttr_min);
  }
  d["supply:every_min"] = String(p.supply.value.every_min);
  d["supply:size"] = String(p.supply.value.size);
  return d;
}

const n = (v: string) => Number(v.replace(",", ".").replace(/\s/g, ""));

export function ParamsEditor({ admin }: { admin: boolean }) {
  const q = useParams();
  const save = useSaveParams();
  const reset = useResetParams();
  const check = useRunScenario();
  const [draft, setDraft] = useState<Draft>({});
  const [trial, setTrial] = useState<WhatIfResult | null>(null);
  const base = useMemo(() => (q.data ? toDraft(q.data) : {}), [q.data]);
  useEffect(() => setDraft(base), [base]);

  const dirty = Object.keys(draft).filter((k) => draft[k] !== base[k]);
  const invalid = dirty.some((k) => !Number.isFinite(n(draft[k])) || draft[k].trim() === "");
  const set = (k: string, v: string) => {
    setDraft((d) => ({ ...d, [k]: v.replace(/[^\d.,]/g, "") }));
    setTrial(null);
  };

  const patch = () => {
    const out: { areas: Record<string, Record<string, number>>; equipment: Record<string, Record<string, number>>; supply: Record<string, number> } = { areas: {}, equipment: {}, supply: {} };
    for (const k of dirty) {
      const [kind, code, field] = k.split(":");
      if (kind === "area") (out.areas[code] ??= {})[field] = n(draft[k]);
      else if (kind === "eq") (out.equipment[code] ??= {})[field] = n(draft[k]);
      else out.supply[code] = n(draft[k]);
    }
    return out;
  };

  const tryIt = () => {
    if (!q.data) return;
    const scenario = { stops: [], cycle_factor: {} as Record<string, number>, buffer_override: {} as Record<string, number>, defect_pct: {} as Record<string, number>, supply_delay: null, overtime_min: 0 };
    for (const k of dirty) {
      const [kind, code, field] = k.split(":");
      if (kind !== "area") continue;
      const a = q.data.areas.find((x) => x.code === code);
      if (!a || a.kind !== "process") continue;
      if (field === "cycle_s") scenario.cycle_factor[code] = Math.min(1.3, Math.max(0.7, n(draft[k]) / a.value.cycle_s));
      if (field === "buffer") scenario.buffer_override[code] = Math.min(40, Math.max(1, Math.round(n(draft[k]))));
      if (field === "defect_pct") scenario.defect_pct[code] = Math.min(30, n(draft[k]));
    }
    check.mutate({ scenario, runs: 6 }, { onSuccess: setTrial });
  };

  const apply = () =>
    save.mutate(patch(), {
      onSuccess: (r) => {
        setTrial(null);
        toast({
          title: `Применено изменений: ${r.changes?.length ?? 0}`,
          body: "Живой цех, прогнозы и рекомендации уже считают с новыми параметрами. Запись — в журнале.",
          tone: "run",
        });
      },
      onError: (e) => toast({ title: "Не применилось", body: e.message, tone: "down" }),
    });

  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Skeleton className="h-[480px]" />;
  const p = q.data;
  const areaChecks = dirty.some((k) => k.startsWith("area:"));

  return (
    <div className="grid gap-4">
      {admin && (
        <div className="sticky top-[76px] z-20 flex flex-wrap items-center gap-3 rounded-[20px] border border-line bg-panel/95 px-4 py-3 shadow-[var(--shadow-panel)] backdrop-blur lg:top-[128px]">
          <span className="text-sm font-semibold">{dirty.length ? `Изменено: ${dirty.length}` : "Изменений нет"}</span>
          {trial && (
            <span className={clsx("rounded-full px-3 py-1 text-sm font-semibold", trial.delta.cars >= 0 ? "bg-run-soft text-run" : "bg-down-soft text-down")}>
              Модель: {trial.delta.cars >= 0 ? "+" : "−"}
              {num1(Math.abs(trial.delta.cars))} авто в день · {trial.delta.effect_kzt_month >= 0 ? "+" : "−"}
              {kzt(Math.abs(trial.delta.effect_kzt_month))} в месяц
            </span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            {p.changed && (
              <Button variant="ghost" size="sm" icon={<RotateCcw className="size-4" />} loading={reset.isPending} onClick={() => reset.mutate(undefined, { onSuccess: () => toast({ title: "Параметры возвращены к модели завода", tone: "run" }) })}>
                Всё по модели
              </Button>
            )}
            <Button size="sm" icon={<FlaskConical className="size-4" />} disabled={!areaChecks || invalid} loading={check.isPending} onClick={tryIt} title="Прогнать рабочий день с изменениями участков">
              Проверить на модели
            </Button>
            <Button variant="primary" size="sm" icon={<Save className="size-4" />} disabled={!dirty.length || invalid} loading={save.isPending} onClick={apply}>
              Применить
            </Button>
          </div>
          {check.error && <ErrorNote error={check.error} />}
        </div>
      )}

      <Panel title="Участки" hint="Время цикла на один кузов, сколько кузовов помещается в буфер после участка, уровень брака. Такт линии — 240 с.">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {p.areas.map((a) => (
            <div key={a.code} className={clsx("rounded-[18px] border px-4 py-4", a.changed.length ? "border-brand/40 bg-brand-soft/30" : "border-line bg-sunken/60")}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{a.name}</h3>
                {a.changed.length > 0 && <span className="rounded-full bg-brand px-2 py-0.5 text-2xs font-bold text-white">изменено</span>}
              </div>
              <div className="mt-3 grid gap-3">
                <Num label="Время цикла, с" k={`area:${a.code}:cycle_s`} draft={draft} base={base} set={set} admin={admin} hint={`по модели ${a.base.cycle_s} с`} />
                {a.has_buffer && <Num label="Буфер после, кузовов" k={`area:${a.code}:buffer`} draft={draft} base={base} set={set} admin={admin} hint={`по модели ${a.base.buffer}`} />}
                {a.has_defects && <Num label="Брак, %" k={`area:${a.code}:defect_pct`} draft={draft} base={base} set={set} admin={admin} hint={`по данным сейчас ${String(a.base.defect_pct).replace(".", ",")}%`} />}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Оборудование" hint="Наработка на отказ (MTBF) — сколько часов станок в среднем работает без поломки. Время ремонта — сколько минут чинят." bodyClass="px-0 pb-3">
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[0.8125rem] text-ink-3">
                <th className="py-2 pl-6 font-medium">Оборудование</th>
                <th className="py-2 font-medium">Участок</th>
                <th className="py-2 font-medium">Наработка на отказ, ч</th>
                <th className="py-2 pr-6 font-medium">Ремонт, мин</th>
              </tr>
            </thead>
            <tbody>
              {p.equipment.map((e) => (
                <tr key={e.code} className={clsx("border-b border-line last:border-b-0", e.changed.length && "bg-brand-soft/30")}>
                  <td className="py-2 pl-6">
                    <div className="font-semibold">
                      {e.code} {e.critical && <span className="ml-1 rounded-full bg-down-soft px-1.5 py-0.5 text-2xs font-bold text-down">критичное</span>}
                    </div>
                    <div className="text-xs text-ink-3">{e.name}</div>
                  </td>
                  <td className="py-2 text-ink-2">{p.areas.find((a) => a.code === e.area)?.name ?? e.area}</td>
                  <td className="py-2 pr-3">
                    <Num k={`eq:${e.code}:mtbf_h`} draft={draft} base={base} set={set} admin={admin} hint={`по модели ${e.base.mtbf_h}`} compact />
                  </td>
                  <td className="py-2 pr-6">
                    <Num k={`eq:${e.code}:mttr_min`} draft={draft} base={base} set={set} admin={admin} hint={`по модели ${e.base.mttr_min}`} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Поставки комплектов" hint="Как часто приходит машина с комплектами и сколько комплектов в одной поставке">
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <Num label="Интервал поставок, мин" k="supply:every_min" draft={draft} base={base} set={set} admin={admin} hint={`по модели ${p.supply.base.every_min}`} />
          <Num label="Комплектов в поставке" k="supply:size" draft={draft} base={base} set={set} admin={admin} hint={`по модели ${p.supply.base.size}`} />
        </div>
      </Panel>
      {!admin && <p className="px-1 text-sm text-ink-3">Менять параметры может администратор.</p>}
    </div>
  );
}

function Num({ label, k, draft, base, set, admin, hint, compact }: { label?: string; k: string; draft: Draft; base: Draft; set: (k: string, v: string) => void; admin: boolean; hint?: string; compact?: boolean }) {
  const changed = draft[k] !== base[k];
  const input = (
    <input
      inputMode="decimal"
      aria-label={label ?? k.split(":").slice(1).join(" ")}
      value={draft[k] ?? ""}
      disabled={!admin}
      onChange={(e) => set(k, e.target.value)}
      className={clsx(
        "num h-10 w-full min-w-0 rounded-[12px] border bg-panel px-3 text-sm transition-colors focus:border-accent focus:outline-none disabled:bg-transparent disabled:text-ink",
        changed ? "border-brand ring-2 ring-brand/15" : "border-line-strong",
        compact && "max-w-[8.5rem]",
      )}
    />
  );
  if (compact)
    return (
      <span className="flex items-center gap-2">
        {input}
        <span className="text-2xs whitespace-nowrap text-ink-3">{hint}</span>
      </span>
    );
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[0.8125rem] font-semibold text-ink-2">{label}</span>
      {input}
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </label>
  );
}
