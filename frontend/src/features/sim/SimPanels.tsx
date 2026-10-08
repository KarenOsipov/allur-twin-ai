import { clsx } from "clsx";
import { ArrowLeftRight, Pause, Pencil, Play, RotateCcw, Undo2 } from "lucide-react";
import type { CSSProperties } from "react";
import { Link } from "react-router";
import type { SandboxResult, SimLogEntry } from "@/shared/api/types";
import { LineChart } from "@/shared/charts/charts";
import { kzt, num, num1, time } from "@/shared/lib/format";
import { SIM_SPEEDS, sim, useSim } from "@/shared/sim/store";
import { Panel } from "@/shared/ui/Panel";

const ms = (s: string) => new Date(s).getTime();

export function SimPlayer({ r }: { r: SandboxResult }) {
  const s = useSim();
  const last = r.frames.length - 1;
  const frame = r.frames[Math.floor(s.playhead)];
  const t0 = ms(r.start);
  const span = Math.max(ms(r.end) - t0, 1);
  const pos = (t: string) => Math.min(100, Math.max(0, ((ms(t) - t0) / span) * 100));
  const progress = last > 0 ? (s.playhead / last) * 100 : 0;
  const markers = r.log.filter((e) => ["down", "already_down", "supply", "defects", "slowdown", "shift_end"].includes(e.kind));

  return (
    <section className="panel-deep rise col-span-12 overflow-hidden p-5 sm:p-6" style={{ "--i": 0 } as CSSProperties}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => (s.playing ? sim.pause() : sim.play())}
            aria-label={s.playing ? "Пауза" : progress >= 99.9 ? "Смотреть заново" : "Смотреть"}
            className="grid size-14 shrink-0 place-items-center rounded-full bg-brand text-white shadow-[0_10px_24px_-10px_rgb(227_36_27/0.9)] transition-transform hover:scale-105 active:scale-95"
          >
            {s.playing ? <Pause className="size-6" /> : progress >= 99.9 ? <RotateCcw className="size-6" /> : <Play className="size-6 translate-x-0.5" />}
          </button>
          <div>
            <p className="text-xs font-bold tracking-wide text-white/55">ПОВТОР СИМУЛЯЦИИ</p>
            <p className="display num text-[2.2rem] leading-none font-light text-white">{frame ? time(frame.clock) : "—"}</p>
          </div>
        </div>

        <div role="radiogroup" aria-label="Скорость повтора" className="flex rounded-full bg-white/8 p-1">
          {SIM_SPEEDS.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={s.speed === v}
              onClick={() => sim.setSpeed(v)}
              className={clsx("h-8 rounded-full px-3 text-xs font-bold transition-colors", s.speed === v ? "bg-white text-ink" : "text-white/70 hover:text-white")}
            >
              {v / 60} мин/с
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1 basis-[260px]">
          <p className="text-xs font-semibold text-white/55">Введено</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {r.actions.map((a) => (
              <li key={a.title} className="rounded-full bg-brand/25 px-2.5 py-1 text-xs font-semibold text-white ring-1 ring-brand/50">
                {a.title}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex gap-2">
          <Link to="/app/sim" className="inline-flex h-10 items-center gap-2 rounded-full bg-white/10 px-4 text-sm font-semibold text-white hover:bg-white/15">
            <Pencil className="size-4" aria-hidden /> Изменить
          </Link>
          <button type="button" onClick={() => sim.exit()} className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-ink hover:bg-white/90">
            <Undo2 className="size-4" aria-hidden /> В реальное время
          </button>
        </div>
      </div>

      <div className="relative mt-6 pb-6">
        <div className="relative h-2 rounded-full bg-white/10">
          <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${progress}%` }} />
          {markers.map((e, i) => (
            <span
              key={`${e.t}${i}`}
              title={`${time(e.t)} — ${e.title}`}
              className={clsx(
                "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-deep",
                e.kind === "shift_end" ? "h-4 w-0.5 rounded-none bg-white/50 ring-0" : e.user ? "size-3.5 bg-white" : e.kind === "down" || e.kind === "already_down" ? "size-2.5 bg-down" : "size-2.5 bg-blocked",
              )}
              style={{ left: `${pos(e.t)}%` }}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={Math.floor(s.playhead)}
          onChange={(e) => {
            sim.pause();
            sim.seek(Number(e.target.value));
          }}
          aria-label="Перемотка симуляции"
          aria-valuetext={frame ? time(frame.clock) : undefined}
          className="sim-range absolute inset-x-0 -top-2 h-6 w-full cursor-pointer appearance-none bg-transparent"
        />
        <div className="absolute inset-x-0 bottom-0 flex justify-between text-[11px] font-semibold text-white/50">
          <span>{time(r.start)} · сейчас</span>
          <span className="hidden items-center gap-3 sm:flex">
            <Legend color="bg-white" label="введённое событие" />
            <Legend color="bg-down" label="случайный отказ" />
            <Legend color="bg-blocked" label="поставка / брак" />
          </span>
          <span>{time(r.end)}</span>
        </div>
      </div>
    </section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx("size-2 rounded-full", color)} /> {label}
    </span>
  );
}

export function SimResultPanel({ r, className }: { r: SandboxResult; className?: string }) {
  const s = useSim();
  const sm = r.summary;
  const labels = r.series.baseline.map((p) => time(p.t));
  const n = r.series.scenario.length;
  const at = r.frames.length > 1 ? (s.playhead / (r.frames.length - 1)) * (n - 1) : 0;
  const lost = sm.mean.lost;
  return (
    <Panel
      i={6}
      className={className}
      title="Итог симуляции"
      hint={`Двойник прожил окно ${time(r.start)}–${time(r.end)} ${sm.mean.runs} раз с событиями и без них. Повтор на схеме — один из этих прогонов.`}
    >
      <p className="display max-w-[70ch] text-[1.15rem] leading-snug font-light">{sm.verdict}</p>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Без событий" value={`≈ ${num(sm.mean.baseline)}`} note={`авто к ${time(r.end)}`} />
        <Stat label="С событиями" value={`≈ ${num(sm.mean.scenario)}`} note={sm.plan.cars ? `план ${num(sm.plan.cars)}` : "авто"} />
        <Stat
          label="Потеря"
          tone={lost >= 0.5 ? "bad" : "ok"}
          value={lost >= 0.5 ? `−${num1(lost)}` : "≈ 0"}
          note={sm.mean.lost_high !== sm.mean.lost_low ? `от ${sm.mean.lost_low} до ${sm.mean.lost_high} авто` : "авто"}
        />
        <Stat label="Цена" tone={sm.money_kzt > 0 ? "bad" : "ok"} value={kzt(sm.money_kzt)} note={`маржа ${kzt(sm.margin_per_car)} за авто`} />
      </div>
      <div className="mt-6">
        <LineChart
          labels={labels}
          series={[
            { name: "Без событий", color: "var(--color-ink-3)", values: r.series.baseline.map((p) => p.cars), dashed: true },
            { name: "С событиями (этот прогон)", color: "var(--color-brand)", values: r.series.scenario.map((p) => p.cars) },
          ]}
          marker={{ at, label: "повтор" }}
          format={(v) => num(v)}
          height={220}
        />
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Compare label="Простой критичного оборудования" a={`${sm.downtime_min.baseline} мин`} b={`${sm.downtime_min.scenario} мин`} />
        <Compare label="Брак за окно" a={`${sm.defects.baseline}`} b={`${sm.defects.scenario}`} />
      </dl>
    </Panel>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "bad" | "ok" }) {
  return (
    <div className={clsx("rounded-[16px] p-4", tone === "bad" ? "bg-brand-soft" : "bg-sunken")}>
      <p className="eyebrow">{label}</p>
      <p className={clsx("display num mt-1 text-[1.9rem] leading-none font-light", tone === "bad" && "text-brand")}>{value}</p>
      <p className="mt-1 text-xs text-ink-3">{note}</p>
    </div>
  );
}

function Compare({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[14px] border border-line px-4 py-2.5">
      <dt className="text-ink-2">{label}</dt>
      <dd className="flex items-center gap-2 font-semibold">
        <span className="text-ink-3">{a}</span>
        <ArrowLeftRight className="size-3.5 text-ink-3" aria-hidden />
        <span>{b}</span>
      </dd>
    </div>
  );
}

const KIND: Record<string, { label: string; dot: string; bg: string }> = {
  down: { label: "Отказ", dot: "var(--color-down)", bg: "bg-down-soft" },
  already_down: { label: "Уже стояло", dot: "var(--color-down)", bg: "bg-down-soft" },
  up: { label: "Ремонт завершён", dot: "var(--color-run)", bg: "bg-sunken" },
  supply: { label: "Поставка", dot: "var(--color-blocked)", bg: "bg-blocked-soft" },
  supply_end: { label: "Поставка", dot: "var(--color-run)", bg: "bg-sunken" },
  defects: { label: "Качество", dot: "var(--color-blocked)", bg: "bg-blocked-soft" },
  defects_end: { label: "Качество", dot: "var(--color-run)", bg: "bg-sunken" },
  slowdown: { label: "Темп", dot: "var(--color-blocked)", bg: "bg-blocked-soft" },
  slowdown_end: { label: "Темп", dot: "var(--color-run)", bg: "bg-sunken" },
  shift_end: { label: "Смена", dot: "var(--color-ink-3)", bg: "bg-sunken" },
};

export function SimLog({ r, className }: { r: SandboxResult; className?: string }) {
  const s = useSim();
  const frame = r.frames[Math.floor(s.playhead)];
  const now = frame ? ms(frame.clock) : ms(r.start);
  const past = r.log.filter((e) => ms(e.t) <= now).reverse();
  const ahead = r.log.length - past.length;
  return (
    <Panel i={7} className={className} title="Хронология симуляции" hint={`Что случилось к ${frame ? time(frame.clock) : "—"}${ahead ? ` · впереди ещё ${ahead}` : ""}`}>
      {past.length === 0 ? (
        <p className="text-sm text-ink-2">Пока событий нет — нажмите «Смотреть» или перемотайте таймлайн.</p>
      ) : (
        <ol className="scroll-thin flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
          {past.map((e, i) => (
            <LogRow key={`${e.t}${i}`} e={e} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function LogRow({ e }: { e: SimLogEntry }) {
  const k = KIND[e.kind] ?? KIND.shift_end;
  return (
    <li className={clsx("flex gap-3 rounded-[14px] p-3", k.bg, e.user && "ring-2 ring-brand/40")}>
      <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: k.dot }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-bold">{e.title}</span>
          <span className="num shrink-0 text-xs font-semibold text-ink-3">{time(e.t)}</span>
        </div>
        <p className="mt-0.5 text-xs font-semibold text-ink-3">
          {k.label}
          {e.user ? " · введено вами" : e.kind === "down" ? " · случайный отказ модели" : ""}
        </p>
      </div>
    </li>
  );
}
