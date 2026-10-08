import type { Connection, Edge, Node } from "@xyflow/react";
import { PROCS, type ProcKey, procEquipment, zoneCode } from "./procs";

export type Kind = "source" | "station" | "assembly" | "inspection" | "buffer" | "splitter" | "transport" | "sink";

export type EqType = "machine" | "robot" | "press" | "booth" | "oven" | "conveyor" | "jig" | "tool" | "lift" | "tester" | "tank";

export const EQ_TYPES: Record<EqType, string> = {
  machine: "Станок",
  robot: "Робот",
  press: "Пресс",
  booth: "Камера (окраска, мойка)",
  oven: "Печь / сушка",
  conveyor: "Привод конвейера",
  jig: "Кондуктор / оснастка",
  tool: "Инструмент",
  lift: "Подъёмник",
  tester: "Стенд контроля",
  tank: "Ёмкость / заливка",
};

export interface EquipmentSpec {
  code: string;
  critical: boolean;
  mtbf_h: number;
  mttr_min: number;
  type?: EqType;
}

export type SplitMode = "free" | "rr" | "share";
export const SPLIT_MODES: Record<SplitMode, string> = {
  free: "В свободный выход",
  rr: "По очереди",
  share: "По долям",
};

export type NodeParams = {
  name: string;
  rate_per_hour?: number;
  stock_cap?: number;
  stock_init?: number;
  parallel?: number;
  cycle_s?: number;
  variability?: number;
  defect_pct?: number;
  equipment?: EquipmentSpec[];
  detect_pct?: number;
  rework?: boolean;
  capacity?: number;
  split_mode?: SplitMode;
  shares?: Record<string, number>;
  travel_s?: number;
  proc?: string;
  zone?: string;
  cell_code?: string;
  area?: string;
  workers?: number;
  shifts?: number;
  area_m2?: number;
  notes?: string;
};

export type PlantNode = Node<NodeParams & { kind: Kind }, Kind>;
export type PlantEdge = Edge;

export interface Project {
  name: string;
  nodes: PlantNode[];
  edges: PlantEdge[];
}

export const KIND_INFO: Record<Kind, { label: string; hint: string }> = {
  source: { label: "Склад / поставка", hint: "Откуда приходят заготовки или комплекты" },
  station: { label: "Участок", hint: "Обработка: сварка, окраска, штамповка, механообработка…" },
  assembly: { label: "Сборка", hint: "Соединяет потоки: по одному изделию с каждого входа" },
  inspection: { label: "Контроль", hint: "Проверяет и отбраковывает дефектные изделия" },
  buffer: { label: "Буфер", hint: "Накопитель между участками" },
  splitter: { label: "Распределитель", hint: "Делит поток между выходами: по очереди, по долям или в свободный" },
  transport: { label: "Конвейер", hint: "Везёт изделия между участками: время в пути и вместимость" },
  sink: { label: "Склад ГП", hint: "Куда уходит готовая продукция" },
};

export function guessEqType(code: string, kind: Kind, hint = ""): EqType {
  const s = `${code} ${hint}`.toLowerCase();
  if (/робот|abb|kuka|^рб|^св/.test(s)) return "robot";
  if (/пресс|штамп|^пр|^шт/.test(s)) return "press";
  if (/печь|суш/.test(s)) return "oven";
  if (/камер|окрас|мойк|дожд|^км|^ок/.test(s)) return kind === "inspection" ? "tester" : "booth";
  if (/конвейер|привод/.test(s)) return "conveyor";
  if (/кондуктор|оснаст/.test(s)) return "jig";
  if (/гайков|инструм/.test(s)) return "tool";
  if (/подъём|подъем|лифт/.test(s)) return "lift";
  if (/заливк|ёмк|бак|станц/.test(s)) return "tank";
  if (/стенд|контрол|^кт/.test(s) || kind === "inspection") return "tester";
  if (/^сб|^фс|сборк/.test(s)) return "lift";
  if (/^дв/.test(s)) return "machine";
  return "machine";
}

