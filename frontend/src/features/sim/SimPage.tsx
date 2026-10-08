import { clsx } from "clsx";
import { CircleGauge, Clock3, Factory, PackageX, Plus, Sparkles, TrendingDown, Trash2, Wrench } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ScenariosPage } from "@/features/scenarios/ScenariosPage";
import { useFloorSnapshot, usePlant, useRunSandbox } from "@/shared/api/queries";
import type { Plant, SimEventInput, SimEventKind } from "@/shared/api/types";
import { num, time } from "@/shared/lib/format";
import { useFloor } from "@/shared/realtime/live";
import { sim, useSim } from "@/shared/sim/store";
import { Button, IconButton } from "@/shared/ui/Button";
import { Field, Input, Select } from "@/shared/ui/Field";
import { ErrorNote, Panel } from "@/shared/ui/Panel";
import { Segmented } from "@/shared/ui/Segmented";

const KINDS: { kind: SimEventKind; label: string; hint: string; icon: ReactNode }[] = [
  { kind: "failure", label: "Поломка оборудования", hint: "Робот, камера, конвейер — что сломалось и сколько чинить", icon: <Wrench className="size-4" /> },
  { kind: "supply_delay", label: "Задержка поставки", hint: "Комплекты для сварки приедут позже", icon: <PackageX className="size-4" /> },
  { kind: "defects", label: "Рост брака", hint: "Например, сбой подачи краски на окраске", icon: <TrendingDown className="size-4" /> },
  { kind: "slowdown", label: "Участок медленнее", hint: "Нехватка людей, сбой подачи — цикл дольше", icon: <CircleGauge className="size-4" /> },
];

const LINE_AREAS = [
  { code: "WELD", name: "Сварка" },
  { code: "PAINT", name: "Окраска" },
  { code: "ASSY", name: "Сборка" },
  { code: "QC", name: "Контроль качества" },
];

type Draft = SimEventInput & { key: number };
let nextKey = 1;

function blank(kind: SimEventKind, equipment?: string): Draft {
  const base = { key: nextKey++, kind, at_min: 0 };
  if (kind === "failure") return { ...base, equipment: equipment ?? "Конвейер-03", minutes: 45, reason: null };
  if (kind === "supply_delay") return { ...base, minutes: 60 };
  if (kind === "defects") return { ...base, area: "PAINT", value: 8, minutes: 180 };
  return { ...base, area: "ASSY", value: 20, minutes: 120 };
}

