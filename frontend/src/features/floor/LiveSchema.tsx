import "@xyflow/react/dist/style.css";
import { Background, BackgroundVariant, Controls, type Edge, MarkerType, type NodeMouseHandler, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Floor, FloorLayout, FloorNodeMap, Plant } from "@/shared/api/types";
import { minutesBetween } from "@/shared/lib/format";
import { type NodeState, type NodeStats, PlantSim, type SimStats } from "@/features/builder/engine";
import { allurTemplate, type PlantEdge, type PlantNode, type Project } from "@/features/builder/model";
import { EDGE_TYPES, NODE_TYPES } from "@/features/builder/nodes";
import { Plant3D } from "@/features/builder/Plant3D";
import { createStatsStore, StatsProvider } from "@/features/builder/store";

const TEMPLATE_MAP: Record<string, FloorNodeMap> = {
  wh_in: { area: "WH_IN", role: "area" },
  weld: { area: "WELD", role: "area" },
  buf1: { area: "WELD", role: "buffer" },
  paint: { area: "PAINT", role: "area" },
  buf2: { area: "PAINT", role: "buffer" },
  assy: { area: "ASSY", role: "area" },
  buf3: { area: "ASSY", role: "buffer" },
  qc: { area: "QC", role: "area" },
  wh_out: { area: "WH_OUT", role: "area" },
};

const AREA_TO_NODE: Record<string, NodeState> = { run: "run", starved: "starved", blocked: "blocked", down: "down", off: "idle" };

export interface FloorProject {
  project: Project;
  map: Record<string, FloorNodeMap>;
  extra: string[];
  standard: boolean;
  name: string;
  custom: boolean;
}

export function useFloorProject(plant: Plant | undefined, layout: FloorLayout | undefined): FloorProject | null {
  return useMemo(() => {
    if (!plant) return null;
    if (layout?.id && layout.data) {
      const nodes = (layout.data.nodes as PlantNode[]).map((n) => ({ ...n, type: n.type ?? n.data.kind, selected: false }));
      const edges = layout.data.edges as PlantEdge[];
      const map = layout.map ?? {};
      return { project: { name: layout.name ?? "Схема цеха", nodes, edges }, map, extra: nodes.filter((n) => !map[n.id]).map((n) => n.id), standard: Boolean(layout.standard), name: layout.name ?? "", custom: true };
    }
    const project = allurTemplate(plant.equipment);
    return { project, map: TEMPLATE_MAP, extra: [], standard: true, name: project.name, custom: false };
  }, [plant, layout]);
}

function liveStats(floor: Floor, fp: FloorProject, model: SimStats | null): SimStats {
  const { project, map } = fp;
  const areas = new Map(floor.areas.map((a) => [a.code, a]));
  const eqLive = new Map(floor.equipment.map((e) => [e.code, e]));
  const hours = floor.shift.start ? Math.max(minutesBetween(floor.shift.start, floor.clock) / 60, 0.25) : 1;
  const out: SimStats["nodes"] = {};
  let eqTotal = 0;
  let down = 0;
  for (const n of project.nodes) {
    const m = map[n.id];
    const a = m ? areas.get(m.area) : undefined;
    if (!m || !a) {
      const st = model?.nodes[n.id];
      if (st) {
        out[n.id] = st;
        eqTotal += st.eq.length;
        down += st.downCount;
      }
      continue;
    }
    if (m.role === "buffer") {
      const k = a.buffer?.length ?? 0;
      const cap = a.buffer_cap ?? 1;
      out[n.id] = { state: k >= cap ? "blocked" : k === 0 ? "starved" : "run", produced: 0, scrapped: 0, rejected: 0, reworked: 0, wip: k, queue: k, utilization: 0, perHour: 0, stock: k, eq: [], downCount: 0, alarmCount: 0 };
      continue;
    }
    const areaState: NodeStats["eq"][number]["state"] = a.state === "run" ? "run" : "idle";
    const specs = n.data.equipment ?? [];
    const eq = (specs.length ? specs.map((sp) => ({ code: sp.code, critical: sp.critical })) : floor.equipment.filter((e) => e.area === a.code)).map((x) => {
      const e = eqLive.get(x.code);
      const state = e ? (e.status === "run" ? "run" : e.status === "down" || e.status === "maint" ? "down" : "idle") : areaState;
      return { code: x.code, critical: x.critical, state: state as "run" | "idle" | "down", temp: 0, vib: 0, wear: 0, alarm: false, until: null, failures: 0 };
    });
    const t = a.time;
    const total = t ? t.run + t.down + t.starved + t.blocked : 0;
    const produced = a.code === "WH_OUT" ? (a.stock ?? 0) : (a.output ?? 0);
    const downCount = eq.filter((e) => e.state === "down").length;
    eqTotal += eq.length;
    down += downCount;
    out[n.id] = {
      state: a.kind === "store" ? (a.delayed ? "starved" : "run") : AREA_TO_NODE[a.state ?? "off"],
      produced,
      scrapped: a.kind === "inspection" ? (a.defects ?? 0) : 0,
      rejected: 0,
      reworked: 0,
      wip: a.current ? 1 : 0,
      queue: 0,
      utilization: total ? (t!.run / total) * 100 : (a.oee ?? 0),
      perHour: produced / hours,
      stock: a.code === "WH_IN" ? (a.stock ?? 0) : undefined,
      supplyPaused: a.code === "WH_IN" ? Boolean(a.delayed) : undefined,
      eq,
      downCount,
      alarmCount: 0,
    };
  }
  const flowing = new Set<string>();
  for (const e of project.edges) {
    const s = out[e.source];
    if (s && (s.state === "run" || (s.stock ?? 0) > 0 || (s.wip ?? 0) > 0)) flowing.add(`${e.source}>${e.target}`);
  }
  const bottleneck = Object.entries(map).find(([, m]) => m.area === floor.kpi.bottleneck && m.role === "area")?.[0] ?? null;
  const sinkId = Object.entries(map).find(([, m]) => m.area === "WH_OUT")?.[0];
  const output = sinkId ? floor.kpi.finished : (model?.output ?? floor.kpi.finished);
  return { t: model?.t ?? 0, nodes: out, output, perHour: output / hours, wip: 0, equipment: eqTotal, down, alarms: 0, bottleneck, scrapped: 0, problems: model?.problems.filter((p) => !map[p.node]) ?? [], flowing, edgeRate: {} };
}

