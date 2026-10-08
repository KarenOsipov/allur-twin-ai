import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type FinalConnectionState,
  MarkerType,
  MiniMap,
  Panel as FlowPanel,
  ReactFlow,
  ReactFlowProvider,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  AlertTriangle,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  ArrowUpRight,
  ChevronDown,
  Lock,
  Box as BoxIcon,
  Factory,
  CheckCircle2,
  Columns2,
  Copy,
  Grid3x3,
  HelpCircle,
  LayoutGrid,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Thermometer,
  Trash2,
  Undo2,
  Waves,
  Workflow,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { type CSSProperties, type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { request } from "@/shared/api/client";
import { usePlant, useSetFloorLayout } from "@/shared/api/queries";
import { Link, useSearchParams } from "react-router";
import { can, useSession } from "@/shared/auth/session";
import { exportState } from "@/shared/export/ExportButton";
import { num } from "@/shared/lib/format";
import { Button, IconButton } from "@/shared/ui/Button";
import { Field, Input, Select } from "@/shared/ui/Field";
import { toast } from "@/shared/ui/Toaster";
import { PlantSim, type SimStats } from "./engine";
import {
  ACCEPTS_INPUT,
  allurShopTemplate,
  allurTemplate,
  autoLayout,
  bigPlantTemplate,
  blankTemplate,
  canConnect,
  countEquipment,
  defaults,
  EQ_TYPES,
  type EqType,
  type EquipmentSpec,
  flexTemplate,
  GIVES_OUTPUT,
  guessEqType,
  KIND_INFO,
  type Kind,
  newId,
  procDefaults,
  type PlantEdge,
  type PlantNode,
  type Project,
  SPLIT_MODES,
  type SplitMode,
  subassemblyTemplate,
  validate,
} from "./model";
import { EDGE_TYPES, type EdgeActions, EdgeActionsContext, KIND_ICON, NODE_TYPES, PROC_ICON } from "./nodes";
import { KIND_PROC, PROC_GROUPS, PROCS, type ProcKey, procOf, ZONES, zoneColor, zoneCode } from "./procs";
import { ZoneLayer } from "./zones";
import { Plant3D } from "./Plant3D";
import { ProjectMenu } from "./ProjectMenu";
import { builderStats, useBuilderStats, useNodeStats } from "./store";

interface SavedLayout {
  id: number;
  name: string;
  nodes: number;
  equipment: number;
  author: string;
  updated_at: string;
  floor?: boolean;
  changes?: { what: string; before: number; after: number }[];
}

type View = "flow" | "3d" | "split";

const SPEEDS = [10, 60, 300, 900];
const VIEW_KEY = "allur.builder.view";
const LAST_KEY = "allur.builder.last";

const remember = (id: number | null) => {
  try {
    if (id) localStorage.setItem(LAST_KEY, String(id));
    else localStorage.removeItem(LAST_KEY);
  } catch {
  }
};
const lastId = () => {
  try {
    return Number(localStorage.getItem(LAST_KEY)) || null;
  } catch {
    return null;
  }
};

let clipboard: { nodes: PlantNode[]; edges: PlantEdge[] } | null = null;

export function BuilderPage() {
  return (
    <ReactFlowProvider>
      <Builder />
    </ReactFlowProvider>
  );
}

function clock(t: number) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function readView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "3d" || v === "split" ? v : "flow";
  } catch {
    return "flow";
  }
}

const strip = (ns: PlantNode[]): PlantNode[] => ns.map((n) => ({ ...n, selected: false, data: structuredClone(n.data) }));

