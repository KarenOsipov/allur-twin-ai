import { clsx } from "clsx";
import { FileDown, FileText } from "lucide-react";
import { useState } from "react";
import { download } from "@/shared/api/client";
import { useSession } from "@/shared/auth/session";
import { Button } from "@/shared/ui/Button";
import { Field } from "@/shared/ui/Field";
import { Sheet } from "@/shared/ui/Sheet";
import { toast } from "@/shared/ui/Toaster";

const PERIODS = [
  { days: 7, label: "7 дней" },
  { days: 30, label: "30 дней" },
  { days: 60, label: "60 дней" },
  { days: 90, label: "90 дней" },
];

const SECTIONS = ["Цех и смена", "Показатели", "Качество", "Прогноз и риски", "Инциденты", "Экономика", "Данные", "История действий"];

export function FullReportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useSession();
  const [days, setDays] = useState(30);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    try {
      await download("/documents/full.pdf", `obshchii_analiz_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.pdf`, { days, note: note.trim() || undefined });
      toast({ title: "Общий анализ готов", body: "Документ сохранён в папку загрузок.", tone: "run" });
      onClose();
    } catch (e) {
      toast({ title: "Не удалось сформировать документ", body: (e as Error).message, tone: "down" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Общий анализ производства">
      <div className="flex flex-col gap-5">
        <p className="text-sm text-ink-2">Один PDF-документ на бланке завода со всеми разделами — для планёрки, руководства или отчёта.</p>
        <ol className="grid grid-cols-2 gap-1.5 text-sm">
          {SECTIONS.map((s, i) => (
            <li key={s} className="flex items-center gap-2 rounded-[12px] bg-sunken px-3 py-2">
              <span className="num text-xs font-bold text-brand">{String(i + 1).padStart(2, "0")}</span>
              {s}
            </li>
          ))}
        </ol>
        <fieldset>
          <legend className="mb-2 text-[0.8125rem] font-semibold text-ink-2">Период показателей</legend>
          <div role="radiogroup" className="grid grid-cols-4 gap-1 rounded-full bg-sunken p-1">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                type="button"
                role="radio"
                aria-checked={days === p.days}
                onClick={() => setDays(p.days)}
                className={clsx("h-9 rounded-full text-sm font-semibold transition-colors", days === p.days ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink")}
              >
                {p.label}
              </button>
            ))}
          </div>
        </fieldset>
        <Field label="Комментарий (необязательно)" hint="Напечатается в шапке документа">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={220}
            rows={2}
            className="w-full resize-none rounded-[12px] border border-line-strong bg-sunken px-3.5 py-2.5 text-sm focus:border-accent focus:bg-panel focus:outline-none"
          />
        </Field>
        {me && (
          <p className="rounded-[14px] bg-sunken px-4 py-3 text-xs text-ink-2">
            Подготовил: <b>{me.name}</b>, {me.position.toLowerCase()}. Формируется 5–15 секунд.
          </p>
        )}
        <Button variant="primary" className="h-12" icon={<FileDown className="size-5" />} loading={busy} onClick={run}>
          {busy ? "Собираю документ…" : "Скачать общий анализ"}
        </Button>
      </div>
    </Sheet>
  );
}

export function FullReportButton({ className = "inline-flex" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={clsx(
          "h-10 items-center gap-2 rounded-full bg-white/85 px-4 text-sm font-semibold whitespace-nowrap text-ink ring-1 ring-line-strong transition-colors hover:bg-white",
          className,
        )}
      >
        <FileText className="size-4 text-brand" aria-hidden />
        Общий анализ
      </button>
      <FullReportSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