const RU_EQ_KIND: Record<string, EqType> = {
  Робот: "robot",
  Оснастка: "jig",
  Конвейер: "conveyor",
  Камера: "booth",
  Печь: "oven",
  Инструмент: "tool",
  Станция: "tank",
  Стенд: "tester",
};

let seq = 1;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function defaults(kind: Kind, name?: string): NodeParams & { kind: Kind } {
  switch (kind) {
    case "source":
      return { kind, name: name ?? "Склад заготовок", rate_per_hour: 20, stock_cap: 60, stock_init: 30 };
    case "station":
      return {
        kind,
        name: name ?? "Участок",
        parallel: 1,
        cycle_s: 180,
        variability: 6,
        defect_pct: 1,
        equipment: [
          { code: "СТ-01", critical: true, mtbf_h: 120, mttr_min: 30, type: "machine" },
          { code: "СТ-02", critical: false, mtbf_h: 200, mttr_min: 20, type: "robot" },
        ],
      };
    case "assembly":
      return { kind, name: name ?? "Сборка", parallel: 1, cycle_s: 200, variability: 6, defect_pct: 1, equipment: [{ code: "СБ-01", critical: true, mtbf_h: 150, mttr_min: 30, type: "lift" }] };
    case "inspection":
      return { kind, name: name ?? "Контроль", parallel: 1, cycle_s: 120, variability: 5, defect_pct: 0, detect_pct: 95, equipment: [{ code: "КТ-01", critical: false, mtbf_h: 300, mttr_min: 20, type: "tester" }] };
    case "buffer":
      return { kind, name: name ?? "Буфер", capacity: 6 };
    case "splitter":
      return { kind, name: name ?? "Распределитель", capacity: 4, split_mode: "rr", shares: {} };
    case "transport":
      return { kind, name: name ?? "Конвейер", capacity: 8, travel_s: 120 };
    case "sink":
      return { kind, name: name ?? "Склад ГП" };
  }
}

export function procDefaults(key: ProcKey, name?: string, zone?: string): NodeParams & { kind: Kind } {
  const p = PROCS[key];
  const base = defaults(p.kind, name ?? p.label);
  const z = zone ?? p.zone;
  const eq = p.eq.length ? procEquipment(key) : base.equipment;
  return {
    ...base,
    ...structuredClone(p.params),
    name: name ?? p.label,
    proc: key,
    ...(z ? { zone: z } : {}),
    ...(eq ? { equipment: eq } : {}),
    shifts: p.params.shifts ?? 2,
  };
}

const node = (id: string, kind: Kind, x: number, y: number, params: Partial<NodeParams> = {}): PlantNode => ({
  id,
  type: kind,
  position: { x, y },
  data: { ...defaults(kind), ...params, kind },
});

const edge = (a: string, b: string, handle?: "ok" | "ng"): PlantEdge => ({ id: `e-${a}-${b}`, source: a, target: b, ...(handle ? { sourceHandle: handle } : {}) });

export interface PlantEquipmentInput {
  code: string;
  area: string;
  kind?: string;
  critical: boolean;
  mtbf_h: number;
}

