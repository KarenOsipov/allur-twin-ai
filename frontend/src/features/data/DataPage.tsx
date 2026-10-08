import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ClipboardPaste, DatabaseBackup, Download, FileUp, RotateCcw, Upload as UploadIcon } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { Link } from "react-router";
import { download, request } from "@/shared/api/client";
import { useChecks, useDataSummary, useImport, useImportText, useResetData, useTable } from "@/shared/api/queries";
import type { ImportResult } from "@/shared/api/types";
import { can, useSession } from "@/shared/auth/session";
import { dateTime, dayLong, num } from "@/shared/lib/format";
import { Button } from "@/shared/ui/Button";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { Segmented } from "@/shared/ui/Segmented";
import { toast } from "@/shared/ui/Toaster";
import { DbPanel } from "./DbPanel";
import { ParamsEditor } from "./ParamsEditor";

const LEVEL = {
  critical: { label: "Противоречие", cls: "border-down/30 bg-down-soft", tag: "text-down" },
  warning: { label: "Риск", cls: "border-blocked/30 bg-blocked-soft", tag: "text-blocked" },
  info: { label: "Наблюдение", cls: "border-line bg-sunken", tag: "text-ink-2" },
};

const SOURCE = { customer: "Данные заказчика", history: "История (сгенерирована)", live: "Живой цех", import: "Загружено" } as const;

type Tab = "params" | "input" | "tables" | "dataset" | "db";
const TAB_KEY = "allur.data.tab";

export function DataPage() {
  const s = useSession();
  const admin = can(s, "manage_data");
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem(TAB_KEY) as Tab) || "params";
    } catch {
      return "params";
    }
  });
  const pick = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Раздел"
          value={tab}
          onChange={pick}
          options={[
            { value: "params", label: "Параметры линии" },
            { value: "input", label: "Ввод данных" },
            { value: "tables", label: "Таблицы" },
            ...(admin ? [{ value: "dataset" as Tab, label: "Набор данных" }] : []),
            { value: "db" as Tab, label: "База данных" },
          ]}
        />
        <p className="text-[0.8125rem] text-ink-3">
          Экономические допущения — на странице{" "}
          <Link to="/app/economics" className="font-semibold text-accent hover:underline">
            «Экономика»
          </Link>
          {can(s, "manage_users") && (
            <>
              , сотрудники и PIN —{" "}
              <Link to="/app/staff" className="font-semibold text-accent hover:underline">
                «Сотрудники»
              </Link>
            </>
          )}
        </p>
      </div>
      {tab === "params" && <ParamsEditor admin={admin} />}
      {tab === "input" && (
        <>
          <Upload admin={admin} />
          <Checks />
        </>
      )}
      {tab === "tables" && (
        <>
          <Summary />
          <Tables />
        </>
      )}
      {tab === "dataset" && admin && <Dataset />}
      {tab === "db" && <DbPanel />}
    </div>
  );
}

