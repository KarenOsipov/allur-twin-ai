import { clsx } from "clsx";
import { Activity, Cpu, Sparkles, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useIncidentActions, useIncidents } from "@/shared/api/queries";
import type { Incident } from "@/shared/api/types";
import { alerts } from "@/shared/alerts/store";
import { can, useSession } from "@/shared/auth/session";
import { SEVERITY_LABEL, dateTime, kzt, num } from "@/shared/lib/format";
import { Button } from "@/shared/ui/Button";
import { Empty, ErrorNote, Panel, Skeleton } from "@/shared/ui/Panel";
import { Segmented } from "@/shared/ui/Segmented";
import { Dot } from "@/shared/ui/Status";
import { useSim } from "@/shared/sim/store";

const SEV_COLOR = { critical: "var(--color-down)", warning: "var(--color-blocked)", info: "var(--color-maint)" };
const STATUS = { open: "Ждёт реакции", ack: "В работе", resolved: "Решено" };
const KIND: Record<Incident["kind"], string> = {
  equipment: "Оборудование",
  quality: "Качество",
  supply: "Поставки",
  kpi: "План",
  safety: "Безопасность",
  other: "Другое",
};
const AREA: Record<string, string> = { WH_IN: "Склад комплектующих", WELD: "Сварка", PAINT: "Окраска", ASSY: "Сборка", QC: "Контроль качества", WH_OUT: "Склад ГП" };

type View = "active" | "worker" | "resolved" | "all";

export function IncidentsPage() {
  const simState = useSim();
  const inSim = !!simState.result;
  const [view, setView] = useState<View>(inSim ? "all" : "active");
  const [severity, setSeverity] = useState("");
  const status = view === "active" ? "active" : view === "resolved" ? "resolved" : "";
  const q = useIncidents(status, severity, view === "worker" ? "worker" : "");
  const s = useSession();
  const canOperate = can(s, "operate") && !inSim;

  useEffect(() => {
    setView(inSim ? "all" : "active");
  }, [inSim]);

  return (
    <div className="flex flex-col gap-4">
      {inSim && (
        <div className="flex items-start gap-3 rounded-[18px] border border-brand/30 bg-brand-soft px-4 py-3 text-sm">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
          <p>
            <span className="font-semibold">Журнал симуляции.</span> Отказы, которые случатся при введённых событиях. Принять или закрыть их нельзя — это прогноз, а не живой цех.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Какие"
          value={view}
          onChange={setView}
          options={[
            { value: "active", label: "Активные" },
            { value: "worker", label: "С участков" },
            { value: "resolved", label: "Решённые" },
            { value: "all", label: "Все" },
          ]}
        />
        <Segmented
          label="Важность"
          value={severity}
          onChange={setSeverity}
          options={[
            { value: "", label: "Любая" },
            { value: "critical", label: "Аварии" },
            { value: "warning", label: "Отклонения" },
          ]}
        />
        {q.data && (
          <p className="ml-auto text-sm text-ink-2">
            Активных: <span className="font-medium text-ink">{q.data.active}</span> · потери по оценке: <span className="num font-medium text-ink">{kzt(q.data.cost_kzt)}</span>
          </p>
        )}
      </div>
      <Panel bodyClass="p-0">
        {q.error ? (
          <div className="p-5">
            <ErrorNote error={q.error} />
          </div>
        ) : !q.data ? (
          <div className="p-5">
            <Skeleton className="h-64" />
          </div>
        ) : q.data.items.length === 0 ? (
          <div className="p-5">
            <Empty
              title={view === "active" ? "Активных проблем нет" : "Ничего не найдено"}
              text="Сюда попадают сообщения рабочих с участков, отказы оборудования, отклонения брака и задержки поставок."
            />
          </div>
        ) : (
          <ul>
            {q.data.items.map((i) => (
              <Row key={i.id} i={i} canOperate={canOperate} inSim={inSim} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Row({ i, canOperate, inSim }: { i: Incident; canOperate: boolean; inSim: boolean }) {
  const act = useIncidentActions();
  const fromWorker = i.source === "worker";
  return (
    <li className={clsx("grid gap-x-5 gap-y-3 border-b border-line px-5 py-4 last:border-b-0 md:grid-cols-[2.5rem_minmax(0,1fr)_auto]", i.status === "open" && i.severity === "critical" && "bg-down-soft/40")}>
      <span
        className={clsx("hidden size-10 place-items-center rounded-full md:grid", fromWorker ? "bg-brand text-white" : "bg-sunken text-ink-3")}
        title={fromWorker ? "Сообщение с участка" : "Зафиксировано системой"}
        aria-hidden
      >
        {fromWorker ? <UserRound className="size-5" /> : i.kind === "kpi" ? <Activity className="size-5" /> : <Cpu className="size-5" />}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          <span className="num font-medium text-ink-2">{dateTime(i.created_at)}</span>
          <span className="inline-flex items-center gap-1">
            <Dot color={SEV_COLOR[i.severity]} />
            {SEVERITY_LABEL[i.severity]}
          </span>
          <span>· {KIND[i.kind] ?? i.kind}</span>
          {i.area && <span>· {AREA[i.area] ?? i.area}</span>}
        </div>
        <p className="mt-1 font-semibold">{i.title}</p>
        <p className="mt-0.5 text-sm text-ink-2">
          {fromWorker ? (
            <>
              «{i.details}» — <span className="font-medium">{i.reported_by}</span>
            </>
          ) : (
            i.details
          )}
        </p>
        {i.resolution && <p className="mt-1 text-sm text-run">Сделано: {i.resolution}</p>}
        {(i.downtime_min != null || (i.cost_kzt ?? 0) > 0) && (
          <p className="num mt-1 text-xs text-ink-3">
            {i.downtime_min != null && `простой ${num(i.downtime_min)} мин`}
            {(i.cost_kzt ?? 0) > 0 && ` · потери ≈ ${kzt(i.cost_kzt)}`}
            {i.resolved_by && ` · закрыл ${i.resolved_by}`}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <span
          className={clsx(
            "rounded-full px-2.5 py-0.5 text-xs font-semibold",
            i.status === "resolved" ? "bg-run-soft text-run" : i.status === "ack" ? "bg-blocked-soft text-blocked" : "bg-down-soft text-down",
          )}
        >
          {STATUS[i.status]}
          {i.acked_by && i.status === "ack" ? ` · ${i.acked_by}` : ""}
        </span>
        {!inSim && (
          <Button size="sm" variant={i.status === "resolved" ? "ghost" : "primary"} onClick={() => alerts.open(i.id)}>
            {i.status === "resolved" ? "Подробнее" : "Анализ"}
          </Button>
        )}
        {canOperate && i.status === "open" && (
          <Button size="sm" loading={act.ack.isPending} onClick={() => act.ack.mutate(i.id)}>
            Принять
          </Button>
        )}
      </div>
    </li>
  );
}
