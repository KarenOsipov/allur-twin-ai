import { clsx } from "clsx";
import { Cloud, CloudOff, HardDrive, RefreshCw } from "lucide-react";
import { useDbActions, useDbStatus } from "@/shared/api/queries";
import { dateTime, num } from "@/shared/lib/format";
import { Button } from "@/shared/ui/Button";
import { ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { toast } from "@/shared/ui/Toaster";

const LABELS: Record<string, string> = { users: "Сотрудников", incidents: "Инцидентов", journal: "Записей журнала", chat: "Сообщений в чате" };

export function DbPanel() {
  const q = useDbStatus();
  const act = useDbActions();
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Skeleton className="h-64" />;
  const s = q.data;
  const primary = s.mode === "primary";
  const fail = (e: Error) => toast({ title: "Не получилось", body: e.message, tone: "down" });
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <Panel title="Где сейчас хранятся данные">
        <div className={clsx("flex items-start gap-4 rounded-[18px] p-4", primary ? "bg-run-soft" : s.configured ? "bg-blocked-soft" : "bg-sunken")}>
          <span className={clsx("grid size-12 shrink-0 place-items-center rounded-full text-white", primary ? "bg-run" : s.configured ? "bg-blocked" : "bg-deep")}>
            {primary ? <Cloud className="size-6" /> : s.configured ? <CloudOff className="size-6" /> : <HardDrive className="size-6" />}
          </span>
          <div className="min-w-0">
            <div className="text-lg font-semibold">{primary ? `${s.label} — основная база` : "Локальная база"}</div>
            <p className="mt-0.5 text-sm text-ink-2">
              {primary
                ? `Всё сохраняется в ${s.label}. Локальная база — зеркало на случай отключения.`
                : !s.configured
                  ? `${s.label} не подключён: данные хранятся в базе на этом сервере (${s.local_kind === "postgresql" ? "PostgreSQL" : "SQLite"}).`
                  : s.outage
                    ? `${s.label} недоступен (${s.last_error ?? "нет связи"}). Работаем на зеркале — когда связь вернётся, внесённое перенесётся в ${s.label} автоматически.`
                    : `Сервер запустился без связи с ${s.label}. Работаем на локальной базе.`}
            </p>
            <p className="mt-2 text-xs text-ink-3">
              С {dateTime(s.since)}
              {s.configured && ` · связь с ${s.label}: ${s.primary_ok ? "есть" : s.primary_ok === false ? "нет" : "проверяется"}`}
              {s.last_mirror && ` · зеркало обновлено ${dateTime(s.last_mirror)}`}
            </p>
          </div>
        </div>
        {s.counts && (
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries(s.counts).map(([k, v]) => (
              <div key={k} className="rounded-[14px] bg-sunken px-3.5 py-2.5">
                <dt className="text-xs text-ink-3">{LABELS[k] ?? k}</dt>
                <dd className="display num mt-0.5 text-xl font-light">{num(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {primary && (
            <Button variant="secondary" size="sm" icon={<RefreshCw className="size-4" />} loading={act.mirror.isPending} onClick={() => act.mirror.mutate(undefined, { onSuccess: () => toast({ title: "Зеркало обновлено", tone: "run" }), onError: fail })}>
              Обновить зеркало сейчас
            </Button>
          )}
          {!primary && s.configured && s.needs_decision && (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={!s.primary_ok}
                loading={act.usePrimary.isPending}
                onClick={() => act.usePrimary.mutate(true, { onSuccess: () => toast({ title: `Снова на ${s.label}`, body: "Локальные данные перенесены.", tone: "run" }), onError: fail })}
              >
                Вернуться на {s.label} и перенести данные
              </Button>
              <Button variant="ghost" size="sm" disabled={!s.primary_ok} loading={act.usePrimary.isPending} onClick={() => act.usePrimary.mutate(false, { onSuccess: () => toast({ title: `Снова на ${s.label}`, tone: "run" }), onError: fail })}>
                Вернуться без переноса
              </Button>
            </>
          )}
        </div>
        {!primary && s.configured && s.needs_decision && !s.primary_ok && <p className="mt-2 text-xs text-ink-3">Кнопки станут доступны, когда {s.label} снова ответит.</p>}
      </Panel>
      <Panel title="Как это устроено">
        <ul className="flex flex-col gap-2.5 text-sm text-ink-2">
          <li>
            <b className="text-ink">Supabase</b> подключается строкой <code className="rounded bg-sunken px-1">SUPABASE_DB_URL</code> в файле <code className="rounded bg-sunken px-1">.env</code>. Без неё всё работает на локальной базе.
          </li>
          <li>
            Пока Supabase доступен, каждые несколько минут его данные копируются в <b className="text-ink">локальное зеркало</b>.
          </li>
          <li>Связь пропала — система за секунды переходит на зеркало, работа не останавливается.</li>
          <li>Связь вернулась — всё, что внесли за это время, переносится обратно в Supabase.</li>
          <li>Таблицы в Supabase закрыты от его публичного API: данные читает только сервер системы.</li>
        </ul>
      </Panel>
    </div>
  );
}

export function DbBanner() {
  const q = useDbStatus();
  const s = q.data;
  if (!s || !s.configured || s.mode === "primary") return null;
  return (
    <div className="mx-auto mt-3 max-w-[1600px] px-3 sm:px-5" role="status">
      <div className="flex items-center gap-3 rounded-[16px] bg-blocked-soft px-4 py-2.5 text-sm text-ink ring-1 ring-blocked/30">
        <CloudOff className="size-4 shrink-0 text-blocked" aria-hidden />
        <span className="min-w-0 flex-1">
          <b>{s.label} недоступен</b> — работаем на локальной базе, данные не теряются.
          {s.outage ? " Когда связь вернётся, всё перенесётся автоматически." : " Вернуться можно в «Данные → База данных»."}
        </span>
      </div>
    </div>
  );
}
