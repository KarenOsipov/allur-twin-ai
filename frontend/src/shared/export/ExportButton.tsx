import { clsx } from "clsx";
import { Download, FileImage, FileSpreadsheet, FileText } from "lucide-react";
import { type RefObject, useState } from "react";
import { download, request } from "@/shared/api/client";
import { useSession } from "@/shared/auth/session";
import { sim, useSim } from "@/shared/sim/store";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { Field, Input } from "@/shared/ui/Field";
import { toast } from "@/shared/ui/Toaster";
import { exportPng } from "./pageExport";

export const exportState: { days: number; category?: string; builder?: () => unknown } = { days: 7 };

type Format = "pdf" | "xlsx" | "png";

const DOC: Record<string, string> = {
  floor: "floor",
  shift: "floor",
  kpi: "kpi",
  quality: "quality",
  forecast: "forecast",
  sim: "sim",
  incidents: "incidents",
  journal: "journal",
  ai: "ai",
  economics: "roi",
  data: "data",
  builder: "builder",
};
const DOC_TITLE: Record<string, string> = {
  floor: "Сменный отчёт",
  kpi: "Отчёт о показателях",
  quality: "Отчёт по качеству",
  forecast: "Прогноз и риски",
  sim: "Результат симуляции",
  incidents: "Журнал инцидентов",
  journal: "История действий",
  ai: "Аналитическая записка",
  roi: "Экономика производства",
  data: "Паспорт данных",
  builder: "Проект линии",
};
const NO_EXCEL = new Set(["builder", "economics", "staff", "shift"]);

export function ExportButton({ page, title, target }: { page: string; title: string; target: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false);
  const [fmt, setFmt] = useState<Format>("pdf");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const me = useSession();
  const s = useSim();
  const doc = DOC[page];
  const docPage = page === "floor" && s.result ? "sim" : doc;
  const noDoc = !doc || (page === "sim" && !s.result);
  if (page === "staff") return null;

  const formats: { id: Format; label: string; hint: string; icon: typeof FileText; off?: string }[] = [
    {
      id: "pdf",
      label: docPage ? `Документ PDF: ${DOC_TITLE[docPage]}` : "Документ PDF",
      hint: "Фирменный бланк Allur: номер, дата, кто сформировал и должность, показатели, графики, выводы, подписи.",
      icon: FileText,
      off: noDoc ? "Запустите симуляцию — документ опишет её результат" : undefined,
    },
    {
      id: "xlsx",
      label: "Excel — данные страницы",
      hint: "Все цифры и таблицы по листам — для расчётов и сводок.",
      icon: FileSpreadsheet,
      off: NO_EXCEL.has(page) ? "Для этой страницы — PDF-документ или снимок" : undefined,
    },
    { id: "png", label: "Снимок экрана PNG", hint: "Страница одной картинкой — для мессенджера или слайда.", icon: FileImage },
  ];
  const current = formats.find((f) => f.id === fmt && !f.off) ? fmt : (formats.find((f) => !f.off)?.id ?? "png");

  const run = async () => {
    setBusy(true);
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const file = `allur_${page}_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
    const fullNote = [to && `Кому: ${to}`, note].filter(Boolean).join(". ") || undefined;
    try {
      if (current === "pdf") {
        if (docPage === "builder") {
          const body = exportState.builder?.();
          if (!body) throw new Error("Откройте проект в конструкторе");
          await downloadPost("/documents/builder.pdf", body, `${file}.pdf`);
        } else {
          await download(`/documents/${docPage}.pdf`, `${file}.pdf`, { days: exportState.days, note: fullNote, category: page === "journal" ? exportState.category : undefined });
        }
      } else if (current === "xlsx") {
        if (page === "journal") await download("/journal/export.xlsx", `${file}.xlsx`, { category: exportState.category });
        else await download(`/export/${page === "sim" && !sim.sandboxId() ? "floor" : page}.xlsx`, `${file}.xlsx`, { days: exportState.days, note: fullNote });
      } else {
        const node = target.current;
        if (!node) return;
        const meta: [string, string][] = [
          ["Сформирован", stamp.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })],
          ["Подготовил", me ? `${me.name}, ${me.position.toLowerCase()}` : "—"],
        ];
        const mode = s.result ? `Режим симуляции: ${s.result.actions.map((a) => a.title).join("; ")}` : undefined;
        await exportPng(node, { title, meta, to: to || undefined, note: note || undefined, mode }, `${file}.png`);
        request("/export/log", { method: "POST", query: { page: title, fmt: "png", note: fullNote } }).catch(() => undefined);
      }
      toast({ title: "Файл сохранён", body: "Ищите его в папке загрузок браузера.", tone: "run" });
      setOpen(false);
    } catch (e) {
      toast({ title: "Не удалось сформировать файл", body: e instanceof Error ? e.message : "Попробуйте ещё раз", tone: "down" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button data-export-skip variant="secondary" icon={<Download className="size-4" />} onClick={() => setOpen(true)} className="shadow-[var(--shadow-panel)]">
        Скачать
      </Button>
      <Drawer open={open} onClose={() => setOpen(false)} title={`Скачать: ${title}`} width="max-w-[480px]">
        <div className="flex flex-col gap-5 p-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[0.8125rem] font-semibold text-ink-2">Что скачать</legend>
            {formats.map((f) => {
              const Icon = f.icon;
              return (
                <label
                  key={f.id}
                  className={clsx(
                    "flex cursor-pointer items-start gap-3 rounded-[16px] border-2 p-3.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                    current === f.id ? "border-brand bg-brand-soft/50" : "border-transparent bg-sunken hover:border-line-strong",
                    f.off && "pointer-events-none opacity-45",
                  )}
                >
                  <input type="radio" name="fmt" className="sr-only" checked={current === f.id} onChange={() => setFmt(f.id)} disabled={!!f.off} />
                  <span className={clsx("grid size-10 shrink-0 place-items-center rounded-[12px]", current === f.id ? "bg-brand text-white" : "bg-panel text-ink-2")}>
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span>
                    <span className="block text-sm font-bold">{f.label}</span>
                    <span className="mt-0.5 block text-xs text-ink-3">{f.off ?? f.hint}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {me && (
            <p className="rounded-[14px] bg-sunken px-4 py-3 text-xs text-ink-2">
              В документе будет указано: подготовил <b>{me.name}</b>, {me.position.toLowerCase()}.
            </p>
          )}
          <Field label="Кому (необязательно)" hint="Например: мастер сборки, отдел качества">
            <Input value={to} onChange={(e) => setTo(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Комментарий (необязательно)" hint="Напечатается в шапке документа">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={220}
              rows={3}
              className="w-full resize-none rounded-[12px] border border-line-strong bg-sunken px-3.5 py-2.5 text-sm text-ink transition-colors hover:border-ink-3 focus:border-accent focus:bg-panel focus:outline-none"
            />
          </Field>
          {s.result && <p className="rounded-[14px] bg-deep px-4 py-3 text-xs text-white/80">Сейчас открыта симуляция — в файл попадут её данные, и это будет указано в шапке.</p>}
          <Button variant="primary" className="h-12" icon={<Download className="size-4" />} loading={busy} onClick={run}>
            {busy ? "Формирую файл…" : "Скачать"}
          </Button>
        </div>
      </Drawer>
    </>
  );
}

async function downloadPost(path: string, body: unknown, filename: string) {
  const { session } = await import("@/shared/auth/session");
  const token = session.get()?.token;
  const res = await fetch(`/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Ошибка ${res.status}`;
    try {
      msg = (await res.json()).error.message;
    } catch {
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