export function allurTemplate(equipment: PlantEquipmentInput[]): Project {
  const eq = (area: string) =>
    equipment
      .filter((e) => e.area === area)
      .map((e) => ({
        code: e.code,
        critical: e.critical,
        mtbf_h: e.mtbf_h,
        mttr_min: e.critical ? 35 : 25,
        type: e.code.startsWith("Дождь") ? ("tester" as const) : (RU_EQ_KIND[e.kind ?? ""] ?? guessEqType(e.code, area === "QC" ? "inspection" : "station")),
      }));
  const nodes = [
    node("wh_in", "source", 0, 40, { name: "Склад комплектов", rate_per_hour: 34, stock_cap: 60, stock_init: 30 }),
    node("weld", "station", 290, 0, { name: "Сварка", cycle_s: 228, equipment: eq("WELD"), defect_pct: 1.7 }),
    node("buf1", "buffer", 620, 40, { name: "Буфер после сварки", capacity: 6, stock_init: 3 }),
    node("paint", "station", 900, 0, { name: "Окраска", cycle_s: 234, equipment: eq("PAINT"), defect_pct: 3.5 }),
    node("buf2", "buffer", 1230, 40, { name: "Буфер после окраски", capacity: 8, stock_init: 5 }),
    node("assy", "station", 290, 300, { name: "Сборка", cycle_s: 226, equipment: eq("ASSY"), defect_pct: 1.1 }),
    node("buf3", "buffer", 620, 340, { name: "Буфер после сборки", capacity: 4, stock_init: 2 }),
    node("qc", "inspection", 900, 300, { name: "Контроль качества", cycle_s: 150, equipment: eq("QC"), detect_pct: 92 }),
    node("wh_out", "sink", 1230, 340, { name: "Склад готовых авто" }),
  ];
  const ids = nodes.map((n) => n.id);
  return { name: "Аллюр · Костанай", nodes, edges: ids.slice(1).map((id, i) => edge(ids[i], id)) };
}

export function blankTemplate(): Project {
  return {
    name: "Новый проект",
    nodes: [node("src", "source", 0, 100), node("st", "station", 320, 60), node("out", "sink", 680, 100)],
    edges: [edge("src", "st"), edge("st", "out")],
  };
}

export function subassemblyTemplate(): Project {
  const nodes = [
    node("bodies", "source", 0, 0, { name: "Склад листа", rate_per_hour: 22 }),
    node("press", "station", 300, -40, { name: "Штамповка", cycle_s: 120, parallel: 2, equipment: eqList("ПР", 3) }),
    node("bw", "station", 640, -40, { name: "Сварка кузова", cycle_s: 150, parallel: 1, equipment: eqList("РБ", 6) }),
    node("pt", "station", 980, -40, { name: "Окраска", cycle_s: 140, parallel: 1, equipment: eqList("КМ", 3) }),
    node("b1", "buffer", 1320, 10, { name: "Буфер кузовов", capacity: 10 }),
    node("eng", "source", 0, 360, { name: "Поставка двигателей", rate_per_hour: 24 }),
    node("emach", "station", 300, 320, { name: "Подготовка двигателя", cycle_s: 130, equipment: eqList("ДВ", 2) }),
    node("b2", "buffer", 640, 370, { name: "Буфер двигателей", capacity: 12 }),
    node("marry", "assembly", 1580, 160, { name: "Свадьба кузова и двигателя", cycle_s: 140, equipment: eqList("СБ", 2) }),
    node("final", "station", 1920, 160, { name: "Финальная сборка", cycle_s: 145, parallel: 2, equipment: eqList("ФС", 4) }),
    node("qc", "inspection", 2260, 160, { name: "Контроль", cycle_s: 90, equipment: eqList("КТ", 2, false) }),
    node("out", "sink", 2600, 190, { name: "Склад ГП" }),
  ];
  const edges = [
    edge("bodies", "press"),
    edge("press", "bw"),
    edge("bw", "pt"),
    edge("pt", "b1"),
    edge("b1", "marry"),
    edge("eng", "emach"),
    edge("emach", "b2"),
    edge("b2", "marry"),
    edge("marry", "final"),
    edge("final", "qc"),
    edge("qc", "out"),
  ];
  return { name: "Завод с подсборками", nodes, edges };
}

function eqList(prefix: string, n: number, critical = true, type?: EqType): EquipmentSpec[] {
  return Array.from({ length: n }, (_, i) => {
    const code = `${prefix}-${String(i + 1).padStart(2, "0")}`;
    return {
      code,
      critical: critical && i % 3 !== 2,
      mtbf_h: 90 + ((i * 37) % 120),
      mttr_min: 20 + ((i * 13) % 30),
      type: type ?? guessEqType(code, "station"),
    };
  });
}