export function SimPage() {
  const plant = usePlant();
  const snapshot = useFloorSnapshot();
  const live = useFloor();
  const floor = live ?? snapshot.data;
  const [params] = useSearchParams();
  const s = useSim();
  const run = useRunSandbox();
  const navigate = useNavigate();
  const [horizon, setHorizon] = useState<"shift" | "day">(s.result?.horizon ?? "shift");
  const [events, setEvents] = useState<Draft[]>(() => {
    if (s.result) return s.result.actions.map((a) => ({ ...a, key: nextKey++ }));
    return [blank("failure", params.get("eq") ?? undefined)];
  });

  useEffect(() => {
    const eq = params.get("eq");
    if (eq) setEvents((list) => (list.some((e) => e.equipment === eq) ? list : [blank("failure", eq), ...list.filter((e) => e.kind !== "failure" || e.equipment)]));
  }, [params]);

  const update = (key: number, patch: Partial<Draft>) => setEvents((list) => list.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  const working = floor?.working;

  const start = () =>
    run.mutate(
      { events: events.map(({ key: _k, ...e }) => e), horizon },
      {
        onSuccess: (r) => {
          sim.enter(r);
          navigate("/app");
        },
      },
    );

  return (
    <div className="grid grid-cols-12 gap-4">
      <section className="panel-deep rise col-span-12 overflow-hidden p-6 sm:p-8 lg:col-span-5" style={{ "--i": 0 } as CSSProperties}>
        <p className="text-xs font-bold tracking-wide text-white/60">СИМУЛЯЦИЯ С ТЕКУЩЕГО МОМЕНТА</p>
        <h2 className="mt-3 text-[clamp(1.6rem,2.6vw,2.2rem)] leading-tight font-light text-white">Что будет со сменой, если сейчас…</h2>
        <ol className="mt-6 flex flex-col gap-4">
          {[
            ["Опишите, что случилось", "Поломка, задержка поставки, брак или нехватка людей — одно или несколько событий."],
            ["Двойник проиграет линию вперёд", `С этой секунды и до ${horizon === "shift" ? "конца смены" : "конца дня"} — дважды: с событиями и без. Разница — цена события.`],
            ["Смотрите повтор и итог", "Цех проигрывает запись с перемоткой. Все разделы — показатели, качество, прогноз, ИИ — покажут результат."],
          ].map(([t, d], n) => (
            <li key={t} className="flex gap-3">
              <span className="display grid size-8 shrink-0 place-items-center rounded-full bg-brand text-sm font-medium text-white">{n + 1}</span>
              <div>
                <p className="font-semibold text-white">{t}</p>
                <p className="mt-0.5 text-sm text-deep-ink-2">{d}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-7 rounded-[16px] border border-white/10 bg-white/5 p-4">
          <p className="flex items-center gap-2 text-xs font-semibold text-white/60">
            <Factory className="size-4" aria-hidden /> Живой цех сейчас
          </p>
          {floor?.ready && working ? (
            <p className="mt-1.5 text-sm text-white">
              {time(floor.clock)} · смена {floor.shift.number} · выпущено {num(floor.kpi.finished)} из {floor.kpi.shift_plan}
              {floor.kpi.down_now ? ` · стоит оборудования: ${floor.kpi.down_now}` : " · всё работает"}
            </p>
          ) : (
            <p className="mt-1.5 text-sm text-white/80">Сейчас нерабочее время — симуляция запускается во время смены.</p>
          )}
          <p className="mt-2 text-xs text-white/50">Живой цех от симуляции не меняется — она считается на копии.</p>
        </div>
      </section>

      <Panel
        i={1}
        className="col-span-12 lg:col-span-7"
        title="События"
        hint="Время — от текущего момента цеха. Можно добавить до 8 событий."
        actions={
          events.length < 8 && (
            <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setEvents((l) => [...l, blank("failure")])}>
              Добавить событие
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-3">
          {events.map((e, n) => (
            <EventCard
              key={e.key}
              n={n + 1}
              e={e}
              plant={plant.data}
              onChange={(p) => update(e.key, p)}
              onRemove={events.length > 1 ? () => setEvents((l) => l.filter((x) => x.key !== e.key)) : undefined}
            />
          ))}
        </div>

        <div className="mt-5 flex flex-col gap-4 rounded-[18px] bg-sunken p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[0.8125rem] font-semibold text-ink-2">Сколько проиграть вперёд</p>
            <div className="mt-2">
              <Segmented
                label="Горизонт симуляции"
                value={horizon}
                onChange={setHorizon}
                options={[
                  { value: "shift", label: `До конца смены${floor?.shift.end ? ` (${time(floor.shift.end)})` : ""}` },
                  { value: "day", label: "До конца дня" },
                ]}
              />
            </div>
          </div>
          <Button variant="primary" className="h-12 px-6 text-[0.95rem]" icon={<Sparkles className="size-4" />} loading={run.isPending} disabled={!working} onClick={start}>
            {s.result ? "Пересчитать симуляцию" : "Запустить симуляцию"}
          </Button>
        </div>
        {run.isPending && <p className="mt-3 text-sm text-ink-3">Двойник проигрывает линию вперёд несколько раз — это займёт 2–4 секунды…</p>}
        {run.error && (
          <div className="mt-3">
            <ErrorNote error={run.error} />
          </div>
        )}
      </Panel>

      <section className="col-span-12 mt-6 px-1">
        <h2 className="text-[1.6rem] font-light tracking-[-0.02em]">Решения на завтра</h2>
        <p className="mt-1 max-w-[80ch] text-[0.95rem] text-ink-3">
          Другой вопрос — не «что случилось», а «что если мы решим»: ускорить окраску, увеличить буфер, добавить сверхурочные. Двойник проживает
          следующий день с решением и без него.
        </p>
      </section>
      <div className="col-span-12">
        <ScenariosPage />
      </div>
    </div>
  );
}

function EventCard({ n, e, plant, onChange, onRemove }: { n: number; e: Draft; plant?: Plant; onChange: (p: Partial<Draft>) => void; onRemove?: () => void }) {
  const kind = KINDS.find((k) => k.kind === e.kind) ?? KINDS[0];
  const groups = useMemo(() => {
    const eq = plant?.equipment ?? [];
    return LINE_AREAS.map((a) => ({ ...a, items: eq.filter((x) => x.area === a.code) }));
  }, [plant]);
  const eqInfo = plant?.equipment.find((x) => x.code === e.equipment);

  return (
    <div className="rounded-[18px] border border-line bg-panel p-4 shadow-[0_1px_2px_rgb(60_16_14/0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={`Тип события ${n}`}>
          <span className="display mr-1 grid size-7 place-items-center rounded-full bg-ink text-xs text-white">{n}</span>
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={e.kind === k.kind}
              title={k.hint}
              onClick={() => e.kind !== k.kind && onChange({ ...blank(k.kind), key: e.key })}
              className={clsx(
                "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-semibold transition-colors",
                e.kind === k.kind ? "bg-brand text-white" : "bg-sunken text-ink-2 hover:text-ink",
              )}
            >
              {k.icon}
              <span className="hidden sm:inline">{k.label}</span>
            </button>
          ))}
        </div>
        {onRemove && (
          <IconButton label="Убрать событие" onClick={onRemove}>
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-3 sm:hidden">{kind.label}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {e.kind === "failure" && (
          <>
            <Field label="Что сломалось" className="sm:col-span-2">
              <Select value={e.equipment ?? ""} onChange={(ev) => onChange({ equipment: ev.target.value, reason: null })}>
                {groups.map((g) => (
                  <optgroup key={g.code} label={g.name}>
                    {g.items.map((x) => (
                      <option key={x.code} value={x.code}>
                        {x.code} — {x.name}
                        {x.critical ? "" : " (замедляет)"}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <Field label="Причина">
              <Select value={e.reason ?? ""} onChange={(ev) => onChange({ reason: ev.target.value || null })}>
                <option value="">Не важно</option>
                {(eqInfo?.modes ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <MinutesField label="Ремонт займёт" value={e.minutes} onChange={(m) => onChange({ minutes: m })} presets={[15, 30, 45, 60, 90, 120, 180]} />
          </>
        )}
        {e.kind === "supply_delay" && (
          <MinutesField label="Задержка" value={e.minutes} onChange={(m) => onChange({ minutes: m })} presets={[30, 60, 90, 120, 180]} className="sm:col-span-2" />
        )}
        {(e.kind === "defects" || e.kind === "slowdown") && (
          <>
            <Field label="Участок">
              <Select value={e.area ?? ""} onChange={(ev) => onChange({ area: ev.target.value })}>
                {LINE_AREAS.filter((a) => e.kind === "slowdown" || a.code !== "QC").map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={e.kind === "defects" ? "Брак вырастет до" : "Цикл медленнее на"}>
              <Select value={e.value ?? 0} onChange={(ev) => onChange({ value: Number(ev.target.value) })}>
                {(e.kind === "defects" ? [3, 5, 8, 12, 20, 30] : [10, 20, 30, 50, 75]).map((v) => (
                  <option key={v} value={v}>
                    {v}%
                  </option>
                ))}
              </Select>
            </Field>
            <MinutesField label="Сколько длится" value={e.minutes} onChange={(m) => onChange({ minutes: m })} presets={[30, 60, 120, 240, 480]} />
          </>
        )}
        <Field label="Когда" className={e.kind === "supply_delay" ? "sm:col-span-2 lg:col-span-1" : undefined}>
          <Select value={e.at_min} onChange={(ev) => onChange({ at_min: Number(ev.target.value) })}>
            {[0, 10, 30, 60, 120, 180].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "Сейчас" : `Через ${m >= 60 ? `${m / 60} ч` : `${m} мин`}`}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {e.kind === "failure" && eqInfo && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-3">
          <Clock3 className="size-3.5" aria-hidden />
          {eqInfo.critical ? "Критичное: пока чинят, участок стоит целиком." : "Некритичное: участок работает, но медленнее."} Наработка на отказ ~{num(eqInfo.mtbf_h)} ч.
        </p>
      )}
    </div>
  );
}

function MinutesField({ label, value, onChange, presets, className }: { label: string; value: number; onChange: (m: number) => void; presets: number[]; className?: string }) {
  const [own, setOwn] = useState(!presets.includes(value));
  const custom = own || !presets.includes(value);
  return (
    <Field label={label} className={className}>
      <div className="flex gap-2">
        <Select
          value={custom ? "custom" : value}
          onChange={(ev) => {
            const v = ev.target.value;
            setOwn(v === "custom");
            if (v !== "custom") onChange(Number(v));
          }}
        >
          {presets.map((m) => (
            <option key={m} value={m}>
              {m >= 60 ? `${m / 60} ч${m % 60 ? ` ${m % 60} мин` : ""}` : `${m} мин`}
            </option>
          ))}
          <option value="custom">Своё…</option>
        </Select>
        {custom && (
          <Input
            type="number"
            min={1}
            max={900}
            aria-label={`${label}, минут`}
            className="w-24"
            value={value}
            onChange={(ev) => onChange(Math.max(1, Math.min(900, Number(ev.target.value) || 1)))}
          />
        )}
      </div>
    </Field>
  );
}
