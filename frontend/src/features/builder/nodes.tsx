import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  type NodeProps,
  Position,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { clsx } from "clsx";
import {
  Bot,
  Boxes,
  Car,
  CloudRain,
  Combine,
  Droplets,
  Factory,
  Flame,
  Frame,
  Fuel,
  Gauge,
  GitFork,
  Hammer,
  Heater,
  Layers,
  PackageCheck,
  Pipette,
  Plus,
  Route,
  Rows3,
  Ruler,
  ScanSearch,
  Spline,
  SprayCan,
  Trash2,
  Truck,
  Warehouse,
  Wrench,
} from "lucide-react";
import { createContext, memo, type ReactNode, useCallback, useContext } from "react";
import { num } from "@/shared/lib/format";
import type { NodeState } from "./engine";
import { type Kind, KIND_INFO, type PlantNode, SPLIT_MODES } from "./model";
import { PROCS, type ProcKey, procOf, zoneColor } from "./procs";
import { useEdgeFlow, useIsBottleneck, useNodeStats } from "./store";

export const KIND_ICON: Record<Kind, typeof Factory> = {
  source: Warehouse,
  station: Factory,
  assembly: Boxes,
  inspection: ScanSearch,
  buffer: Layers,
  splitter: GitFork,
  transport: Truck,
  sink: PackageCheck,
};

export const PROC_ICON: Record<ProcKey, typeof Factory> = {
  kit_store: Warehouse,
  logistics: Truck,
  press: Hammer,
  jig: Frame,
  robot_cell: Bot,
  weld_line: Flame,
  geometry: Ruler,
  pretreat: Droplets,
  sealer: Pipette,
  paint_booth: SprayCan,
  oven: Heater,
  paint_qc: ScanSearch,
  overhead: Spline,
  floor_conv: Rows3,
  buffer: Layers,
  splitter: GitFork,
  trim: Wrench,
  marriage: Combine,
  final: Car,
  fluids: Fuel,
  alignment: Gauge,
  water_test: CloudRain,
  test_track: Route,
  qc_gate: ScanSearch,
  rework: Hammer,
  fg_store: PackageCheck,
};

export const STATE: Record<NodeState, { label: string; color: string }> = {
  run: { label: "Работает", color: "var(--color-run)" },
  slow: { label: "Замедлен", color: "var(--color-blocked)" },
  starved: { label: "Ждёт изделия", color: "var(--color-wait)" },
  blocked: { label: "Выход занят", color: "var(--color-blocked)" },
  down: { label: "Стоит", color: "var(--color-down)" },
  idle: { label: "Не запущен", color: "var(--color-line-strong)" },
};

const zoomedOut = (s: { transform: [number, number, number] }) => s.transform[2] < 0.42;

const EQ_COLOR = { run: "var(--color-run)", idle: "#c9bdbb", down: "var(--color-down)" };

const IN_HANDLE = "!size-3 !rounded-[3px] !border-2 !border-panel !bg-ink-3";
const OUT_HANDLE = "!size-3 !rounded-[3px] !border-2 !border-panel !bg-ink";