export function flexTemplate(): Project {
  const nodes = [
    node("src", "source", 0, 120, { name: "Склад кузовов", rate_per_hour: 30, stock_init: 24 }),
    node("weld", "station", 300, 80, { name: "Сварка", cycle_s: 110, equipment: eqList("РБ", 4, true, "robot") }),
    node("split", "splitter", 640, 120, { name: "Распределитель на окраску", split_mode: "share", shares: { p1: 60, p2: 40 } }),
    node("p1", "station", 920, -40, { name: "Окраска 1", cycle_s: 200, equipment: eqList("КМ1", 2, true, "booth"), defect_pct: 4 }),
    node("p2", "station", 920, 260, { name: "Окраска 2", cycle_s: 260, equipment: eqList("КМ2", 2, true, "booth"), defect_pct: 3 }),
    node("tr", "transport", 1260, 120, { name: "Конвейер в сборку", capacity: 10, travel_s: 240 }),
    node("assy", "station", 1540, 80, { name: "Сборка", cycle_s: 110, parallel: 1, equipment: eqList("ФС", 3, true, "lift") }),
    node("qc", "inspection", 1880, 80, { name: "Контроль", cycle_s: 80, detect_pct: 95, equipment: eqList("КТ", 2, false, "tester") }),
    node("rw", "station", 1880, 400, { name: "Доработка брака", cycle_s: 420, rework: true, defect_pct: 0, equipment: eqList("ДР", 1, false, "tool") }),
    node("out", "sink", 2220, 120, { name: "Склад ГП" }),
  ];
  const edges = [
    edge("src", "weld"),
    edge("weld", "split"),
    edge("split", "p1"),
    edge("split", "p2"),
    edge("p1", "tr"),
    edge("p2", "tr"),
    edge("tr", "assy"),
    edge("assy", "qc"),
    edge("qc", "out", "ok"),
    edge("qc", "rw", "ng"),
    edge("rw", "qc"),
  ];
  return { name: "Гибкая линия с доработкой", nodes, edges };
}

export function bigPlantTemplate(lines: number): Project {
  const stages: { name: string; prefix: string; cycle: number; parallel: number; eq: number }[] = [
    { name: "Штамповка", prefix: "ШТ", cycle: 110, parallel: 2, eq: 4 },
    { name: "Сварка", prefix: "СВ", cycle: 180, parallel: 3, eq: 8 },
    { name: "Окраска", prefix: "ОК", cycle: 170, parallel: 3, eq: 5 },
    { name: "Сборка", prefix: "СБ", cycle: 175, parallel: 3, eq: 7 },
  ];
  const nodes: PlantNode[] = [];
  const edges: PlantEdge[] = [];
  const letters = "АБВГДЕЖЗИКЛМНОПРСТ";
  const out = "out";
  const rowH = 240;
  const totalH = lines * rowH;
  for (let l = 0; l < lines; l++) {
    const L = letters[l] ?? String(l + 1);
    const y = l * rowH;
    const src = `src-${l}`;
    nodes.push(node(src, "source", 0, y + 30, { name: `Склад линии ${L}`, rate_per_hour: 58 }));
    let prev = src;
    stages.forEach((st, i) => {
      const id = `st-${l}-${i}`;
      nodes.push(
        node(id, "station", 300 + i * 600, y, {
          name: `${st.name} ${L}`,
          cycle_s: st.cycle,
          parallel: st.parallel,
          equipment: eqList(`${st.prefix}${L}`, st.eq),
          defect_pct: i === 2 ? 2.5 : 1,
        }),
      );
      edges.push(edge(prev, id));
      prev = id;
      if (i < stages.length - 1) {
        const b = `b-${l}-${i}`;
        nodes.push(node(b, "buffer", 300 + i * 600 + 330, y + 60, { name: `Буфер ${L}${i + 1}`, capacity: 8 }));
        edges.push(edge(prev, b));
        prev = b;
      }
    });
    const qc = `qc-${l}`;
    nodes.push(node(qc, "inspection", 300 + stages.length * 600, y, { name: `Контроль ${L}`, cycle_s: 60, equipment: eqList(`КТ${L}`, 2, false) }));
    edges.push(edge(prev, qc));
    edges.push(edge(qc, out));
  }
  nodes.push(node(out, "sink", 300 + stages.length * 600 + 360, totalH / 2 - rowH / 2, { name: "Общий склад ГП" }));
  return { name: `Завод: ${lines} линий`, nodes, edges };
}

