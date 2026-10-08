import { clsx } from "clsx";
import { ArrowUp, BrainCircuit, ChevronDown, CircleCheck, Factory, Gauge, LoaderCircle, RefreshCw, ShieldAlert, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { AdviceCard } from "@/features/economics/EconomicsPage";
import { useAdvice, useAsk, useInsights, useReport, useShiftForecast, useSuggestions } from "@/shared/api/queries";
import type { Answer } from "@/shared/api/types";
import { kzt, num, pct } from "@/shared/lib/format";
import { useFloor } from "@/shared/realtime/live";
import { useSim } from "@/shared/sim/store";
import { Button, IconButton } from "@/shared/ui/Button";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { AnswerText } from "./AnswerText";

interface Turn {
  q: string;
  a?: Answer;
  error?: string;
}

let saved: Turn[] = [];

const AREA: Record<string, string> = { WELD: "сварка", PAINT: "окраска", ASSY: "сборка", QC: "контроль качества" };
const HEAD = { ok: "text-white", warn: "text-lane", bad: "text-brand-2" };

export function AiPage() {
  const s = useSim();
  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-12 flex flex-col gap-4 xl:col-span-8">
        {s.result && (
          <p className="rounded-[16px] bg-deep px-4 py-3 text-sm text-white/85">Открыта симуляция: выводы ниже — как будто введённые события уже случились.</p>
        )}
        <Situation />
        <Actions />
        <Risks />
        <Report />
        <HowItWorks />
      </div>
      <Chat className="col-span-12 xl:col-span-4" />
    </div>
  );
}