function Dataset() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const reset = useResetData();
  const load = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await request<{ counts: Record<string, number> }>("/data/dataset", { method: "POST", body: fd });
      qc.invalidateQueries();
      toast({ title: "Набор данных загружен", body: Object.entries(r.counts).map(([k, v]) => `${k}: ${v}`).join(", "), tone: "run" });
    } catch (e) {
      toast({ title: "Не удалось загрузить набор", body: (e as Error).message, tone: "down" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Сохранить набор данных" hint="Один файл dataset.json: сотрудники (PIN только в виде хэша), параметры линии, экономика, загруженные таблицы, проекты конструктора, смены, инциденты и журнал.">
        <Button variant="primary" icon={<Download className="size-4" />} onClick={() => download("/data/dataset.json", "dataset.json").catch((e) => toast({ title: e.message, tone: "down" }))}>
          Скачать dataset.json
        </Button>
        <p className="mt-4 text-sm text-ink-2">
          Чтобы у всех, кто скачает проект, при первом запуске были именно эти данные, положите файл в <code className="rounded bg-sunken px-1.5 py-0.5 text-[0.8125rem]">backend/app/seed/dataset.json</code>.
        </p>
      </Panel>
      <Panel title="Загрузить набор данных" hint="Разделы из файла заменят текущие. Сгенерированная история производства не трогается.">
        <div className="flex flex-wrap gap-2">
          <Button icon={<DatabaseBackup className="size-4" />} loading={busy} onClick={() => input.current?.click()}>
            Выбрать dataset.json
          </Button>
          <Button variant="ghost" icon={<RotateCcw className="size-4" />} loading={reset.isPending} onClick={() => reset.mutate(undefined, { onSuccess: () => toast({ title: "Таблицы возвращены к исходным", tone: "run" }) })}>
            Сбросить таблицы к исходным
          </Button>
        </div>
        <input ref={input} type="file" accept=".json,application/json" className="sr-only" aria-label="Файл набора данных" onChange={(e) => load(e.target.files?.[0])} />
      </Panel>
    </div>
  );
}

function Checks() {
  const q = useChecks();
  return (
    <Panel title="Что система заметила в данных заказчика" hint="Проверка согласованности таблиц: план, мощность, качество, простои">
      {q.error ? (
        <ErrorNote error={q.error} />
      ) : !q.data ? (
        <Skeleton className="h-40" />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {q.data.map((c) => (
            <li key={c.title} className={clsx("rounded-[14px] border px-4 py-3", LEVEL[c.level].cls)}>
              <span className={clsx("text-xs font-semibold", LEVEL[c.level].tag)}>{LEVEL[c.level].label}</span>
              <p className="mt-0.5 font-medium">{c.title}</p>
              <p className="mt-1 text-sm text-ink-2">{c.text}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Upload({ admin }: { admin: boolean }) {
  const imp = useImport();
  const paste = useImportText();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  const done = (r: ImportResult) => {
    setResult(r);
    toast({ title: `Принято строк: ${r.rows}`, body: r.review.length ? `Замечаний: ${r.review.length} — посмотрите ниже` : "Замечаний нет", tone: r.review.some((x) => x.level === "warning") ? "blocked" : "run" });
  };
  const send = (file: File | undefined) => {
    if (!file) return;
    imp.mutate(file, { onSuccess: done });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    send(e.dataTransfer.files[0]);
  };

  return (
    <Panel
      title="Ввести данные"
      hint="Любой вид: Word с таблицами, Excel, CSV, TSV, TXT, JSON — или просто вставьте таблицу текстом. Таблица определяется по смыслу заголовков, в том числе «Выпуск», «Станок», «date», «machine». Система проверит введённое и покажет, что изменилось в выводах."
    >
      {!admin ? (
        <p className="text-sm text-ink-2">Ввод данных доступен администратору. Параметры линии и таблицы можно посмотреть в соседних разделах.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            className={clsx(
              "flex w-full flex-col items-center gap-2 rounded-[16px] border-2 border-dashed px-6 py-8 text-center transition-colors",
              drag ? "border-accent bg-accent-soft" : "border-line-strong bg-sunken hover:border-ink-3",
            )}
          >
            <FileUp className="size-6 text-ink-2" aria-hidden />
            <span className="font-medium">{imp.isPending ? "Читаю файл…" : "Перетащите файл или выберите на компьютере"}</span>
            <span className="text-[0.8125rem] text-ink-3">.docx, .xlsx, .csv, .tsv, .txt, .json · до 5 МБ · строки за те же даты заменяются</span>
          </button>
          <input ref={input} type="file" accept=".docx,.xlsx,.csv,.tsv,.txt,.json" className="sr-only" onChange={(e) => send(e.target.files?.[0])} aria-label="Файл с данными" />
          {imp.error && (
            <div className="mt-3">
              <ErrorNote error={imp.error} />
            </div>
          )}
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="paste" className="inline-flex items-center gap-2 text-[0.8125rem] font-semibold text-ink-2">
              <ClipboardPaste className="size-4" aria-hidden /> Или вставьте таблицу текстом
            </label>
            <textarea
              id="paste"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder={"Дата\tУчасток\tВыпущено\tБрак\n07.10.2026\tОкраска\t118\t5"}
              className="num min-h-[132px] w-full resize-y rounded-[14px] border border-line-strong bg-sunken px-3.5 py-2.5 text-[0.8125rem] focus:border-accent focus:bg-panel focus:outline-none"
            />
            <Button
              variant="primary"
              className="self-start"
              icon={<UploadIcon className="size-4" />}
              disabled={text.trim().length < 5}
              loading={paste.isPending}
              onClick={() => paste.mutate({ text, name: "вставка из буфера" }, { onSuccess: done })}
            >
              Проверить и загрузить
            </Button>
            {paste.error && <ErrorNote error={paste.error} />}
          </div>
        </div>
      )}
      {result && (
          <>
            <div className="mt-4 text-sm">
              <p className="font-medium">{result.filename}</p>
              <ul className="mt-2 flex flex-col gap-1">
                {result.tables.map((t) => (
                  <li key={t.kind} className="flex justify-between gap-3">
                    <span className="text-ink-2">{t.title}</span>
                    <span className="num">{t.rows} строк</span>
                  </li>
                ))}
              </ul>
              {Object.keys(result.targets).length > 0 && (
                <p className="mt-2 text-ink-2">
                  Найдены целевые показатели: OEE ≥ {result.targets.oee_pct}%, брак ≤ {result.targets.defect_pct}%, простой ≤{" "}
                  {result.targets.critical_downtime_min_per_day} мин/сут, план ≥ {num(result.targets.month_output)}.
                </p>
              )}
              {result.notes.map((n) => (
                <p key={n} className="mt-2 text-ink-2">
                  {n}
                </p>
              ))}
              {result.errors.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-down">
                  {result.errors.slice(0, 5).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
            <Review result={result} />
          </>
      )}
    </Panel>
  );
}

function Review({ result }: { result: ImportResult }) {
  return (
    <div className="mt-4 grid gap-3 lg:grid-cols-2">
      <section className="rounded-[16px] bg-sunken px-4 py-3">
        <h3 className="text-sm font-semibold">Проверка введённого</h3>
        {result.review.length === 0 ? (
          <p className="mt-1 text-sm text-run">Значения выглядят правдоподобно — в пределах нормы и истории завода.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {result.review.map((r) => (
              <li key={r.text} className={clsx("rounded-[10px] px-3 py-1.5", r.level === "warning" ? "bg-blocked-soft text-ink" : "bg-panel text-ink-2")}>
                {r.text}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-[16px] bg-sunken px-4 py-3">
        <h3 className="text-sm font-semibold">Что изменилось в выводах</h3>
        {result.changes.length === 0 ? (
          <p className="mt-1 text-sm text-ink-2">Прогноз месяца и тренды брака почти не изменились.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm text-ink-2">
            {result.changes.map((c) => (
              <li key={c}>• {c}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink-3">Модель цеха перекалибрована по новому уровню брака — прогнозы и симуляции уже считают с ним.</p>
      </section>
    </div>
  );
}

function Summary() {
  const q = useDataSummary();
  const d = q.data;
  return (
    <Panel title="Что в базе" hint={d?.first_day && d.last_day ? `${dayLong(d.first_day)} — ${dayLong(d.last_day)}, ${d.days} рабочих дней` : undefined}>
      {!d ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            {(
              [
                ["production", "Смен по линиям"],
                ["quality", "Записей качества"],
                ["downtime", "Простоев"],
              ] as const
            ).map(([k, l]) => (
              <div key={k}>
                <dt className="text-ink-3">{l}</dt>
                <dd className="num text-lg font-semibold">{num(d.rows[k])}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-5 text-sm">Происхождение данных о выпуске</h3>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {Object.entries(d.production_by_source).map(([k, v]) => (
              <li key={k} className="flex justify-between gap-3">
                <span className="text-ink-2">{SOURCE[k as keyof typeof SOURCE] ?? k}</span>
                <span className="num">{num(v)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[0.8125rem] text-ink-3">
            Заказчик дал 2 дня данных. Для обучения моделей добавлена история за 3 месяца, сшитая с его таблицами. Строки заказчика
            всегда имеют приоритет.
          </p>
          {d.imports.length > 0 && (
            <>
              <h3 className="mt-5 text-sm">Последние загрузки</h3>
              <ul className="mt-2 flex flex-col gap-1 text-[0.8125rem]">
                {d.imports.slice(0, 4).map((i) => (
                  <li key={i.id} className="flex justify-between gap-3">
                    <span className="truncate">{i.filename}</span>
                    <span className="num shrink-0 text-ink-3">{dateTime(i.created_at)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Panel>
  );
}

const TABLES = [
  { value: "production", label: "Работа линий" },
  { value: "downtime", label: "Простои" },
  { value: "quality", label: "Качество" },
  { value: "model_plan", label: "План по моделям" },
];
const COLS: Record<string, [string, string][]> = {
  production: [["day", "Дата"], ["shift", "Смена"], ["line", "Линия"], ["plan", "План"], ["fact", "Факт"], ["run_hours", "Время работы, ч"], ["load_pct", "Загрузка, %"], ["source", "Источник"]],
  downtime: [["day", "Дата"], ["shift", "Смена"], ["area", "Участок"], ["equipment", "Оборудование"], ["reason", "Причина"], ["minutes", "Мин"], ["planned", "Плановый"], ["source", "Источник"]],
  quality: [["day", "Дата"], ["shift", "Смена"], ["area", "Участок"], ["produced", "Выпущено"], ["defects", "Брак"], ["source", "Источник"]],
  model_plan: [["month", "Месяц"], ["model", "Модель"], ["plan", "План"], ["source", "Источник"]],
};

function Tables() {
  const [kind, setKind] = useState("production");
  const [source, setSource] = useState("customer");
  const q = useTable(kind, source);
  const cols = COLS[kind];
  const fmt = (k: string, v: unknown) => {
    if (v == null) return "—";
    if (k === "day") return dayLong(String(v));
    if (k === "source") return SOURCE[v as keyof typeof SOURCE] ?? String(v);
    if (k === "planned") return v ? "да" : "нет";
    if (typeof v === "number") return Number.isInteger(v) ? num(v) : String(v).replace(".", ",");
    return String(v);
  };
  return (
    <Panel
      title="Таблицы"
      actions={
        kind !== "model_plan" && (
          <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={() => download(`/data/export/${kind}.csv`, `allur_${kind}.csv`).catch((e) => toast({ title: e.message, tone: "down" }))}>
            CSV для Excel
          </Button>
        )
      }
    >
      <div className="flex flex-wrap gap-3">
        <Segmented label="Таблица" value={kind} onChange={setKind} options={TABLES} />
        <Segmented
          label="Источник"
          value={source}
          onChange={setSource}
          options={[
            { value: "customer", label: "Заказчика" },
            { value: "live", label: "Живой цех" },
            { value: "", label: "Все" },
          ]}
        />
      </div>
      <div className="scroll-thin -mx-5 mt-3 max-h-[420px] overflow-auto">
        {!q.data ? (
          <div className="px-5">
            <Skeleton className="h-40" />
          </div>
        ) : q.data.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-2">Строк нет. Живой цех пишет итоги после закрытия каждой смены.</p>
        ) : (
          <table className="w-full min-w-[640px] text-sm">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-line text-left text-[0.8125rem] text-ink-3">
                {cols.map(([k, l]) => (
                  <th key={k} className="px-3 py-2 font-medium first:pl-5 last:pr-5">
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.map((row, i) => (
                <tr key={i} className="border-b border-line last:border-b-0">
                  {cols.map(([k]) => (
                    <td key={k} className="num px-3 py-2 first:pl-5 last:pr-5">
                      {fmt(k, row[k])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}