export function autoLayout(nodes: PlantNode[], edges: PlantEdge[]): PlantNode[] {
  const preds = new Map<string, string[]>();
  nodes.forEach((n) => preds.set(n.id, []));
  edges.forEach((e) => preds.get(e.target)?.push(e.source));
  const layer = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (layer.has(id)) return layer.get(id) as number;
    if (stack.has(id)) return 0;
    stack.add(id);
    const p = preds.get(id) ?? [];
    const v = p.length ? Math.max(...p.map((x) => visit(x, stack))) + 1 : 0;
    stack.delete(id);
    layer.set(id, v);
    return v;
  };
  nodes.forEach((n) => visit(n.id, new Set()));
  const byLayer = new Map<number, PlantNode[]>();
  nodes.forEach((n) => {
    const l = layer.get(n.id) ?? 0;
    byLayer.set(l, [...(byLayer.get(l) ?? []), n]);
  });
  const pos = new Map<string, { x: number; y: number }>();
  [...byLayer.keys()]
    .sort((a, b) => a - b)
    .forEach((l) => {
      const list = byLayer.get(l) as PlantNode[];
      list.sort((a, b) => avgY(a.id) - avgY(b.id));
      list.forEach((n, i) => pos.set(n.id, { x: l * 320, y: i * 220 }));
    });
  function avgY(id: string) {
    const p = (preds.get(id) ?? []).map((x) => pos.get(x)?.y ?? 0);
    return p.length ? p.reduce((s, v) => s + v, 0) / p.length : 0;
  }
  return nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position }));
}

export function validate(p: Project): string[] {
  const out: string[] = [];
  const kinds = p.nodes.map((n) => n.data.kind);
  if (!kinds.includes("source")) out.push("Нет ни одного склада/поставки — изделиям неоткуда появиться.");
  if (!kinds.includes("sink")) out.push("Нет склада готовой продукции — изделиям некуда уходить.");
  const hasIn = new Set(p.edges.map((e) => e.target));
  const hasOut = new Set(p.edges.map((e) => e.source));
  for (const n of p.nodes) {
    if (n.data.kind !== "source" && !hasIn.has(n.id)) out.push(`«${n.data.name}» ни с чем не связан на входе.`);
    if (n.data.kind !== "sink" && !hasOut.has(n.id)) out.push(`«${n.data.name}» ни с чем не связан на выходе.`);
    if (n.data.kind === "assembly" && p.edges.filter((e) => e.target === n.id).length < 2) out.push(`Сборке «${n.data.name}» нужно минимум два входа.`);
    if (n.data.kind === "inspection" && !p.edges.some((e) => e.source === n.id && e.sourceHandle !== "ng")) out.push(`У контроля «${n.data.name}» не подключён выход «годные».`);
  }
  return out;
}

export function canConnect(c: Connection | Edge, nodes: PlantNode[], edges: PlantEdge[], ignoreEdge?: string): boolean {
  if (!c.source || !c.target || c.source === c.target) return false;
  const a = nodes.find((n) => n.id === c.source);
  const b = nodes.find((n) => n.id === c.target);
  if (!a || !b) return false;
  if (a.data.kind === "sink" || b.data.kind === "source") return false;
  const h = c.sourceHandle ?? null;
  return !edges.some((e) => e.id !== ignoreEdge && e.source === c.source && e.target === c.target && (e.sourceHandle ?? null) === h);
}