function Situation() {
  const floor = useFloor();
  const fc = useShiftForecast();
  const ins = useInsights();
  const f = ins.data?.forecast;
  const q = (ins.data?.quality ?? []).filter((x) => x.status !== "ok").sort((a, b) => b.level - a.level)[0];
  const k = floor?.kpi;
  const behind = k ? k.finished - k.plan_to_now : 0;
  const late = !!fc.data?.available && fc.data.expected < fc.data.plan * 0.97;
  const cards: { icon: typeof Factory; title: string; tone: "ok" | "warn" | "bad"; head: ReactNode; text: ReactNode }[] = [];
  if (floor?.ready && k) {
    cards.push({
      icon: Factory,
      title: floor.working ? `Смена ${floor.shift.number} сейчас` : "Сейчас вне смены",
      tone: behind < -5 ? "bad" : behind < 0 || late ? "warn" : "ok",
      head: floor.working
        ? behind < 0
          ? `Отстаём на ${Math.abs(behind)} авто`
          : late
            ? `К концу смены не хватит ~${fc.data!.plan - fc.data!.expected} авто`
            : "Идём по плану"
        : "Линия стоит по графику",
      text: floor.working ? (
        <>
          Выпущено {k.finished} при плане к этому часу {k.plan_to_now}.{" "}
          {fc.data?.available && <>К концу смены ожидается {fc.data.expected} из {fc.data.plan}. </>}
          {k.down_now > 0 && <b>Сейчас стоит оборудование: {k.down_now}. </b>}
          {k.bottleneck && <>Сдерживает выпуск {AREA[k.bottleneck] ?? k.bottleneck}.</>}
        </>
      ) : (
        "Следующая смена начнётся по графику. Ниже — выводы по истории и прогнозам."
      ),
    });
  }
  if (f?.available) {
    cards.push({
      icon: Gauge,
      title: "План месяца",
      tone: f.probability >= 80 ? "ok" : f.probability >= 50 ? "warn" : "bad",
      head: f.probability >= 80 ? `Выполним: ~${num(f.expected)} из ${num(f.target)}` : `Под угрозой: ${f.probability}% шанс`,
      text: (
        <>
          Сейчас темп {num(f.daily_rate)} авто в сутки, нужно {num(f.need_daily ?? 0)}. В плохом сценарии выйдет {num(f.p10)}, в хорошем — {num(f.p90)}.
        </>
      ),
    });
  }
  if (q) {
    cards.push({
      icon: TriangleAlert,
      title: "Главная проблема",
      tone: q.status === "critical" ? "bad" : "warn",
      head: `Брак ${q.name.toLowerCase()}: ${pct(q.level)}`,
      text: (
        <>
          Норма {pct(q.target, 0)}. {q.causes[0]?.text ?? "Причина ищется в данных."} {q.days_over > 0 && `Выше нормы ${q.days_over} дн. подряд.`}
        </>
      ),
    });
  }
  if (!cards.length) return <Skeleton className="h-48" />;
  return (
    <section className="panel-deep rise p-5 sm:p-7" style={{ "--i": 0 } as CSSProperties}>
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-[12px] bg-brand text-white">
          <BrainCircuit className="size-5" aria-hidden />
        </span>
        <div>
          <h2 className="text-[1.3rem] text-white">Что происходит</h2>
          <p className="text-[0.8125rem] text-deep-ink-2">Коротко — по живому цеху, истории и прогнозам</p>
        </div>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {cards.map((c) => (
          <article key={c.title} className="rounded-[18px] bg-white/[0.06] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-deep-ink-2">
              <c.icon className="size-4" aria-hidden /> {c.title}
            </div>
            <p className={clsx("mt-2 text-[1.05rem] leading-snug font-semibold", HEAD[c.tone])}>{c.head}</p>
            <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-deep-ink-2">{c.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Actions() {
  const adv = useAdvice();
  const items = (adv.data?.items ?? []).filter((x) => x.worth_it).slice(0, 4);
  return (
    <Panel
      i={1}
      title="Что сделать — и что это даст"
      hint="Каждое действие проверено на модели линии: рабочий день прогнан 6 раз с действием и без. Эффект — в автомобилях и тенге, за вычетом затрат."
      actions={
        <Link to="/app/economics" className="text-sm font-semibold text-accent hover:underline">
          Экономика решений
        </Link>
      }
    >
      {adv.data?.status === "computing" && !items.length && (
        <p className="mb-3 inline-flex items-center gap-2 text-sm text-ink-3">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Прогоняю варианты на модели линии — около 15 секунд…
        </p>
      )}
      {!adv.data && <Skeleton className="h-40" />}
      <ol className="grid gap-3 lg:grid-cols-2">
        {items.map((x, n) => (
          <AdviceCard key={x.id} x={x} n={n + 1} />
        ))}
      </ol>
      {adv.data?.status === "ready" && !items.length && <p className="text-sm text-ink-2">Сейчас нет действий, которые окупаются: линия работает близко к своим возможностям.</p>}
    </Panel>
  );
}

function Risks() {
  const ins = useInsights();
  const risks = (ins.data?.risks ?? []).filter((r) => r.level !== "low").slice(0, 6);
  return (
    <Panel i={2} title="Что может сломаться в ближайшие 7 дней" hint="Вероятность отказа по истории поломок, наработке и износу. Чем выше — тем раньше стоит запланировать обслуживание.">
      {ins.isLoading ? (
        <Skeleton className="h-40" />
      ) : risks.length === 0 ? (
        <p className="text-sm text-ink-2">Высоких рисков нет.</p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {risks.map((r) => (
            <li key={r.code} className="flex gap-3 rounded-[16px] bg-sunken px-4 py-3">
              <ShieldAlert className={clsx("mt-0.5 size-4 shrink-0", r.level === "high" ? "text-down" : "text-blocked")} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-bold">{r.code}</span>
                  <span className={clsx("display num text-lg font-light", r.level === "high" ? "text-down" : "text-ink")}>{pct(r.probability * 100, 0)}</span>
                </div>
                <p className="text-xs text-ink-2">
                  {r.main_reason ?? "отказ"} · {r.factors[0]}
                </p>
                {r.expected_loss_kzt > 0 && <p className="mt-0.5 text-xs text-ink-3">ожидаемые потери ~{kzt(r.expected_loss_kzt)} за неделю</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Report() {
  const report = useReport();
  const [open, setOpen] = useState(false);
  return (
    <section className="panel rise overflow-hidden" style={{ "--i": 3 } as CSSProperties}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-6 py-5 text-left">
        <span>
          <span className="block text-[1.1875rem]">Подробный разбор текстом</span>
          <span className="mt-0.5 block text-[0.8125rem] text-ink-3">Сводка для записки или письма — её же можно скачать PDF-документом</span>
        </span>
        <ChevronDown className={clsx("size-5 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="border-t border-line px-6 py-5">
          <div className="mb-3 flex justify-end">
            <Button size="sm" variant="ghost" icon={<RefreshCw className={clsx("size-4", report.isFetching && "animate-spin")} />} onClick={() => report.refetch()} disabled={report.isFetching}>
              Обновить
            </Button>
          </div>
          {report.isLoading ? <Skeleton className="h-32" /> : report.error ? <ErrorNote error={report.error} /> : report.data ? <AnswerText text={report.data.text} /> : null}
        </div>
      )}
    </section>
  );
}

function HowItWorks() {
  const ins = useInsights();
  const m = ins.data?.risk_model;
  const steps = [
    ["Данные", "Таблицы заказчика, история смен, простои, брак, сообщения рабочих и живой цех в реальном времени."],
    ["Модели", `Тренды брака, прогноз плана месяца, риск отказа оборудования${m ? ` (${m.model}, обучено на ${num(m.trained_on)} примерах${m.auc ? `, точность AUC ${m.auc.toFixed(2).replace(".", ",")}` : ""})` : ""}.`],
    ["Симуляция", "Каждое решение и каждая поломка прогоняются на копии линии много раз — так видно эффект, а не случайность."],
    ["Вывод", "Деньги — в тенге по экономическим допущениям завода. Текст сводки составляется только из этих цифр."],
  ];
  return (
    <section className="rounded-[var(--radius-block)] border border-line bg-panel/60 px-6 py-5">
      <h2 className="text-[1rem] font-semibold">Как получен анализ</h2>
      <ol className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map(([t, d], i) => (
          <li key={t} className="flex gap-3">
            <span className="display num grid size-7 shrink-0 place-items-center rounded-full bg-sunken text-sm">{i + 1}</span>
            <span>
              <span className="block text-sm font-semibold">{t}</span>
              <span className="block text-xs text-ink-3">{d}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-ink-3">
        <CircleCheck className="size-3.5 text-run" aria-hidden /> Каждая цифра берётся из системы — её можно проверить на соответствующей странице.
      </p>
    </section>
  );
}

function Chat({ className }: { className?: string }) {
  const [turns, setTurnsState] = useState<Turn[]>(saved);
  const setTurns = (fn: (t: Turn[]) => Turn[]) =>
    setTurnsState((t) => {
      const next = fn(t);
      saved = next;
      return next;
    });
  const [text, setText] = useState("");
  const ask = useAsk();
  const suggestions = useSuggestions();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = (q: string) => {
    const question = q.trim();
    if (question.length < 2 || ask.isPending) return;
    setText("");
    setTurns((t) => [...t, { q: question }]);
    ask.mutate(question, {
      onSuccess: (a) => setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, a } : x))),
      onError: (e) => setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: e.message } : x))),
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(text);
  };

  return (
    <section className={clsx("panel rise flex h-[min(78vh,820px)] min-h-[520px] flex-col overflow-hidden xl:sticky xl:top-24", className)} style={{ "--i": 3 } as CSSProperties}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-2.5">
          <Sparkles className="size-4 text-brand" aria-hidden />
          <h2 className="text-[1.1rem]">Спросить двойник</h2>
        </div>
        {turns.length > 0 && (
          <IconButton label="Очистить диалог" onClick={() => setTurns(() => [])}>
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </header>

      <div ref={box} className="scroll-thin flex-1 overflow-y-auto px-5 py-5">
        {turns.length === 0 && (
          <div>
            <p className="text-sm text-ink-2">Отвечает по данным завода: показатели, прогнозы, риски, живой цех и симуляция. Цифры берутся только из системы.</p>
            <p className="mt-5 text-xs font-semibold text-ink-3">Попробуйте спросить</p>
            <div className="mt-2 flex flex-col gap-2">
              {suggestions.data?.map((q) => (
                <button key={q} type="button" onClick={() => send(q)} className="rounded-[14px] border border-line-strong bg-panel px-3.5 py-2.5 text-left text-sm text-ink transition-colors hover:border-brand/50 hover:bg-brand-soft">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-5">
          {turns.map((t, i) => (
            <div key={i} className="flex flex-col gap-2" style={{ animation: "fade-up .3s var(--ease-out)" }}>
              <div className="max-w-[85%] self-end rounded-[16px] rounded-br-[5px] bg-ink px-4 py-2.5 text-sm text-white">{t.q}</div>
              {t.a ? (
                <div className="rounded-[16px] rounded-bl-[5px] border border-line bg-sunken px-4 py-3.5">
                  <AnswerText text={t.a.text} />
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                    {t.a.links.map((l) => (
                      <Link key={l.to} to={l.to} className="font-semibold text-accent hover:underline">
                        {l.label} →
                      </Link>
                    ))}
                  </div>
                </div>
              ) : t.error ? (
                <div role="alert" className="text-sm text-down">
                  {t.error}
                </div>
              ) : (
                <div className="flex items-center gap-2 px-1 py-2 text-xs text-ink-3" aria-label="Готовлю ответ">
                  {[0, 1, 2].map((d) => (
                    <span key={d} className="size-1.5 animate-pulse rounded-full bg-brand" style={{ animationDelay: `${d * 150}ms` }} />
                  ))}
                  думаю над ответом…
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <form onSubmit={submit} className="border-t border-line bg-panel p-3">
        <label htmlFor="ask" className="sr-only">
          Вопрос
        </label>
        <div className="flex items-end gap-2 rounded-[16px] border border-line-strong bg-sunken p-1.5 focus-within:border-accent focus-within:bg-panel">
          <textarea
            id="ask"
            rows={1}
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
            placeholder="Например: почему вчера недовыпустили?"
            className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-ink-3"
          />
          <Button type="submit" variant="primary" size="sm" className="size-9 !px-0" aria-label="Отправить" disabled={text.trim().length < 2 || ask.isPending}>
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </form>
    </section>
  );
}