function Builder() {
  const plant = usePlant();
  const me = useSession();
  const qc = useQueryClient();
  const flow = useReactFlow<PlantNode, PlantEdge>();
  const canSave = can(me, "operate");
  const isAdmin = canSave;
  const readOnly = !canSave;
  const [params, setParams] = useSearchParams();
  const setFloor = useSetFloorLayout();
  const [dirty, setDirty] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<PlantNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<PlantEdge>([]);
  const [name, setName] = useState("Аллюр · Костанай");
  const [savedId, setSavedId] = useState<number | null>(null);
  const [mode, setMode] = useState<"edit" | "monitor">("edit");
  const [view, setViewState] = useState<View>(readView);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(60);
  const [snap, setSnap] = useState(false);
  const [help, setHelp] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [quick, setQuick] = useState<{ x: number; y: number; from: string; handle: string | null; dir: "source" | "target" } | null>(null);
  const [structV, setStructV] = useState(0);
  const [, setHistV] = useState(0);
  const sim = useRef<PlantSim | null>(null);
  const loaded = useRef(false);
  const stats = useBuilderStats();

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  const setView = (v: View) => {
    setViewState(v);
    if (v !== "3d") setTimeout(() => flow.fitView({ padding: 0.12, duration: 300 }), 80);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
    }
  };

  const past = useRef<{ nodes: PlantNode[]; edges: PlantEdge[] }[]>([]);
  const future = useRef<{ nodes: PlantNode[]; edges: PlantEdge[] }[]>([]);
  const lastSnap = useRef<{ at: number; reason: string }>({ at: 0, reason: "" });

  const snapshot = useCallback((reason = "") => {
    const now = performance.now();
    if (now - lastSnap.current.at < 60 || (reason && reason === lastSnap.current.reason && now - lastSnap.current.at < 1500)) {
      lastSnap.current.at = now;
      return;
    }
    lastSnap.current = { at: now, reason };
    past.current.push({ nodes: strip(nodesRef.current), edges: edgesRef.current.map((e) => ({ ...e, selected: false })) });
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    setHistV((v) => v + 1);
    setDirty(true);
  }, []);

  const changed = useCallback(() => setStructV((v) => v + 1), []);

  const travel = (from: typeof past, to: typeof past) => {
    const prev = from.current.pop();
    if (!prev) return;
    to.current.push({ nodes: strip(nodesRef.current), edges: edgesRef.current.map((e) => ({ ...e, selected: false })) });
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setSelected(null);
    lastSnap.current = { at: 0, reason: "" };
    setHistV((v) => v + 1);
    changed();
  };
  const undo = () => travel(past, future);
  const redo = () => travel(future, past);

  const layouts = useQuery({ queryKey: ["layouts"], queryFn: () => request<SavedLayout[]>("/layouts") });
  const floorId = layouts.data?.find((l) => l.floor)?.id ?? null;
  const isFloor = savedId !== null && savedId === floorId;

  const load = useCallback(
    (p: Project, id: number | null = null) => {
      setRunning(false);
      sim.current = null;
      builderStats.set(null);
      setNodes(p.nodes);
      setEdges(p.edges);
      setName(p.name);
      setSavedId(id);
      remember(id);
      setDirty(false);
      setSelected(null);
      past.current = [];
      future.current = [];
      setHistV((v) => v + 1);
      setTimeout(() => flow.fitView({ padding: 0.15, duration: 400 }), 60);
    },
    [flow, setEdges, setNodes],
  );

  const openSaved = useCallback(
    async (id: number) => {
      const l = await request<SavedLayout & { data: { nodes: PlantNode[]; edges: PlantEdge[] } }>(`/layouts/${id}`);
      load({ name: l.name, nodes: l.data.nodes, edges: l.data.edges }, l.id);
    },
    [load],
  );

  useEffect(() => {
    if (loaded.current || !plant.data || !layouts.data) return;
    loaded.current = true;
    const ids = layouts.data.map((l) => l.id);
    const asked = Number(params.get("project")) || null;
    const last = lastId();
    const pick =
      (asked && ids.includes(asked) ? asked : null) ??
      (last && ids.includes(last) ? last : null) ??
      layouts.data.find((l) => l.floor)?.id ??
      layouts.data.find((l) => l.name.startsWith("Аллюр"))?.id ??
      null;
    if (asked) setParams({}, { replace: true });
    if (pick) openSaved(pick).catch(() => load(allurTemplate(plant.data!.equipment)));
    else load(allurTemplate(plant.data.equipment));
  }, [plant.data, layouts.data, load, openSaved]);

  useEffect(() => {
    if (!running) return;
    if (!sim.current) sim.current = new PlantSim(nodesRef.current, edgesRef.current, 7);
    let last = performance.now();
    let lastUi = 0;
    const id = window.setInterval(() => {
      const now = performance.now();
      const real = Math.min((now - last) / 1000, 0.5);
      last = now;
      const s = sim.current;
      if (!s) return;
      let left = real * speed;
      while (left > 0) {
        const dt = Math.min(5, left);
        s.step(dt);
        left -= dt;
      }
      if (now - lastUi > 250) {
        lastUi = now;
        builderStats.set(s.stats());
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [running, speed]);

  useEffect(() => {
    if (!structV || !sim.current) return;
    const t = window.setTimeout(() => {
      if (!sim.current) return;
      sim.current.reconfigure(nodesRef.current, edgesRef.current);
      builderStats.set(sim.current.stats());
    }, 150);
    return () => window.clearTimeout(t);
  }, [structV]);

  useEffect(() => () => builderStats.set(null), []);

  const issues = useMemo(() => validate({ name, nodes, edges }), [name, nodes, edges]);

  const restart = () => {
    sim.current = new PlantSim(nodes, edges, 7);
    builderStats.set(sim.current.stats());
    setRunning(true);
  };

  const start = () => {
    if (issues.length && !sim.current) {
      toast({ title: "Схему нельзя запустить", body: issues[0], tone: "down" });
      return;
    }
    if (!sim.current) restart();
    else setRunning(true);
  };

  const select = (id: string | null) => {
    setSelected(id);
    setNodes((ns) => ns.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
  };

  const makeNode = (kind: Kind, position: { x: number; y: number }, proc?: ProcKey): PlantNode => {
    const data = proc ? procDefaults(proc) : { ...defaults(kind), proc: KIND_PROC[kind] };
    const z = data.zone;
    const same = nodesRef.current.filter((n) => n.data.zone && n.data.zone === z).length;
    return { id: newId(data.kind), type: data.kind, position, data: { ...data, ...(z ? { cell_code: `${zoneCode(z)}-${String(same + 1).padStart(3, "0")}` } : {}) } };
  };

  const addNode = (kind: Kind, position?: { x: number; y: number }, proc?: ProcKey) => {
    if (readOnly) return makeNode(kind, { x: 0, y: 0 }, proc);
    snapshot();
    const pos = position ?? flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const n = makeNode(kind, pos, proc);
    setNodes((ns) => [...ns.map((x) => (x.selected ? { ...x, selected: false } : x)), { ...n, selected: true }]);
    setSelected(n.id);
    changed();
    return n;
  };

  const isValidConnection = useCallback((c: Connection | Edge) => canConnect(c, nodesRef.current, edgesRef.current), []);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!canConnect(c, nodesRef.current, edgesRef.current)) return;
      snapshot();
      setEdges((eds) => [...eds, { id: newId("e"), source: c.source, target: c.target, sourceHandle: c.sourceHandle ?? undefined, targetHandle: c.targetHandle ?? undefined }]);
      changed();
    },
    [setEdges, snapshot, changed],
  );

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, st: FinalConnectionState) => {
    if (st.isValid || !st.fromNode || st.toNode) return;
    const p = "changedTouches" in event ? event.changedTouches[0] : event;
    setQuick({ x: p.clientX, y: p.clientY, from: st.fromNode.id, handle: st.fromHandle?.id ?? null, dir: st.fromHandle?.type === "target" ? "target" : "source" });
  }, []);

  const quickAdd = (kind: Kind) => {
    if (!quick) return;
    const at = flow.screenToFlowPosition({ x: quick.x, y: quick.y });
    const w = ["station", "assembly", "inspection"].includes(kind) ? 250 : 200;
    const n = addNode(kind, quick.dir === "source" ? { x: at.x + 12, y: at.y - 48 } : { x: at.x - w - 12, y: at.y - 48 });
    const e: PlantEdge =
      quick.dir === "source"
        ? { id: newId("e"), source: quick.from, target: n.id, sourceHandle: quick.handle ?? undefined }
        : { id: newId("e"), source: n.id, target: quick.from, sourceHandle: n.data.kind === "inspection" ? "ok" : undefined };
    setEdges((es) => [...es, e]);
    setQuick(null);
  };

  const reconnected = useRef(true);
  const onReconnect = useCallback(
    (old: Edge, c: Connection) => {
      if (!canConnect(c, nodesRef.current, edgesRef.current, old.id)) return;
      reconnected.current = true;
      snapshot();
      setEdges((els) => reconnectEdge(old, c, els, { shouldReplaceId: false }) as PlantEdge[]);
      changed();
    },
    [setEdges, snapshot, changed],
  );

  const removeEdge = useCallback(
    (id: string) => {
      snapshot();
      setEdges((es) => es.filter((e) => e.id !== id));
      changed();
    },
    [setEdges, snapshot, changed],
  );

  const edgeActions = useMemo<EdgeActions>(
    () => ({
      remove: removeEdge,
      insert(edgeId, kind) {
        const e = edgesRef.current.find((x) => x.id === edgeId);
        if (!e) return;
        const a = nodesRef.current.find((n) => n.id === e.source);
        const b = nodesRef.current.find((n) => n.id === e.target);
        if (!a || !b) return;
        snapshot();
        const w = ["station", "assembly", "inspection"].includes(kind) ? 250 : 200;
        const mid = { x: (a.position.x + (a.measured?.width ?? 200) + b.position.x) / 2 - w / 2, y: Math.max(a.position.y + (a.measured?.height ?? 120), b.position.y + (b.measured?.height ?? 120)) + 50 };
        const n = { ...makeNode(kind, mid), selected: true };
        setNodes((ns) => [...ns.map((x) => (x.selected ? { ...x, selected: false } : x)), n]);
        setEdges((es) => [
          ...es.filter((x) => x.id !== edgeId),
          { id: newId("e"), source: e.source, target: n.id, sourceHandle: e.sourceHandle },
          { id: newId("e"), source: n.id, target: e.target, sourceHandle: kind === "inspection" ? "ok" : undefined },
        ]);
        setSelected(n.id);
        changed();
      },
    }),
    [removeEdge, setEdges, setNodes, snapshot, changed],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const proc = e.dataTransfer.getData("application/allur-proc") as ProcKey;
    const kind = (proc && PROCS[proc] ? PROCS[proc].kind : e.dataTransfer.getData("application/allur-node")) as Kind;
    if (!kind || readOnly) return;
    addNode(kind, flow.screenToFlowPosition({ x: e.clientX - 100, y: e.clientY - 40 }), proc && PROCS[proc] ? proc : undefined);
  };

  const updateNode = (id: string, patch: Partial<PlantNode["data"]>) => {
    snapshot(`param:${id}`);
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    changed();
  };

  const removeNode = (id: string) => {
    snapshot();
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelected(null);
    changed();
  };

  const copy = useCallback(() => {
    const sel = nodesRef.current.filter((n) => n.selected);
    if (!sel.length) return false;
    const ids = new Set(sel.map((n) => n.id));
    clipboard = { nodes: strip(sel), edges: edgesRef.current.filter((e) => ids.has(e.source) && ids.has(e.target)) };
    return true;
  }, []);

  const paste = useCallback(() => {
    if (!clipboard?.nodes.length) return;
    snapshot();
    const map = new Map<string, string>();
    const fresh = clipboard.nodes.map((n) => {
      const id = newId(n.data.kind);
      map.set(n.id, id);
      return { ...n, id, position: { x: n.position.x + 60, y: n.position.y + 80 }, selected: true, data: structuredClone(n.data) };
    });
    const freshEdges = clipboard.edges.map((e) => ({ ...e, id: newId("e"), source: map.get(e.source) as string, target: map.get(e.target) as string, selected: false }));
    clipboard = { nodes: fresh.map((n) => ({ ...n, selected: false })), edges: freshEdges };
    setNodes((ns) => [...ns.map((x) => (x.selected ? { ...x, selected: false } : x)), ...fresh]);
    setEdges((es) => [...es, ...freshEdges]);
    setSelected(fresh.length === 1 ? fresh[0].id : null);
    changed();
  }, [setEdges, setNodes, snapshot, changed]);

  const duplicate = useCallback(() => {
    if (copy()) paste();
  }, [copy, paste]);

  const sizeOf = (n: PlantNode) => ({ w: n.measured?.width ?? (["station", "assembly", "inspection"].includes(n.data.kind) ? 250 : 200), h: n.measured?.height ?? 130 });

  const arrangeSelected = (how: "left" | "top" | "hspace" | "vspace") => {
    const sel = nodesRef.current.filter((n) => n.selected);
    if (sel.length < 2) return;
    snapshot();
    const pos = new Map<string, { x: number; y: number }>();
    if (how === "left") {
      const x = Math.min(...sel.map((n) => n.position.x));
      sel.forEach((n) => pos.set(n.id, { x, y: n.position.y }));
    } else if (how === "top") {
      const y = Math.min(...sel.map((n) => n.position.y));
      sel.forEach((n) => pos.set(n.id, { x: n.position.x, y }));
    } else if (how === "hspace") {
      const list = [...sel].sort((a, b) => a.position.x - b.position.x);
      const x0 = list[0].position.x;
      const span = list.at(-1)!.position.x + sizeOf(list.at(-1)!).w - x0;
      const total = list.reduce((s, n) => s + sizeOf(n).w, 0);
      const gap = Math.max(40, (span - total) / (list.length - 1));
      let x = x0;
      list.forEach((n) => {
        pos.set(n.id, { x, y: n.position.y });
        x += sizeOf(n).w + gap;
      });
    } else {
      const list = [...sel].sort((a, b) => a.position.y - b.position.y);
      const y0 = list[0].position.y;
      const span = list.at(-1)!.position.y + sizeOf(list.at(-1)!).h - y0;
      const total = list.reduce((s, n) => s + sizeOf(n).h, 0);
      const gap = Math.max(40, (span - total) / (list.length - 1));
      let y = y0;
      list.forEach((n) => {
        pos.set(n.id, { x: n.position.x, y });
        y += sizeOf(n).h + gap;
      });
    }
    const g = (v: number) => (snap ? Math.round(v / 20) * 20 : v);
    setNodes((ns) => ns.map((n) => (pos.has(n.id) ? { ...n, position: { x: g(pos.get(n.id)!.x), y: g(pos.get(n.id)!.y) } } : n)));
    changed();
  };

  const setZoneSelected = (zone: string) => {
    const ids = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
    if (!ids.size) return;
    snapshot();
    const z = zone.trim();
    setNodes((ns) => ns.map((n) => (ids.has(n.id) ? { ...n, data: { ...n.data, zone: z || undefined } } : n)));
  };

  const pickZone = useCallback(
    (zone: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.data.zone === zone })));
      setSelected(null);
    },
    [setNodes],
  );

  const removeSelected = () => {
    const ids = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
    if (!ids.size) return;
    snapshot();
    setNodes((ns) => ns.filter((n) => !ids.has(n.id)));
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
    setSelected(null);
    changed();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "Escape") {
        setQuick(null);
        setHelp(false);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === "KeyS") {
        e.preventDefault();
        if (canSave) save(false);
        return;
      }
      if (mode !== "edit" || readOnly) return;
      if (!mod) return;
      if (e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.code === "KeyY") {
        e.preventDefault();
        redo();
      } else if (e.code === "KeyC") {
        copy();
      } else if (e.code === "KeyV") {
        e.preventDefault();
        paste();
      } else if (e.code === "KeyD") {
        e.preventDefault();
        duplicate();
      } else if (e.code === "KeyA") {
        e.preventDefault();
        setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = async (asNew: boolean, quiet = false): Promise<SavedLayout | null> => {
    if (isFloor && !asNew && !isAdmin) {
      toast({ title: "Это схема цеха", body: "Её меняет администратор. Сохраните изменения как новый макет — меню проекта → «Сохранить как новый макет».", tone: "down" });
      return null;
    }
    const body = {
      name,
      data: {
        nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
        edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
      },
    };
    try {
      const res =
        savedId && !asNew
          ? await request<SavedLayout>(`/layouts/${savedId}`, { method: "PUT", body })
          : await request<SavedLayout>("/layouts", { method: "POST", body });
      setSavedId(res.id);
      remember(res.id);
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["layouts"] });
      if (res.floor) {
        for (const k of ["floor-layout", "params", "advice", "plant"]) qc.invalidateQueries({ queryKey: [k] });
        toast({ title: "Схема цеха обновлена", body: <FloorToast text={`«${res.name}»: ${res.nodes} узлов. ${changesText(res.changes)}`} />, tone: "run" }, 8000);
      } else if (!quiet) {
        toast({ title: "Макет сохранён", body: `«${res.name}»: ${res.nodes} узлов, ${res.equipment} ед. оборудования. Цех его не видит, пока вы не сделаете его схемой цеха.`, tone: "run" });
      }
      return res;
    } catch (e) {
      toast({ title: "Не удалось сохранить", body: e instanceof Error ? e.message : "", tone: "down" });
      return null;
    }
  };

  const toFloor = async () => {
    if (issues.length) {
      toast({ title: "Схему нельзя отправить в цех", body: issues[0], tone: "down" });
      return;
    }
    let id = savedId;
    if (dirty || !id) {
      const res = await save(!id, true);
      if (!res) return;
      id = res.id;
    }
    setFloor.mutate(id, {
      onSuccess: (res) =>
        toast({ title: "Теперь это схема цеха", body: <FloorToast text={`«${res.name ?? name}» показывает страница «Цех». ${changesText(res.changes)}`} />, tone: "run" }, 8000),
      onError: (e) => toast({ title: "Не удалось отправить в цех", body: e.message, tone: "down" }),
    });
  };

  const openTemplate = (t: string) => {
    if (t === "allur" && plant.data) load(allurTemplate(plant.data.equipment));
    if (t === "allur_shop") load(allurShopTemplate());
    if (t === "flex") load(flexTemplate());
    if (t === "sub") load(subassemblyTemplate());
    if (t === "big4") load(bigPlantTemplate(4));
    if (t === "big10") load(bigPlantTemplate(10));
    if (t === "blank") load(blankTemplate());
  };

  const arrange = () => {
    snapshot("layout");
    setNodes((ns) => autoLayout(ns, edgesRef.current));
    changed();
    setTimeout(() => flow.fitView({ padding: 0.15, duration: 400 }), 60);
    toast(
      {
        title: "Узлы расставлены по порядку",
        body: (
          <button type="button" onClick={() => undo()} className="mt-1 font-semibold text-accent underline-offset-4 hover:underline">
            Вернуть как было (Ctrl+Z)
          </button>
        ),
        tone: "run",
      },
      8000,
    );
  };

  useEffect(() => {
    exportState.builder = () => {
      const st = builderStats.get();
      return {
        name,
        nodes: nodesRef.current.map((n) => {
          const ns = st?.nodes[n.id];
          return {
            name: n.data.name,
            kind: KIND_INFO[n.data.kind].label,
            cycle_s: n.data.cycle_s ?? null,
            parallel: n.data.parallel ?? null,
            equipment: (n.data.equipment ?? []).length,
            defect_pct: n.data.defect_pct ?? null,
            produced: ns ? ns.produced : null,
            utilization: ns ? Math.round(ns.utilization) : null,
          };
        }),
        stats: st
          ? {
              per_hour: Math.round(st.perHour * 10) / 10,
              bottleneck: nodesRef.current.find((n) => n.id === st.bottleneck)?.data.name ?? null,
              summary: {
                "Время модели": clock(st.t),
                "Выпущено": st.output,
                "Темп, в час": Math.round(st.perHour * 10) / 10,
                "В работе (НЗП)": st.wip,
                "Оборудование в отказе": st.down,
                "Тревоги датчиков": st.alarms,
              },
            }
          : {},
      };
    };
    return () => {
      exportState.builder = undefined;
    };
  }, [name]);

  const displayEdges = useMemo<Edge[]>(
    () => edges.map((e) => ({ ...e, type: "flow", markerEnd: { type: MarkerType.ArrowClosed, color: e.sourceHandle === "ng" ? "#e08a1e" : "#8f8382", width: 16, height: 16 } })),
    [edges],
  );

  const sel = nodes.find((n) => n.id === selected) ?? null;
  const zoneNames = [...new Set([...ZONES.map((z) => z.name), ...nodes.map((n) => n.data.zone ?? "").filter(Boolean)])];
  const eqCount = countEquipment({ name, nodes, edges });
  const outsOf = (id: string) => edges.filter((e) => e.source === id).map((e) => ({ id: e.target, name: nodes.find((n) => n.id === e.target)?.data.name ?? e.target }));
  const edit = mode === "edit" && !readOnly;
  const multi = nodes.filter((n) => n.selected);

  const flowCanvas = (
    <ReactFlow<PlantNode, Edge>
      nodes={nodes}
      edges={displayEdges}
      onNodesChange={(ch) => {
        if (ch.some((c) => c.type === "remove")) snapshot();
        onNodesChange(ch);
        if (ch.some((c) => c.type === "remove")) changed();
      }}
      onEdgesChange={(ch) => {
        if (ch.some((c) => c.type === "remove")) snapshot();
        onEdgesChange(ch as never);
        if (ch.some((c) => c.type === "remove")) changed();
      }}
      onNodeDragStart={() => snapshot()}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      isValidConnection={isValidConnection}
      onReconnect={onReconnect}
      onReconnectStart={() => {
        reconnected.current = false;
      }}
      onReconnectEnd={(_, edge) => {
        if (!reconnected.current) removeEdge(edge.id);
        reconnected.current = true;
      }}
      onSelectionChange={({ nodes: s }) => setSelected(s.length === 1 ? s[0].id : s.length ? null : null)}
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      nodesDraggable={edit}
      nodesConnectable={edit}
      edgesReconnectable={edit}
      elementsSelectable
      snapToGrid={snap}
      snapGrid={[20, 20]}
      deleteKeyCode={edit ? ["Backspace", "Delete"] : null}
      selectionKeyCode="Shift"
      multiSelectionKeyCode={["Meta", "Control"]}
      connectionRadius={36}
      minZoom={0.08}
      maxZoom={1.6}
      fitView
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={snap ? BackgroundVariant.Lines : BackgroundVariant.Dots} gap={snap ? 20 : 22} size={1.4} color={snap ? "#eee5e3" : "#d9cdcb"} />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        style={{ width: 150, height: 96 }}
        className={view === "split" ? "!hidden" : "!hidden sm:!block"}
        nodeColor={(n) => {
          const s = builderStats.get()?.nodes[n.id];
          return s?.state === "down" ? "#e03b3b" : s?.state === "run" ? "#17a05d" : s?.state === "blocked" || s?.state === "slow" ? "#d49b00" : "#c9bdbb";
        }}
        maskColor="rgb(244 238 237 / 0.7)"
      />
      <ZoneLayer onPick={edit ? pickZone : undefined} />
      <FlowPanel position="top-left">
        <Kpis stats={stats} nodes={nodes.length} equipment={eqCount} />
      </FlowPanel>
      {edit && multi.length > 1 && (
        <FlowPanel position="top-center" className="!mt-16">
          <SelectionBar count={multi.length} zones={zoneNames} onArrange={arrangeSelected} onZone={setZoneSelected} onDuplicate={duplicate} onRemove={removeSelected} />
        </FlowPanel>
      )}
      {edit && (
        <FlowPanel position="top-right">
          <div className="flex items-center gap-0.5 rounded-full border border-line bg-panel/95 p-0.5 shadow-[var(--shadow-panel)]">
            <IconButton label="Отменить (Ctrl+Z)" onClick={undo} disabled={!past.current.length} className="size-8">
              <Undo2 className="size-4" />
            </IconButton>
            <IconButton label="Вернуть (Ctrl+Shift+Z)" onClick={redo} disabled={!future.current.length} className="size-8">
              <Redo2 className="size-4" />
            </IconButton>
            <IconButton label={snap ? "Сетка включена" : "Привязка к сетке"} onClick={() => setSnap(!snap)} className={clsx("size-8", snap && "bg-ink text-white hover:bg-ink hover:text-white")}>
              <Grid3x3 className="size-4" />
            </IconButton>
            <IconButton label="Подсказки по управлению" onClick={() => setHelp(!help)} className={clsx("size-8", help && "bg-sunken")}>
              <HelpCircle className="size-4" />
            </IconButton>
          </div>
        </FlowPanel>
      )}
      {help && (
        <FlowPanel position="top-right" className="!mt-14">
          <Shortcuts onClose={() => setHelp(false)} />
        </FlowPanel>
      )}
    </ReactFlow>
  );

  const plant3d = (
    <Plant3D
      nodes={nodes}
      edges={edges}
      selected={selected}
      onSelect={(id) => select(id)}
      className={view === "split" ? "rounded-none" : undefined}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <section className="panel rise relative z-30 flex flex-wrap items-center gap-x-4 gap-y-3 p-3 pl-4" style={{ "--i": 0 } as CSSProperties}>
        <div className="flex min-w-0 flex-1 basis-[360px] items-center gap-2">
          <ProjectMenu
            name={name}
            savedId={savedId}
            canSave={canSave}
            dirty={dirty}
            onRename={(n) => {
              setName(n);
              setDirty(true);
            }}
            onOpen={(id) => openSaved(id).catch((e) => toast({ title: "Не удалось открыть проект", body: (e as Error).message, tone: "down" }))}
            onTemplate={openTemplate}
            onSaveAs={() => save(true)}
            floorId={floorId}
            isAdmin={isAdmin}
            onMakeFloor={(id) =>
              setFloor.mutate(id, {
                onSuccess: (res) => toast({ title: "Схема цеха изменена", body: <FloorToast text={`Теперь цех показывает «${res.name ?? ""}». ${changesText(res.changes)}`} />, tone: "run" }, 8000),
                onError: (e) => toast({ title: "Не удалось", body: e.message, tone: "down" }),
              })
            }
            onDeleted={(id) => {
              if (id === savedId) {
                setSavedId(null);
                remember(null);
                setDirty(true);
              }
            }}
          />
          {readOnly && (
            <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border border-line-strong bg-sunken px-3 text-xs font-bold text-ink-2" title="Менять схему могут администратор, директор и мастер смены">
              <Lock className="size-3.5" aria-hidden /> Только просмотр
            </span>
          )}
          {canSave && (!isFloor || isAdmin) && (
            <Button size="sm" variant={dirty ? "primary" : "secondary"} icon={<Save className="size-4" />} onClick={() => save(false)} title={isFloor ? "Сохранить — цех сразу покажет изменения (Ctrl+S)" : "Сохранить макет в базе (Ctrl+S)"}>
              {isFloor ? "Сохранить в цех" : savedId ? "Сохранить" : "Сохранить макет"}
            </Button>
          )}
        </div>

        <Segmented
          label="Вид"
          value={view}
          onChange={(v) => setView(v as View)}
          options={[
            { value: "flow", label: "Схема", icon: <Workflow className="size-3.5" /> },
            { value: "3d", label: "3D", icon: <BoxIcon className="size-3.5" /> },
            { value: "split", label: "Вместе", icon: <Columns2 className="size-3.5" />, wide: true },
          ]}
        />

        <Segmented
          label="Режим"
          value={mode}
          onChange={(v) => {
            setMode(v as "edit" | "monitor");
            if (v === "monitor" && !running) start();
          }}
          options={[
            { value: "edit", label: readOnly ? "Схема" : "Сборка схемы" },
            { value: "monitor", label: "Мониторинг" },
          ]}
        />

        <div className="flex items-center gap-2">
          <div className="display num hidden rounded-full bg-deep px-3.5 py-1.5 text-sm text-white sm:block" title="Время модели с запуска">
            {clock(stats?.t ?? 0)}
          </div>
          <Button variant={running ? "secondary" : "primary"} size="sm" icon={running ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => (running ? setRunning(false) : start())}>
            {running ? "Пауза" : sim.current ? "Продолжить" : "Запустить"}
          </Button>
          <IconButton label="Запустить сначала" onClick={() => (issues.length ? start() : restart())}>
            <RotateCcw className="size-4" />
          </IconButton>
          <div role="radiogroup" aria-label="Скорость" className="hidden rounded-full bg-sunken p-0.5 md:flex">
            {SPEEDS.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={speed === v}
                title={`${v} секунд модели за секунду`}
                onClick={() => setSpeed(v)}
                className={clsx("num h-7 rounded-full px-2.5 text-xs font-bold", speed === v ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink")}
              >
                ×{v}
              </button>
            ))}
          </div>
        </div>
        <SchemeBar isFloor={isFloor} dirty={dirty} isAdmin={isAdmin} busy={setFloor.isPending} floorName={layouts.data?.find((l) => l.floor)?.name ?? null} onToFloor={toFloor} onOpenFloor={floorId && !isFloor ? () => openSaved(floorId) : undefined} />
      </section>

      <div
        className={clsx(
          "grid gap-3",
          edit
            ? sel
              ? "lg:grid-cols-[232px_minmax(0,1fr)_360px]"
              : "lg:grid-cols-[232px_minmax(0,1fr)]"
            : sel || mode === "monitor"
              ? "lg:grid-cols-[minmax(0,1fr)_360px]"
              : "lg:grid-cols-[minmax(0,1fr)]",
        )}
      >
        {edit && (
          <Palette
            onAdd={(k) => addNode(PROCS[k].kind, undefined, k)}
            onLayout={arrange}
            issues={issues}
          />
        )}

        <EdgeActionsContext.Provider value={edit ? edgeActions : null}>
          <section className="panel relative flex h-[calc(100dvh-300px)] min-h-[560px] flex-col overflow-hidden p-0" aria-label="Схема производства">
            {view !== "3d" && <div className={clsx("relative min-h-0", view === "split" ? "h-1/2" : "h-full")}>{flowCanvas}</div>}
            {view !== "flow" && <div className={clsx("relative min-h-0", view === "split" ? "h-1/2 border-t-4 border-deep" : "h-full")}>{plant3d}</div>}
          </section>
        </EdgeActionsContext.Provider>

        <aside className={clsx("flex min-w-0 flex-col gap-3", !sel && mode !== "monitor" && "hidden")}>
          {sel ? (
            <Inspector
              key={sel.id}
              node={sel}
              readOnly={readOnly}
              zones={zoneNames}
              areas={(plant.data?.areas ?? []).map((a) => ({ code: a.code, name: a.name }))}
              outs={outsOf(sel.id)}
              sim={sim.current}
              running={!!sim.current}
              onChange={(p) => updateNode(sel.id, p)}
              onRemove={() => removeNode(sel.id)}
              onDuplicate={() => {
                select(sel.id);
                setTimeout(duplicate, 0);
              }}
              onClose={() => select(null)}
            />
          ) : mode === "monitor" ? (
            <Problems
              stats={stats}
              nodes={nodes}
              onFocus={(id) => {
                select(id);
                if (view !== "3d") flow.fitView({ nodes: [{ id }], padding: 0.6, duration: 500, maxZoom: 1.1 });
              }}
            />
          ) : null}
        </aside>
      </div>

      {quick && <QuickAdd x={quick.x} y={quick.y} kinds={quick.dir === "source" ? ACCEPTS_INPUT : GIVES_OUTPUT} onPick={quickAdd} onClose={() => setQuick(null)} />}
    </div>
  );
}