export const ACCEPTS_INPUT: Kind[] = ["station", "assembly", "inspection", "buffer", "splitter", "transport", "sink"];
export const GIVES_OUTPUT: Kind[] = ["source", "station", "assembly", "inspection", "buffer", "splitter", "transport"];

export function countEquipment(p: Project): number {
  return p.nodes.reduce((s, n) => s + (n.data.equipment?.length ?? 0), 0);
}

export function allurShopTemplate(): Project {
  const nodes: PlantNode[] = [];
  const edges: PlantEdge[] = [];
  const add = (id: string, key: ProcKey, x: number, y: number, name: string, extra: Partial<NodeParams> = {}, prefix?: string) => {
    const d = procDefaults(key, name);
    const eq = PROCS[key].eq.length ? procEquipment(key, prefix ?? `${PROCS[key].prefix}${id.endsWith("A") ? "А" : id.endsWith("B") ? "Б" : ""}`) : d.equipment;
    const zone = extra.zone ?? d.zone;
    nodes.push({
      id,
      type: d.kind,
      position: { x, y },
      data: { ...d, ...(eq ? { equipment: eq } : {}), ...extra, cell_code: `${zoneCode(zone)}-${String(nodes.length + 1).padStart(3, "0")}`, kind: d.kind },
    });
  };
  const link = (a: string, b: string, h?: "ok" | "ng") => edges.push(edge(a, b, h));
  const X = (c: number) => c * 330;

  add("kitA", "kit_store", X(0), 0, "Склад CKD · линия А (JAC, Chevrolet)", { rate_per_hour: 16, area: "WH_IN" });
  add("kitB", "kit_store", X(0), 280, "Склад CKD · линия Б (Kia, Hyundai)", { rate_per_hour: 18 });
  add("logA", "logistics", X(1), 20, "Подача комплектов А");
  add("logB", "logistics", X(1), 300, "Подача комплектов Б");
  add("jigA", "jig", X(2), 0, "Кондуктор основания А", { cycle_s: 200 });
  add("jigB", "jig", X(2), 280, "Кондуктор основания Б", { cycle_s: 190 });
  add("robA", "robot_cell", X(3), 0, "Робот-ячейка сварки А", { cycle_s: 195 });
  add("robB", "robot_cell", X(3), 280, "Робот-ячейка сварки Б", { cycle_s: 180 });
  add("sideA", "weld_line", X(4), 0, "Сварка боковин и крыши А", { cycle_s: 380, area: "WELD", defect_pct: 1.7 });
  add("sideB", "weld_line", X(4), 280, "Сварка боковин и крыши Б", { cycle_s: 360 });
  add("geo", "geometry", X(5), 140, "Контроль геометрии кузова");
  add("rwBiw", "rework", X(5), 440, "Доработка кузова в белом", { zone: "Сварка" });
  add("bufBiw", "buffer", X(6), 170, "Буфер кузовов в белом", { capacity: 12, zone: "Сварка" });
  add("ovh", "overhead", X(7), 170, "Подвесной конвейер в окраску", { capacity: 16, travel_s: 360 });
  ["kitA>logA", "logA>jigA", "jigA>robA", "robA>sideA", "sideA>geo", "kitB>logB", "logB>jigB", "jigB>robB", "robB>sideB", "sideB>geo", "rwBiw>geo", "bufBiw>ovh"].forEach((p) => {
    const [a, b] = p.split(">");
    link(a, b);
  });
  link("geo", "bufBiw", "ok");
  link("geo", "rwBiw", "ng");

  const P = 760;
  add("pre", "pretreat", X(0), P, "Подготовка поверхности и фосфатирование");
  add("ktl", "pretreat", X(1), P, "КТЛ-грунтование (катафорез)", { cycle_s: 170 }, "КТЛ");
  add("ktlOven", "oven", X(2), P, "Печь сушки КТЛ", {}, "ПЧ1");
  add("seal", "sealer", X(3), P, "Герметизация швов и антигравий");
  add("booth", "paint_booth", X(4), P, "Окрасочная камера: база и лак", { area: "PAINT" });
  add("oven", "oven", X(5), P, "Печь сушки ЛКП", {}, "ПЧ2");
  add("pqc", "paint_qc", X(6), P, "Контроль ЛКП (световой туннель)");
  add("polish", "rework", X(6), P + 300, "Полировка и доработка ЛКП", { zone: "Окраска", cycle_s: 480 });
  add("pbs", "buffer", X(7), P + 30, "Буфер окрашенных кузовов (PBS)", { capacity: 20, zone: "Окраска" });
  add("split", "splitter", X(8), P + 30, "Распределение по линиям сборки", { zone: "Сборка" });
  ["ovh>pre", "pre>ktl", "ktl>ktlOven", "ktlOven>seal", "seal>booth", "booth>oven", "oven>pqc", "polish>pqc", "pbs>split"].forEach((p) => {
    const [a, b] = p.split(">");
    link(a, b);
  });
  link("pqc", "pbs", "ok");
  link("pqc", "polish", "ng");

  const A = 1460;
  const B = 1740;
  add("floorA", "floor_conv", X(0), A + 20, "Напольный конвейер А");
  add("floorB", "floor_conv", X(0), B + 20, "Напольный конвейер Б");
  add("trimA", "trim", X(1), A, "Посты сборки салона А (trim)", { cycle_s: 380 });
  add("trimB", "trim", X(1), B, "Посты сборки салона Б (trim)", { cycle_s: 360 });
  add("ptStore", "kit_store", X(1), B + 300, "Склад силовых агрегатов и шасси", { rate_per_hour: 34, zone: "Логистика" });
  add("ptSplit", "splitter", X(2), B + 320, "Подача шасси на линии", { zone: "Сборка" });
  add("marryA", "marriage", X(3), A, "Стыковка кузова и шасси А", { cycle_s: 190 });
  add("marryB", "marriage", X(3), B, "Стыковка кузова и шасси Б", { cycle_s: 180 });
  add("finalA", "final", X(4), A, "Финальная сборка А", { cycle_s: 560, area: "ASSY" });
  add("finalB", "final", X(4), B, "Финальная сборка Б", { cycle_s: 540 });
  add("fluidA", "fluids", X(5), A, "Заливка жидкостей А");
  add("fluidB", "fluids", X(5), B, "Заливка жидкостей Б");
  add("align", "alignment", X(6), A + 140, "Стенд развал-схождения и тормоза");
  add("water", "water_test", X(7), A + 140, "Камера дождевания", { parallel: 3 });
  add("track", "test_track", X(8), A + 140, "Тест-трек", { parallel: 5 });
  add("gate", "qc_gate", X(9), A + 140, "Контроль качества (ОТК)", { area: "QC", parallel: 2 });
  add("rwFinal", "rework", X(8), B + 200, "Участок доработки");
  add("fg", "fg_store", X(10), A + 170, "Склад готовых автомобилей", { area: "WH_OUT" });
  ["split>floorA", "split>floorB", "floorA>trimA", "floorB>trimB", "trimA>marryA", "trimB>marryB", "ptStore>ptSplit", "ptSplit>marryA", "ptSplit>marryB", "marryA>finalA", "marryB>finalB", "finalA>fluidA", "finalB>fluidB", "fluidA>align", "fluidB>align", "rwFinal>gate"].forEach((p) => {
    const [a, b] = p.split(">");
    link(a, b);
  });
  link("align", "water", "ok");
  link("align", "rwFinal", "ng");
  link("water", "track", "ok");
  link("water", "rwFinal", "ng");
  link("track", "gate", "ok");
  link("track", "rwFinal", "ng");
  link("gate", "fg", "ok");
  link("gate", "rwFinal", "ng");
  return { name: "Аллюр · большой цех", nodes, edges };
}