function useExtraModel(fp: FloorProject, floor: Floor, enabled: boolean) {
  const simRef = useRef<PlantSim | null>(null);
  const floorRef = useRef(floor);
  floorRef.current = floor;
  const [stats, setStats] = useState<SimStats | null>(null);
  const structKey = useMemo(() => JSON.stringify([fp.project.nodes.map((n) => [n.id, n.data]), fp.project.edges.map((e) => [e.source, e.target, e.sourceHandle])]), [fp.project]);

  useEffect(() => {
    if (!enabled) {
      simRef.current = null;
      setStats(null);
      return;
    }
    const { nodes, edges } = fp.project;
    if (simRef.current) simRef.current.reconfigure(nodes, edges);
    else {
      const s = new PlantSim(nodes, edges, 11);
      const f = floorRef.current;
      const warm = f.shift.start ? Math.min(Math.max(minutesBetween(f.shift.start, f.clock), 0), 240) * 60 : 1800;
      for (let t = 0; t < warm; t += 5) s.step(5);
      simRef.current = s;
    }
    setStats(simRef.current.stats());
  }, [structKey, enabled]);

  useEffect(() => {
    if (!enabled) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const s = simRef.current;
      const f = floorRef.current;
      if (!s) return;
      const now = performance.now();
      const real = Math.min((now - last) / 1000, 1);
      last = now;
      if (f.paused || !f.working) return;
      const live = new Map(f.equipment.map((e) => [e.code, e.status]));
      for (const n of fp.project.nodes) {
        if (!fp.map[n.id] || fp.map[n.id].role !== "area") continue;
        for (const sp of n.data.equipment ?? []) {
          const st = live.get(sp.code);
          if (st === "down" || st === "maint") s.fail(n.id, sp.code, 600);
          else if (st === "run") {
            const cur = s.stats().nodes[n.id]?.eq.find((e) => e.code === sp.code);
            if (cur?.state === "down") s.repair(n.id, sp.code);
          }
        }
      }
      let left = real * Math.max(f.speed, 1);
      while (left > 0) {
        const dt = Math.min(5, left);
        s.step(dt);
        left -= dt;
      }
      setStats(s.stats());
    }, 1000);
    return () => window.clearInterval(id);
  }, [enabled, fp]);

  return stats;
}

export function LiveSchema({ floor, fp, onArea, view = "schema", height = 460 }: { floor: Floor; fp: FloorProject; onArea: (code: string) => void; view?: "schema" | "3d"; height?: number }) {
  return (
    <ReactFlowProvider>
      <Schema floor={floor} fp={fp} onArea={onArea} height={height} view={view} />
    </ReactFlowProvider>
  );
}

function Schema({ floor, fp, onArea, height, view }: { floor: Floor; fp: FloorProject; onArea: (code: string) => void; height: number; view: "schema" | "3d" }) {
  const [store] = useState(createStatsStore);
  const model = useExtraModel(fp, floor, fp.extra.length > 0);
  useEffect(() => {
    store.set(liveStats(floor, fp, model));
  }, [floor, fp, model, store]);
  const edges = useMemo<Edge[]>(() => fp.project.edges.map((e) => ({ ...e, type: "flow", markerEnd: { type: MarkerType.ArrowClosed, color: "#8f8382", width: 16, height: 16 } })), [fp.project.edges]);
  const open = (id: string) => {
    const m = fp.map[id];
    if (m) onArea(m.area);
  };
  const onNodeClick: NodeMouseHandler<PlantNode> = (_, n) => open(n.id);
  return (
    <StatsProvider value={store}>
      {view === "3d" ? (
        <div className="overflow-hidden rounded-[18px]" style={{ height: Math.max(height, 480) }}>
          <Plant3D nodes={fp.project.nodes} edges={fp.project.edges} selected={null} onSelect={(id) => id && open(id)} />
        </div>
      ) : (
        <div className="overflow-hidden rounded-[18px] bg-paper" style={{ height }}>
          <ReactFlow<PlantNode, Edge>
            key={fp.project.nodes.length}
            nodes={fp.project.nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.08 }}
            minZoom={0.1}
            maxZoom={1.4}
            panOnScroll={false}
            zoomOnScroll={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
            className="[&_.react-flow__node]:cursor-pointer"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="#d9cdcb" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        </div>
      )}
    </StatsProvider>
  );
}