function changesText(changes?: { what: string; before: number; after: number }[]) {
  if (!changes?.length) return "Параметры линии не изменились.";
  const head = changes.slice(0, 2).map((c) => `${c.what}: ${num(c.before)} → ${num(c.after)}`).join("; ");
  return `Изменено параметров модели: ${changes.length} (${head}${changes.length > 2 ? "…" : ""}).`;
}

function FloorToast({ text }: { text: string }) {
  const go = () => import("@/app/router").then(({ router }) => router.navigate("/app"));
  return (
    <span className="block">
      {text}{" "}
      <button type="button" onClick={go} className="font-semibold text-accent underline-offset-4 hover:underline">
        Открыть цех
      </button>
    </span>
  );
}

function SchemeBar({
  isFloor,
  dirty,
  isAdmin,
  busy,
  floorName,
  onToFloor,
  onOpenFloor,
}: {
  isFloor: boolean;
  dirty: boolean;
  isAdmin: boolean;
  busy: boolean;
  floorName: string | null;
  onToFloor: () => void;
  onOpenFloor?: () => void;
}) {
  return (
    <div
      className={clsx(
        "flex w-full basis-full flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] px-3.5 py-2.5 text-sm",
        isFloor ? "bg-run-soft text-ink" : "bg-sunken text-ink-2",
      )}
      role="status"
    >
      <span className={clsx("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-bold", isFloor ? "bg-run text-white" : "bg-panel text-ink-2 ring-1 ring-line-strong")}>
        <Factory className="size-3.5" aria-hidden />
        {isFloor ? "Схема цеха" : "Макет"}
      </span>
      <span className="min-w-0 flex-1 basis-[240px]">
        {isFloor
          ? dirty
            ? isAdmin
              ? "Есть несохранённые изменения — цех их пока не видит. Нажмите «Сохранить в цех»."
              : "Это схема цеха: менять её может администратор. Ваши правки можно сохранить как новый макет."
            : "Эту схему показывает страница «Цех». Изменения после сохранения сразу появятся в цеху."
          : `Черновик для экспериментов — цех его не видит${floorName ? ` (в цеху сейчас «${floorName}»)` : ""}.`}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {!isFloor && onOpenFloor && (
          <button type="button" onClick={onOpenFloor} className="h-8 rounded-full px-3 text-xs font-semibold text-ink-2 hover:bg-panel hover:text-ink">
            Открыть схему цеха
          </button>
        )}
        {!isFloor && isAdmin && (
          <Button size="sm" variant="primary" loading={busy} icon={<Factory className="size-4" />} onClick={onToFloor}>
            Сделать схемой цеха
          </Button>
        )}
        {!isFloor && !isAdmin && <span className="text-xs text-ink-3">Отправить макет в цех может администратор</span>}
        {isFloor && (
          <Link to="/app" className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-xs font-semibold text-run hover:bg-white/60">
            Открыть цех <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </span>
    </div>
  );
}

function Segmented({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string; icon?: ReactNode; wide?: boolean }[] }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-full bg-sunken p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "h-8 items-center gap-1.5 rounded-full px-3.5 text-[0.8125rem] font-semibold transition-colors",
            o.wide ? "hidden lg:inline-flex" : "inline-flex",
            value === o.value ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function QuickAdd({ x, y, kinds, onPick, onClose }: { x: number; y: number; kinds: Kind[]; onPick: (k: Kind) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 260);
  const top = Math.min(y, window.innerHeight - kinds.length * 46 - 60);
  return (
    <div ref={ref} role="menu" aria-label="Что поставить в конце связи" className="fixed z-50 w-[248px] rounded-[16px] border border-line bg-panel p-1.5 shadow-[var(--shadow-float)]" style={{ left, top }}>
      <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold text-ink-3">Подключить новый узел</p>
      {kinds.map((k) => {
        const Icon = KIND_ICON[k];
        return (
          <button
            key={k}
            type="button"
            role="menuitem"
            onClick={() => onPick(k)}
            className="flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left text-[0.8125rem] font-semibold outline-none hover:bg-sunken focus-visible:bg-sunken"
          >
            <span className="grid size-7 place-items-center rounded-[8px] bg-sunken text-ink-2">
              <Icon className="size-3.5" aria-hidden />
            </span>
            {KIND_INFO[k].label}
          </button>
        );
      })}
    </div>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["Добавить узел", "перетащите из палитры слева или нажмите на него"],
    ["Соединить", "от тёмной точки справа у узла к серой точке слева у следующего"],
    ["Параметры узла", "нажмите на узел — справа откроются цикл, брак и оборудование"],
    ["«Запустить»", "схема и 3D-цех оживут; правки применяются сразу"],
    ["Потяните от точки узла в пустое место", "выбрать, какой узел подключить"],
    ["Клик по связи", "вставить в неё узел или удалить"],
    ["Тяните конец связи", "к другому узлу — переподключить, в пустоту — удалить"],
    ["Ctrl+Z · Ctrl+Shift+Z", "отменить · вернуть"],
    ["Ctrl+C · Ctrl+V · Ctrl+D", "копировать · вставить · дублировать"],
    ["Shift + рамка · Ctrl+A", "выделить несколько · всё — появится панель выравнивания и зон"],
    ["Клик по ярлыку зоны", "выделить все узлы зоны"],
    ["Delete", "удалить выделенное"],
    ["Ctrl+S", "сохранить проект"],
  ];
  return (
    <div className="w-[300px] rounded-[16px] border border-line bg-panel p-4 shadow-[var(--shadow-float)]">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold">Как собрать линию</p>
        <IconButton label="Закрыть подсказки" onClick={onClose} className="size-7">
          <X className="size-4" />
        </IconButton>
      </div>
      <dl className="mt-2 flex flex-col gap-2 text-xs">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="font-semibold text-ink">{k}</dt>
            <dd className="text-ink-3">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 rounded-[10px] bg-sunken px-2.5 py-2 text-[11px] text-ink-2">Правки применяются к работающей модели сразу — перезапускать не нужно.</p>
    </div>
  );
}

function Palette({ onAdd, onLayout, issues }: { onAdd: (k: ProcKey) => void; onLayout: () => void; issues: string[] }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return (
    <aside className="panel flex max-h-[calc(100dvh-300px)] min-h-[560px] min-w-0 flex-col overflow-hidden p-0" aria-label="Библиотека участков">
      <div className="border-b border-line px-3.5 py-2.5">
        <p className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Библиотека участков</p>
        <p className="mt-0.5 text-[11px] text-ink-3">Перетащите на схему или нажмите</p>
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto px-2 py-2">
        {PROC_GROUPS.map((g) => {
          const shut = closed[g.title];
          return (
            <div key={g.title} className="mb-1">
              <button
                type="button"
                onClick={() => setClosed((c) => ({ ...c, [g.title]: !shut }))}
                aria-expanded={!shut}
                className="flex h-7 w-full items-center gap-1.5 rounded-[6px] px-1.5 text-left text-[11px] font-bold tracking-[0.06em] text-ink-2 uppercase hover:bg-sunken"
              >
                <ChevronDown className={clsx("size-3.5 text-ink-3 transition-transform", shut && "-rotate-90")} aria-hidden />
                <span className="size-2 rounded-[2px]" style={{ background: zoneColor(g.title === "Контроль и отгрузка" ? "Контроль" : g.title) }} aria-hidden />
                {g.title}
              </button>
              {!shut && (
                <ul className="mt-0.5 flex flex-col">
                  {g.items.map((k) => {
                    const Icon = PROC_ICON[k];
                    const p = PROCS[k];
                    return (
                      <li key={k}>
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData("application/allur-proc", k);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onClick={() => onAdd(k)}
                          title={p.desc}
                          className="group flex w-full cursor-grab items-center gap-2 rounded-[6px] px-1.5 py-1.5 text-left hover:bg-sunken active:cursor-grabbing"
                        >
                          <span className="grid size-7 shrink-0 place-items-center rounded-[6px] border border-line bg-panel text-ink-2 group-hover:border-ink group-hover:bg-ink group-hover:text-white">
                            <Icon className="size-3.5" aria-hidden />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[0.78rem] leading-tight font-semibold">{p.label}</span>
                            <span className="block truncate text-[10.5px] leading-tight text-ink-3">{KIND_INFO[p.kind].label}</span>
                          </span>
                          <Plus className="size-3.5 shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-line p-2">
        <Button size="sm" variant="ghost" icon={<LayoutGrid className="size-4" />} onClick={onLayout} className="w-full justify-start" title="Выстроить узлы слева направо по потоку. Отменить — Ctrl+Z">
          Расставить по порядку
        </Button>
        <div className={clsx("mt-1.5 rounded-[8px] p-2.5 text-xs", issues.length ? "bg-blocked-soft" : "bg-run-soft")}>
          {issues.length ? (
            <>
              <p className="flex items-center gap-1.5 font-bold text-[#8a6300]">
                <AlertTriangle className="size-3.5" aria-hidden /> Проверьте схему · {issues.length}
              </p>
              <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-ink-2">
                {issues.slice(0, 3).map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="flex items-center gap-1.5 font-bold text-run">
              <CheckCircle2 className="size-3.5" aria-hidden /> Схема готова к запуску
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}

function SelectionBar({
  count,
  zones,
  onArrange,
  onZone,
  onDuplicate,
  onRemove,
}: {
  count: number;
  zones: string[];
  onArrange: (how: "left" | "top" | "hspace" | "vspace") => void;
  onZone: (z: string) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const [zone, setZone] = useState("");
  const btn = "grid size-8 place-items-center rounded-[6px] text-ink-2 hover:bg-sunken hover:text-ink";
  return (
    <div className="flex items-center gap-0.5 rounded-[10px] border border-line-strong bg-panel p-1 shadow-[var(--shadow-float)]" role="toolbar" aria-label="Выделенные узлы">
      <span className="px-2 text-xs font-bold text-ink-2">Выбрано: {count}</span>
      <span className="mx-0.5 h-5 w-px bg-line" />
      <button type="button" className={btn} title="Выровнять по левому краю" aria-label="Выровнять по левому краю" onClick={() => onArrange("left")}>
        <AlignStartVertical className="size-4" />
      </button>
      <button type="button" className={btn} title="Выровнять по верху" aria-label="Выровнять по верху" onClick={() => onArrange("top")}>
        <AlignStartHorizontal className="size-4" />
      </button>
      <button type="button" className={btn} title="Распределить по горизонтали" aria-label="Распределить по горизонтали" onClick={() => onArrange("hspace")}>
        <AlignHorizontalSpaceAround className="size-4" />
      </button>
      <button type="button" className={btn} title="Распределить по вертикали" aria-label="Распределить по вертикали" onClick={() => onArrange("vspace")}>
        <AlignVerticalSpaceAround className="size-4" />
      </button>
      <span className="mx-0.5 h-5 w-px bg-line" />
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          onZone(zone);
        }}
      >
        <input
          list="builder-zones"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          placeholder="Зона, напр. Сварка"
          aria-label="Зона для выделенных узлов"
          className="h-8 w-40 rounded-[6px] border border-line-strong bg-sunken px-2 text-xs focus:border-accent focus:bg-panel focus:outline-none"
        />
        <datalist id="builder-zones">
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <button type="submit" className="h-8 rounded-[6px] bg-ink px-2.5 text-xs font-bold text-white hover:bg-ink-2">
          В зону
        </button>
      </form>
      <span className="mx-0.5 h-5 w-px bg-line" />
      <button type="button" className={btn} title="Дублировать (Ctrl+D)" aria-label="Дублировать выделенное" onClick={onDuplicate}>
        <Copy className="size-4" />
      </button>
      <button type="button" className={clsx(btn, "hover:!bg-down-soft hover:!text-down")} title="Удалить выделенное (Delete)" aria-label="Удалить выделенное" onClick={onRemove}>
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}

function Kpis({ stats, nodes, equipment }: { stats: SimStats | null; nodes: number; equipment: number }) {
  const items: [string, ReactNode, string?][] = stats
    ? [
        ["Выпуск", num(stats.output)],
        ["Темп", `${num(stats.perHour)}/ч`],
        ["В работе", num(stats.wip)],
        ["Оборудование", `${num(stats.equipment)}`, stats.down ? `стоит ${stats.down}` : undefined],
        ["Тревоги датчиков", num(stats.alarms), stats.alarms ? "warn" : undefined],
      ]
    : [
        ["Узлов", num(nodes)],
        ["Оборудование", num(equipment)],
      ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(([l, v, extra]) => (
        <div key={l} className="rounded-[14px] border border-line bg-panel/95 px-3 py-2 shadow-[var(--shadow-panel)]">
          <div className="text-[10.5px] font-semibold text-ink-3">{l}</div>
          <div className="display num text-[1.15rem] leading-tight font-medium">
            {v}
            {extra && extra !== "warn" && <span className="ml-1.5 text-xs font-bold text-down">{extra}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function NumField({ label, value, onChange, min = 0, max = 100000, step = 1, suffix }: { label: string; value: number | undefined; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <Field label={suffix ? `${label}, ${suffix}` : label}>
      <Input type="number" min={min} max={max} step={step} value={value ?? 0} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />
    </Field>
  );
}

function Inspector({
  node,
  outs,
  sim,
  running,
  readOnly,
  zones,
  areas,
  onChange,
  onRemove,
  onDuplicate,
  onClose,
}: {
  node: PlantNode;
  outs: { id: string; name: string }[];
  sim: PlantSim | null;
  running: boolean;
  readOnly: boolean;
  zones: string[];
  areas: { code: string; name: string }[];
  onChange: (p: Partial<PlantNode["data"]>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onClose: () => void;
}) {
  const d = node.data;
  const proc = procOf(d);
  const info = PROCS[proc];
  const Icon = PROC_ICON[proc] ?? KIND_ICON[d.kind];
  const st = useNodeStats(node.id);
  const hasEq = d.kind === "station" || d.kind === "assembly" || d.kind === "inspection";
  const setEq = (list: EquipmentSpec[]) => onChange({ equipment: list });
  const siblings = (Object.keys(PROCS) as ProcKey[]).filter((k) => PROCS[k].kind === d.kind);
  const [tab, setTab] = useState<"params" | "process">("params");

  return (
    <section className="panel flex max-h-[calc(100dvh-300px)] min-h-[560px] flex-col overflow-hidden">
      <header className="border-b border-line">
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-[8px] text-white" style={{ background: zoneColor(d.zone) }}>
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-bold tracking-[0.06em] text-ink-3 uppercase">
              {info.label}
              {d.cell_code ? ` · ${d.cell_code}` : ""}
            </p>
            <p className="truncate font-bold">{d.name}</p>
          </div>
          {!readOnly && (
            <>
              <IconButton label="Дублировать узел (Ctrl+D)" onClick={onDuplicate} className="size-8">
                <Copy className="size-4" />
              </IconButton>
              <IconButton label="Удалить узел" onClick={onRemove} className="size-8 hover:text-down">
                <Trash2 className="size-4" />
              </IconButton>
            </>
          )}
          <IconButton label="Закрыть" onClick={onClose} className="size-8">
            <X className="size-4" />
          </IconButton>
        </div>
        <div role="tablist" aria-label="Разделы" className="flex gap-4 px-4">
          {(
            [
              ["params", "Параметры"],
              ["process", "Процесс"],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={tab === v}
              onClick={() => setTab(v)}
              className={clsx("-mb-px h-9 border-b-2 text-[0.8125rem] font-semibold", tab === v ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink")}
            >
              {l}
            </button>
          ))}
        </div>
      </header>
      {tab === "process" ? (
        <div className="scroll-thin flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          <div>
            <p className="text-[11px] font-bold tracking-[0.06em] text-ink-3 uppercase">Что здесь происходит</p>
            <p className="mt-1.5 text-sm leading-relaxed text-ink">{info.desc}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold tracking-[0.06em] text-ink-3 uppercase">Операции</p>
            <ol className="mt-2 flex flex-col gap-1.5">
              {info.steps.map((step, i) => (
                <li key={step} className="flex items-start gap-2.5 text-sm">
                  <span className="num grid size-5 shrink-0 place-items-center rounded-[4px] bg-sunken text-[11px] font-bold text-ink-2">{i + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
          <div className="rounded-[8px] border border-line p-3 text-xs text-ink-2">
            <p className="font-bold text-ink">Как это моделируется</p>
            <p className="mt-1">
              {KIND_INFO[d.kind].label}: {KIND_INFO[d.kind].hint.toLowerCase()}.
            </p>
            {hasEq && <p className="mt-1">Мощность = мест одновременно × 3600 / цикл. Отказы оборудования случаются в среднем раз в MTBF часов и длятся MTTR минут; отказ критичного оборудования останавливает участок.</p>}
          </div>
          {d.notes && (
            <div>
              <p className="text-[11px] font-bold tracking-[0.06em] text-ink-3 uppercase">Примечание</p>
              <p className="mt-1.5 text-sm whitespace-pre-wrap text-ink-2">{d.notes}</p>
            </div>
          )}
        </div>
      ) : (
      <fieldset disabled={readOnly} className="scroll-thin flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        {readOnly && (
          <p className="flex items-center gap-2 rounded-[8px] bg-sunken px-3 py-2 text-xs text-ink-2">
            <Lock className="size-3.5 shrink-0" aria-hidden /> Только просмотр — менять параметры могут администратор, директор и мастер смены.
          </p>
        )}
        <Field label="Название">
          <Input value={d.name} maxLength={80} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        {siblings.length > 1 && (
          <Field label="Тип процесса">
            <Select value={proc} disabled={readOnly} onChange={(e) => onChange({ proc: e.target.value })}>
              {siblings.map((k) => (
                <option key={k} value={k}>
                  {PROCS[k].label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Зона цеха">
            <Input list="inspector-zones" value={d.zone ?? ""} maxLength={40} placeholder="Сварка" onChange={(e) => onChange({ zone: e.target.value || undefined })} />
            <datalist id="inspector-zones">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </Field>
          <Field label="Код поста">
            <Input value={d.cell_code ?? ""} maxLength={24} placeholder="BIW-001" onChange={(e) => onChange({ cell_code: e.target.value || undefined })} className="font-mono" />
          </Field>
          <NumField label="Персонал" suffix="чел." value={d.workers} onChange={(v) => onChange({ workers: v })} max={500} />
          <Field label="Смен в сутки">
            <Select value={String(d.shifts ?? 2)} disabled={readOnly} onChange={(e) => onChange({ shifts: Number(e.target.value) })}>
              <option value="1">1 смена</option>
              <option value="2">2 смены</option>
              <option value="3">3 смены</option>
            </Select>
          </Field>
          <NumField label="Площадь" suffix="м²" value={d.area_m2} onChange={(v) => onChange({ area_m2: v })} max={100000} />
          {areas.length > 0 && d.kind !== "splitter" && d.kind !== "transport" && (
            <Field label="Участок двойника">
              <Select value={d.area ?? ""} disabled={readOnly} onChange={(e) => onChange({ area: e.target.value || undefined })}>
                <option value="">— не привязан</option>
                {areas.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        {d.kind === "source" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <NumField label="Поставка" suffix="в час" value={d.rate_per_hour} onChange={(v) => onChange({ rate_per_hour: v })} max={2000} />
              <NumField label="Ёмкость склада" value={d.stock_cap} onChange={(v) => onChange({ stock_cap: v })} min={1} max={5000} />
            </div>
            <NumField label="На складе при запуске" value={d.stock_init} onChange={(v) => onChange({ stock_init: v })} max={5000} />
            {running && (
              <Button size="sm" variant="danger" icon={<Zap className="size-4" />} onClick={() => sim?.pauseSupply(node.id, 60)}>
                Остановить поставку на 1 час
              </Button>
            )}
          </>
        )}
        {d.kind === "buffer" && (
          <div className="grid grid-cols-2 gap-3">
            <NumField label="Вместимость" suffix="шт" value={d.capacity} onChange={(v) => onChange({ capacity: v })} min={1} max={1000} />
            <NumField label="При запуске" suffix="шт" value={d.stock_init} onChange={(v) => onChange({ stock_init: v })} max={1000} />
          </div>
        )}
        {d.kind === "transport" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <NumField label="Время в пути" suffix="с" value={d.travel_s} onChange={(v) => onChange({ travel_s: v })} min={1} max={36000} />
              <NumField label="Вмещает" suffix="шт" value={d.capacity} onChange={(v) => onChange({ capacity: v })} min={1} max={500} />
            </div>
            <p className="rounded-[12px] bg-sunken px-3 py-2 text-xs text-ink-2">Пропускная способность: до {num(((d.capacity ?? 1) * 3600) / Math.max(d.travel_s ?? 1, 1))} изделий в час</p>
          </>
        )}
        {d.kind === "splitter" && (
          <SplitterEditor mode={d.split_mode ?? "free"} shares={d.shares ?? {}} outs={outs} sent={st?.lanes} capacity={d.capacity ?? 4} onChange={onChange} />
        )}
        {hasEq && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <NumField label="Цикл" suffix="с" value={d.cycle_s} onChange={(v) => onChange({ cycle_s: v })} min={5} max={36000} />
              <NumField label="Мест одновременно" value={d.parallel} onChange={(v) => onChange({ parallel: v })} min={1} max={50} />
              <NumField label="Разброс цикла" suffix="%" value={d.variability} onChange={(v) => onChange({ variability: v })} max={50} />
              {d.kind === "inspection" ? (
                <NumField label="Находит дефектов" suffix="%" value={d.detect_pct} onChange={(v) => onChange({ detect_pct: v })} max={100} />
              ) : (
                <NumField label="Брак" suffix="%" value={d.defect_pct} onChange={(v) => onChange({ defect_pct: v })} max={50} step={0.1} />
              )}
            </div>
            {d.kind === "station" && (
              <label className="flex items-start gap-2.5 rounded-[12px] border border-line p-3 text-sm">
                <input type="checkbox" checked={Boolean(d.rework)} onChange={(e) => onChange({ rework: e.target.checked })} className="mt-0.5 accent-[var(--color-brand)]" />
                <span>
                  <span className="font-semibold">Участок доработки</span>
                  <span className="block text-xs text-ink-3">Исправляет дефекты. Подключите к нему выход «брак» контроля, а его выход — обратно на контроль.</span>
                </span>
              </label>
            )}
            {d.kind === "inspection" && (
              <p className="rounded-[12px] bg-[#fde9cf]/60 px-3 py-2 text-xs text-ink-2">
                У контроля два выхода: верхний — <b>годные</b>, нижний — <b>брак</b>. Если «брак» никуда не подключён, дефектные изделия списываются.
              </p>
            )}
            <p className="rounded-[12px] bg-sunken px-3 py-2 text-xs text-ink-2">
              Мощность: ≈ {num(((d.parallel ?? 1) * 3600) / Math.max(d.cycle_s ?? 1, 1))} изделий в час
            </p>
            <EquipmentEditor list={d.equipment ?? []} kind={d.kind} onChange={setEq} live={st?.eq} sim={sim} nodeId={node.id} />
          </>
        )}
        {st && (
          <div className="grid grid-cols-3 gap-2 rounded-[14px] bg-deep p-3 text-white">
            {[
              ["Выпуск", num(st.produced)],
              ["В час", num(st.perHour)],
              [d.kind === "transport" ? "Заполнен" : "Загрузка", `${Math.round(st.utilization)}%`],
            ].map(([l, v]) => (
              <div key={l}>
                <div className="text-[10.5px] text-white/60">{l}</div>
                <div className="display num text-lg font-light">{v}</div>
              </div>
            ))}
          </div>
        )}
        <Field label="Примечание">
          <textarea
            value={d.notes ?? ""}
            maxLength={600}
            rows={3}
            onChange={(e) => onChange({ notes: e.target.value || undefined })}
            className="w-full rounded-[12px] border border-line bg-sunken px-3 py-2 text-sm outline-none focus:border-ink/30"
            placeholder="Особенности поста, оснастка, ограничения"
          />
        </Field>
      </fieldset>
      )}
    </section>
  );
}

function SplitterEditor({
  mode,
  shares,
  outs,
  sent,
  capacity,
  onChange,
}: {
  mode: SplitMode;
  shares: Record<string, number>;
  outs: { id: string; name: string }[];
  sent?: Record<string, number>;
  capacity: number;
  onChange: (p: Partial<PlantNode["data"]>) => void;
}) {
  const total = outs.reduce((s, o) => s + Math.max(0, shares[o.id] ?? 1), 0) || 1;
  const sentTotal = outs.reduce((s, o) => s + (sent?.[o.id] ?? 0), 0);
  return (
    <>
      <Field label="Как делить поток">
        <Select value={mode} onChange={(e) => onChange({ split_mode: e.target.value as SplitMode })}>
          {Object.entries(SPLIT_MODES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <NumField label="Вмещает" suffix="шт" value={capacity} onChange={(v) => onChange({ capacity: v })} min={1} max={200} />
      <div>
        <p className="text-[0.8125rem] font-semibold text-ink-2">Выходы · {outs.length}</p>
        {outs.length === 0 && <p className="mt-1 text-xs text-ink-3">Подключите к распределителю хотя бы два узла справа.</p>}
        <ul className="mt-2 flex flex-col gap-2">
          {outs.map((o) => (
            <li key={o.id} className="rounded-[12px] border border-line p-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{o.name}</span>
                {mode === "share" && (
                  <label className="flex items-center gap-1 text-xs text-ink-3">
                    доля
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={shares[o.id] ?? 1}
                      onChange={(e) => onChange({ shares: { ...shares, [o.id]: Math.max(0, Number(e.target.value) || 0) } })}
                      className="w-16 rounded-[8px] border border-line bg-sunken px-1.5 py-0.5 text-xs text-ink"
                    />
                    <b className="num w-9 text-right text-ink">{Math.round((Math.max(0, shares[o.id] ?? 1) / total) * 100)}%</b>
                  </label>
                )}
              </div>
              {sent && (
                <p className="mt-1 text-[11px] text-ink-3">
                  отдано {num(sent[o.id] ?? 0)}
                  {sentTotal ? ` · ${Math.round(((sent[o.id] ?? 0) / sentTotal) * 100)}%` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
        {mode === "free" && outs.length > 0 && <p className="mt-2 text-xs text-ink-3">Изделие забирает тот выход, который освободился первым.</p>}
      </div>
    </>
  );
}

function EquipmentEditor({
  list,
  kind,
  onChange,
  live,
  sim,
  nodeId,
}: {
  list: EquipmentSpec[];
  kind: Kind;
  onChange: (l: EquipmentSpec[]) => void;
  live?: { code: string; state: string; temp: number; vib: number; wear: number; alarm: boolean; failures: number }[];
  sim: PlantSim | null;
  nodeId: string;
}) {
  const set = (i: number, p: Partial<EquipmentSpec>) => onChange(list.map((e, k) => (k === i ? { ...e, ...p } : e)));
  const liveBy = new Map((live ?? []).map((e) => [e.code, e]));
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-[0.8125rem] font-semibold text-ink-2">Оборудование · {list.length}</p>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus className="size-4" />}
          onClick={() => {
            const code = `ОБ-${String(list.length + 1).padStart(2, "0")}`;
            onChange([...list, { code, critical: true, mtbf_h: 120, mttr_min: 30, type: list.at(-1)?.type ?? guessEqType(code, kind) }]);
          }}
        >
          Добавить
        </Button>
      </div>
      <ul className="mt-2 flex flex-col gap-2">
        {list.map((e, i) => {
          const l = liveBy.get(e.code);
          return (
            <li key={i} className={clsx("rounded-[14px] border p-2.5", l?.state === "down" ? "border-down/50 bg-down-soft" : l?.alarm ? "border-[#ff9a3d]/60 bg-blocked-soft" : "border-line")}>
              <div className="flex items-center gap-2">
                <input
                  aria-label="Код оборудования"
                  value={e.code}
                  maxLength={40}
                  onChange={(ev) => set(i, { code: ev.target.value })}
                  className="min-w-0 flex-1 rounded-[8px] bg-transparent px-1.5 py-1 text-sm font-bold outline-none hover:bg-sunken focus:bg-sunken"
                />
                <label className="flex items-center gap-1 text-[11px] text-ink-2">
                  <input type="checkbox" checked={e.critical} onChange={(ev) => set(i, { critical: ev.target.checked })} className="accent-[var(--color-brand)]" />
                  критичное
                </label>
                <IconButton label={`Убрать ${e.code}`} className="size-7" onClick={() => onChange(list.filter((_, k) => k !== i))}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <label className="col-span-2 flex items-center gap-1.5 text-[11px] text-ink-3">
                  вид в 3D
                  <span className="min-w-0 flex-1">
                    <Select size="sm" aria-label="Вид в 3D" value={e.type ?? guessEqType(e.code, kind)} onChange={(ev) => set(i, { type: ev.target.value as EqType })}>
                      {Object.entries(EQ_TYPES).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                  </span>
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-ink-3">
                  отказ раз в
                  <input
                    type="number"
                    min={1}
                    value={e.mtbf_h}
                    onChange={(ev) => set(i, { mtbf_h: Math.max(1, Number(ev.target.value) || 1) })}
                    className="w-14 rounded-[8px] border border-line bg-sunken px-1.5 py-0.5 text-xs text-ink"
                  />
                  ч
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-ink-3">
                  ремонт
                  <input
                    type="number"
                    min={1}
                    value={e.mttr_min}
                    onChange={(ev) => set(i, { mttr_min: Math.max(1, Number(ev.target.value) || 1) })}
                    className="w-14 rounded-[8px] border border-line bg-sunken px-1.5 py-0.5 text-xs text-ink"
                  />
                  мин
                </label>
              </div>
              {l && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  <span className={clsx("font-bold", l.state === "down" ? "text-down" : l.state === "run" ? "text-run" : "text-ink-3")}>
                    {l.state === "down" ? "Отказ" : l.state === "run" ? "Работает" : "Ожидает"}
                  </span>
                  <span className={clsx("inline-flex items-center gap-1", l.temp > 70 && "font-bold text-down")}>
                    <Thermometer className="size-3" aria-hidden /> {Math.round(l.temp)} °C
                  </span>
                  <span className={clsx("inline-flex items-center gap-1", l.vib > 3.2 && "font-bold text-down")}>
                    <Waves className="size-3" aria-hidden /> {l.vib.toFixed(1)} мм/с
                  </span>
                  <span className="text-ink-3">износ {Math.round(Math.min(l.wear, 9.99) * 100)}%</span>
                  <span className="ml-auto flex gap-1">
                    {l.state === "down" ? (
                      <button type="button" onClick={() => sim?.repair(nodeId, e.code)} className="inline-flex items-center gap-1 rounded-full bg-run-soft px-2 py-0.5 font-bold text-run">
                        <Wrench className="size-3" aria-hidden /> Починить
                      </button>
                    ) : (
                      <button type="button" onClick={() => sim?.fail(nodeId, e.code, 30)} className="inline-flex items-center gap-1 rounded-full bg-down-soft px-2 py-0.5 font-bold text-down">
                        <Zap className="size-3" aria-hidden /> Сломать
                      </button>
                    )}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Problems({ stats, nodes, onFocus }: { stats: SimStats | null; nodes: PlantNode[]; onFocus: (id: string) => void }) {
  const name = (id: string | null) => nodes.find((n) => n.id === id)?.data.name ?? "—";
  return (
    <section className="panel flex max-h-[calc(100dvh-300px)] min-h-[560px] flex-col overflow-hidden">
      <header className="border-b border-line px-5 py-4">
        <h2 className="text-[1.1rem]">Что происходит</h2>
        <p className="mt-0.5 text-xs text-ink-3">Отказы и тревоги датчиков — сверху самые важные. Нажмите — откроется узел.</p>
      </header>
      {!stats ? (
        <p className="p-5 text-sm text-ink-2">Запустите симуляцию — здесь появятся отказы, тревоги и узкое место.</p>
      ) : (
        <div className="scroll-thin flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Стоит оборудования" value={num(stats.down)} bad={stats.down > 0} />
            <Tile label="Тревог датчиков" value={num(stats.alarms)} bad={stats.alarms > 0} />
            <Tile label="Отбраковано" value={num(stats.scrapped)} />
            <Tile label="Узкое место" value={name(stats.bottleneck)} small />
          </div>
          {stats.bottleneck && (
            <button type="button" onClick={() => onFocus(stats.bottleneck as string)} className="mt-2 w-full rounded-[14px] bg-brand-soft px-3 py-2 text-left text-xs text-ink-2 hover:bg-brand/15">
              <b className="text-brand">Узкое место:</b> «{name(stats.bottleneck)}» загружен сильнее всех — любая его минута простоя теряет выпуск всей схемы.
            </button>
          )}
          <ul className="mt-3 flex flex-col gap-2">
            {stats.problems.length === 0 && <li className="rounded-[14px] bg-run-soft px-3 py-2.5 text-sm font-semibold text-run">Всё оборудование работает, тревог нет.</li>}
            {stats.problems.slice(0, 60).map((p, i) => (
              <li key={`${p.node}${p.equipment}${i}`}>
                <button
                  type="button"
                  onClick={() => onFocus(p.node)}
                  className={clsx("flex w-full gap-2.5 rounded-[14px] p-3 text-left transition-colors", p.kind === "down" ? "bg-down-soft hover:bg-down/15" : "bg-blocked-soft hover:bg-blocked/20")}
                >
                  {p.kind === "down" ? <Zap className="mt-0.5 size-4 shrink-0 text-down" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#a26b00]" aria-hidden />}
                  <span className="min-w-0">
                    <span className="block text-sm font-bold">{p.nodeName}</span>
                    <span className="block text-xs text-ink-2">{p.text}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Tile({ label, value, bad, small }: { label: string; value: string; bad?: boolean; small?: boolean }) {
  return (
    <div className={clsx("rounded-[14px] p-3", bad ? "bg-down-soft" : "bg-sunken")}>
      <div className="text-[11px] font-semibold text-ink-3">{label}</div>
      <div className={clsx("display num truncate leading-tight font-light", small ? "text-base" : "text-2xl", bad && "text-down")} title={value}>
        {value}
      </div>
    </div>
  );
}