function Shell({ id, data, selected, children, wide }: { id: string; data: PlantNode["data"]; selected?: boolean; children: ReactNode; wide?: boolean }) {
  const st = useNodeStats(id);
  const bottleneck = useIsBottleneck(id);
  const proc = procOf(data);
  const Icon = PROC_ICON[proc] ?? KIND_ICON[data.kind];
  const state = st ? STATE[st.state] : STATE.idle;
  const down = st?.state === "down";
  const far = useStore(zoomedOut);
  const inspection = data.kind === "inspection";
  const zc = zoneColor(data.zone);
  const handles = (
    <>
      {data.kind !== "source" && <Handle type="target" position={Position.Left} className={far ? "!opacity-0" : IN_HANDLE} />}
      {data.kind !== "sink" && !inspection && <Handle type="source" position={Position.Right} className={far ? "!opacity-0" : OUT_HANDLE} />}
      {inspection && (
        <>
          <Handle id="ok" type="source" position={Position.Right} style={{ top: "34%" }} className={far ? "!opacity-0" : OUT_HANDLE} title="Годные" />
          <Handle id="ng" type="source" position={Position.Right} style={{ top: "76%" }} className={far ? "!opacity-0" : "!size-3 !rounded-[3px] !border-2 !border-panel !bg-[#e08a1e]"} title="Брак — на доработку" />
        </>
      )}
    </>
  );
  if (far) {
    const big = data.kind === "buffer" || data.kind === "source" || data.kind === "splitter" ? (st?.stock ?? 0) : data.kind === "transport" ? (st?.transit ?? 0) : st?.produced;
    return (
      <div
        className={clsx("relative overflow-hidden rounded-[10px] border-4 px-5 py-4 text-white shadow-lg", wide ? "w-[250px]" : "w-[200px]", selected && "ring-8 ring-brand/40")}
        style={{ background: st ? state.color : "#5c6268", borderColor: bottleneck ? "var(--color-brand)" : "transparent" }}
      >
        <span className="absolute inset-x-0 top-0 h-3" style={{ background: zc }} aria-hidden />
        {handles}
        <div className="truncate pt-1 text-[1.6rem] leading-tight font-bold">{data.name}</div>
        <div className="display num mt-1 text-[2.6rem] leading-none font-light">
          {st ? num(big ?? 0) : "—"}
          {st && st.downCount > 0 && <span className="ml-2 text-[1.4rem] font-bold">⚠ {st.downCount}</span>}
        </div>
      </div>
    );
  }
  return (
    <div
      className={clsx(
        "relative overflow-visible rounded-[10px] border bg-panel text-ink shadow-[0_1px_0_rgb(0_0_0/0.04),0_8px_20px_-14px_rgb(20_24_28/0.45)] transition-[box-shadow,border-color] duration-200",
        wide ? "w-[250px]" : "w-[200px]",
        selected ? "border-ink ring-2 ring-ink/15" : down ? "border-down ring-2 ring-down/20" : "border-line-strong",
      )}
    >
      {handles}
      <div className="flex h-6 items-center gap-1.5 rounded-t-[9px] border-b border-line px-2.5" style={{ background: `color-mix(in srgb, ${zc} 14%, transparent)` }}>
        <span className="size-2 shrink-0 rounded-[2px]" style={{ background: zc }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[9.5px] font-bold tracking-[0.06em] text-ink-2 uppercase">{PROCS[proc]?.label ?? KIND_INFO[data.kind].label}</span>
        {data.cell_code && <span className="shrink-0 font-mono text-[9.5px] font-semibold text-ink-3">{data.cell_code}</span>}
      </div>
      <span className="absolute top-6 bottom-2 left-0 w-[3px] rounded-r-sm" style={{ background: state.color }} aria-hidden />
      {inspection && (
        <>
          <span className="pointer-events-none absolute top-[34%] -right-1 translate-x-full -translate-y-1/2 pl-1.5 text-[9.5px] font-bold text-ink-3">годные</span>
          <span className="pointer-events-none absolute top-[76%] -right-1 translate-x-full -translate-y-1/2 pl-1.5 text-[9.5px] font-bold text-[#c06a00]">брак</span>
        </>
      )}
      <div className="flex items-center gap-2 px-3 pt-2">
        <span className={clsx("grid size-6 shrink-0 place-items-center rounded-[6px]", down ? "bg-down text-white" : "bg-sunken text-ink-2")}>
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-bold" title={data.name}>
          {data.name}
        </span>
        {bottleneck && <span className="rounded-[4px] bg-brand px-1.5 text-[10px] leading-4 font-bold text-white">узкое</span>}
        {data.rework && <span className="rounded-[4px] bg-[#fde9cf] px-1.5 text-[10px] leading-4 font-bold text-[#a35a00]">доработка</span>}
      </div>
      <div className="mt-1 flex items-center gap-1.5 px-3 text-[11px] font-semibold" style={{ color: down ? "var(--color-down)" : "var(--color-ink-3)" }}>
        <span className={clsx("size-1.5 rounded-full", down && "animate-[blink_1s_ease-in-out_infinite]")} style={{ background: state.color }} />
        {st ? state.label : "Не запущен"}
        {!!data.workers && <span className="ml-auto font-medium text-ink-3">{data.workers} чел.</span>}
      </div>
      <div className="px-3 pt-2 pb-2.5">{children}</div>
    </div>
  );
}

function Metric({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <div className={clsx("display num text-[1.35rem] leading-none font-light", accent && "text-brand")}>{value}</div>
      <div className="mt-0.5 truncate text-[10.5px] text-ink-3">{label}</div>
    </div>
  );
}

function Bar({ value, max, color = "var(--color-ink)" }: { value: number; max: number; color?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, (value / Math.max(max, 1)) * 100)}%`, background: color }} />
    </div>
  );
}

export const StationNode = memo(function StationNode({ id, data, selected }: NodeProps<PlantNode>) {
  const st = useNodeStats(id);
  const eq = st?.eq ?? (data.equipment ?? []).map((e) => ({ code: e.code, state: "idle" as const, alarm: false, critical: e.critical }));
  const shown = eq.slice(0, 36);
  return (
    <Shell id={id} data={data} selected={selected} wide>
      <div className="grid grid-cols-3 gap-2">
        <Metric value={st ? num(st.produced) : "—"} label={data.kind === "inspection" ? "годных" : "выпуск"} />
        <Metric value={st ? num(st.perHour) : "—"} label="в час" />
        <Metric value={st ? `${Math.round(st.utilization)}%` : "—"} label="загрузка" accent={!!st && st.utilization > 92} />
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2 text-[10.5px] text-ink-3">
        <span className="inline-flex min-w-0 items-center gap-1 truncate">
          <Wrench className="size-3 shrink-0" aria-hidden /> {eq.length}
          {st && st.downCount > 0 && <b className="text-down">· стоит {st.downCount}</b>}
          {st && st.alarmCount > 0 && <b className="text-[#c26a00]">· тревога {st.alarmCount}</b>}
          {st && data.kind === "inspection" && (st.rejected || st.scrapped) > 0 && <b className="text-[#c26a00]">· брак {st.rejected || st.scrapped}</b>}
          {st && data.rework && st.reworked > 0 && <b className="text-run">· исправлено {st.reworked}</b>}
        </span>
        <span className="shrink-0">
          {data.parallel && data.parallel > 1 ? `${data.parallel} места · ` : ""}цикл {num(data.cycle_s)} с
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-[3px]" aria-hidden>
        {shown.map((e) => (
          <span
            key={e.code}
            title={e.code}
            className={clsx("h-2.5 w-3.5 rounded-[2px]", e.alarm && "ring-2 ring-[#ff9a3d]", e.state === "down" && "animate-[blink_1s_ease-in-out_infinite]")}
            style={{ background: EQ_COLOR[e.state], opacity: e.critical ? 1 : 0.65 }}
          />
        ))}
        {eq.length > shown.length && <span className="text-[10px] text-ink-3">+{eq.length - shown.length}</span>}
      </div>
    </Shell>
  );
});

export const SourceNode = memo(function SourceNode({ id, data, selected }: NodeProps<PlantNode>) {
  const st = useNodeStats(id);
  const stock = st?.stock ?? data.stock_init ?? 0;
  return (
    <Shell id={id} data={data} selected={selected}>
      <div className="grid grid-cols-2 gap-2">
        <Metric value={num(stock)} label={`на складе из ${num(data.stock_cap)}`} accent={stock < 4} />
        <Metric value={num(data.rate_per_hour)} label="поставка в час" />
      </div>
      <div className="mt-2">
        <Bar value={stock} max={data.stock_cap ?? 60} color={stock < 4 ? "var(--color-down)" : "var(--color-ink)"} />
      </div>
      {st?.supplyPaused && <p className="mt-1.5 text-[10.5px] font-bold text-[#a26b00]">поставка остановлена</p>}
    </Shell>
  );
});

export const BufferNode = memo(function BufferNode({ id, data, selected }: NodeProps<PlantNode>) {
  const st = useNodeStats(id);
  const n = st?.stock ?? 0;
  const cap = data.capacity ?? 6;
  const full = n >= cap;
  return (
    <Shell id={id} data={data} selected={selected}>
      <div className="flex items-end justify-between">
        <Metric value={`${n}/${cap}`} label={full ? "буфер полон" : n === 0 ? "пуст" : "изделий в буфере"} accent={full} />
      </div>
      <div className="mt-2 flex gap-[3px]" aria-hidden>
        {Array.from({ length: Math.min(cap, 24) }, (_, i) => (
          <span key={i} className="h-2.5 flex-1 rounded-[3px]" style={{ background: i < n ? (full ? "var(--color-blocked)" : "var(--color-ink-2)") : "var(--color-sunken)" }} />
        ))}
      </div>
    </Shell>
  );
});

export const SplitterNode = memo(function SplitterNode({ id, data, selected }: NodeProps<PlantNode>) {
  const st = useNodeStats(id);
  const flow = useReactFlow<PlantNode>();
  const targets = useStore(useCallback((s) => s.edges.filter((e) => e.source === id).map((e) => e.target).join("|"), [id]));
  const outs = targets ? targets.split("|") : [];
  const mode = data.split_mode ?? "free";
  const total = outs.reduce((s, t) => s + (st?.lanes?.[t] ?? 0), 0);
  const sharesTotal = outs.reduce((s, t) => s + Math.max(0, data.shares?.[t] ?? 1), 0) || 1;
  return (
    <Shell id={id} data={data} selected={selected}>
      <p className="text-[10.5px] font-semibold text-ink-3">{SPLIT_MODES[mode]}</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {outs.length === 0 && <li className="text-[11px] text-ink-3">Подключите выходы справа</li>}
        {outs.slice(0, 6).map((t) => {
          const share = mode === "share" ? Math.round((Math.max(0, data.shares?.[t] ?? 1) / sharesTotal) * 100) : null;
          const got = st?.lanes?.[t] ?? 0;
          return (
            <li key={t} className="text-[10.5px]">
              <div className="flex justify-between gap-2">
                <span className="truncate text-ink-2">{flow.getNode(t)?.data.name ?? t}</span>
                <span className="num shrink-0 font-semibold">{share != null ? `${share}%` : ""}{st ? ` · ${got}` : ""}</span>
              </div>
              <Bar value={st ? got : (share ?? 50)} max={st ? Math.max(total, 1) : 100} color="var(--color-ink-2)" />
            </li>
          );
        })}
      </ul>
    </Shell>
  );
});

export const TransportNode = memo(function TransportNode({ id, data, selected }: NodeProps<PlantNode>) {
  const st = useNodeStats(id);
  const cap = data.capacity ?? 8;
  const n = st?.transit ?? 0;
  return (
    <Shell id={id} data={data} selected={selected}>
      <div className="grid grid-cols-2 gap-2">
        <Metric value={`${n}/${cap}`} label="в пути" />
        <Metric value={`${num(Math.round((data.travel_s ?? 60) / 60))} мин`} label="время в пути" />
      </div>
      <div className="relative mt-2 h-2.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
        {Array.from({ length: Math.min(n, 12) }, (_, i) => (
          <span key={i} className="absolute top-0.5 h-1.5 w-2.5 rounded-[2px] bg-ink-2" style={{ left: `${((i + 0.5) / Math.max(cap, 1)) * 100}%` }} />
        ))}
      </div>
    </Shell>
  );
});

export const SinkNode = memo(function SinkNode({ id, data, selected }: NodeProps<PlantNode>) {
  const st = useNodeStats(id);
  return (
    <Shell id={id} data={data} selected={selected}>
      <div className="grid grid-cols-2 gap-2">
        <Metric value={st ? num(st.produced) : "—"} label="готово" />
        <Metric value={st ? num(st.perHour) : "—"} label="в час" />
      </div>
    </Shell>
  );
});

export const NODE_TYPES = {
  source: SourceNode,
  station: StationNode,
  assembly: StationNode,
  inspection: StationNode,
  buffer: BufferNode,
  splitter: SplitterNode,
  transport: TransportNode,
  sink: SinkNode,
};

export interface EdgeActions {
  insert(edgeId: string, kind: Kind): void;
  remove(edgeId: string): void;
}
export const EdgeActionsContext = createContext<EdgeActions | null>(null);

const INSERTABLE: Kind[] = ["buffer", "transport", "station", "inspection", "splitter"];

export const FlowEdge = memo(function FlowEdge(p: EdgeProps) {
  const { on, rate } = useEdgeFlow(`${p.source}>${p.target}`);
  const actions = useContext(EdgeActionsContext);
  const ng = p.sourceHandleId === "ng";
  const [path, lx, ly] = getSmoothStepPath({
    sourceX: p.sourceX,
    sourceY: p.sourceY,
    targetX: p.targetX,
    targetY: p.targetY,
    sourcePosition: p.sourcePosition,
    targetPosition: p.targetPosition,
    borderRadius: 14,
  });
  const color = p.selected ? "#1d1313" : on ? (ng ? "#e08a1e" : "#e3241b") : ng ? "#e5b37a" : "#b8aaa8";
  return (
    <>
      <BaseEdge
        id={p.id}
        path={path}
        markerEnd={p.markerEnd}
        interactionWidth={22}
        style={{ stroke: color, strokeWidth: p.selected ? 2.6 : on ? 2.2 : 1.6, strokeDasharray: ng && !on ? "6 5" : undefined }}
      />
      {on && <path d={path} fill="none" stroke="#fff" strokeOpacity={0.75} strokeWidth={1.4} strokeDasharray="4 12" className="animate-[flow_0.9s_linear_infinite]" pointerEvents="none" />}
      <EdgeLabelRenderer>
        {(on && rate > 0) || (actions && p.selected) || ng ? (
          <div className="nodrag nopan absolute flex flex-col items-center gap-1" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, pointerEvents: "all" }}>
            {(ng || (on && rate > 0)) && (
              <span className={clsx("num rounded-full px-1.5 text-[10px] leading-4 font-bold", ng ? "bg-[#fde9cf] text-[#a35a00]" : "bg-panel text-ink-2 shadow-sm")}>
                {ng ? "брак" : ""}
                {ng && on && rate > 0 ? " · " : ""}
                {on && rate > 0 ? `${rate}/ч` : ""}
              </span>
            )}
            {actions && p.selected && (
              <div className="flex items-center gap-0.5 rounded-full border border-line bg-panel p-0.5 shadow-[var(--shadow-float)]" role="toolbar" aria-label="Связь">
                <span className="px-1.5 text-[10px] font-semibold text-ink-3">
                  <Plus className="inline size-3" aria-hidden /> вставить
                </span>
                {INSERTABLE.map((k) => {
                  const Icon = KIND_ICON[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      title={`Вставить: ${KIND_INFO[k].label}`}
                      aria-label={`Вставить ${KIND_INFO[k].label}`}
                      onClick={() => actions.insert(p.id, k)}
                      className="grid size-7 place-items-center rounded-full text-ink-2 hover:bg-sunken hover:text-ink"
                    >
                      <Icon className="size-3.5" />
                    </button>
                  );
                })}
                <button type="button" title="Удалить связь" aria-label="Удалить связь" onClick={() => actions.remove(p.id)} className="grid size-7 place-items-center rounded-full text-ink-2 hover:bg-down-soft hover:text-down">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
});

export const EDGE_TYPES = { flow: FlowEdge };
