import { clsx } from "clsx";
import { Maximize2, Minus, Plus } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { num } from "@/shared/lib/format";
import type { NodeStats, SimStats } from "./engine";
import { type EqType, guessEqType, type Kind, type PlantEdge, type PlantNode } from "./model";
import { STATE } from "./nodes";
import { useStatsStore } from "./store";

type Pt = [number, number];
const S = (x: number, y: number, z = 0): Pt => [x - 0.62 * y, 0.18 * x + 0.36 * y - z];
const pts = (l: Pt[]) => l.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");

interface Faces {
  top: string;
  front: string;
  right: string;
}

function box(x: number, y: number, z: number, w: number, d: number, h: number): Faces {
  return {
    top: pts([S(x, y, z + h), S(x + w, y, z + h), S(x + w, y + d, z + h), S(x, y + d, z + h)]),
    front: pts([S(x, y + d, z + h), S(x + w, y + d, z + h), S(x + w, y + d, z), S(x, y + d, z)]),
    right: pts([S(x + w, y, z + h), S(x + w, y + d, z + h), S(x + w, y + d, z), S(x + w, y, z)]),
  };
}

function disc(cx: number, cy: number, z: number, r: number, n = 18): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return S(cx + r * Math.cos(t), cy + r * Math.sin(t), z);
  });
}

function cylinder(cx: number, cy: number, z: number, r: number, h: number) {
  const b = disc(cx, cy, z, r);
  const t = disc(cx, cy, z + h, r);
  let lo = 0;
  let hi = 0;
  b.forEach((p, i) => {
    if (p[0] < b[lo][0]) lo = i;
    if (p[0] > b[hi][0]) hi = i;
  });
  const front: Pt[] = [];
  const a1: Pt[] = [];
  for (let i = lo; ; i = (i + 1) % b.length) {
    a1.push(b[i]);
    if (i === hi) break;
  }
  const a2: Pt[] = [];
  for (let i = lo; ; i = (i - 1 + b.length) % b.length) {
    a2.push(b[i]);
    if (i === hi) break;
  }
  const avg = (l: Pt[]) => l.reduce((s, p) => s + p[1], 0) / l.length;
  front.push(...(avg(a1) > avg(a2) ? a1 : a2));
  return { side: pts([t[lo], ...front, t[hi]]), top: pts(t) };
}

function shade(hex: string, k: number): string {
  const v = Number.parseInt(hex.slice(1), 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => Math.max(0, Math.min(255, Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k)))));
  return `rgb(${ch[0]} ${ch[1]} ${ch[2]})`;
}

const C = {
  floorTop: "#2b2020",
  floorFront: "#1c1414",
  floorRight: "#150f0f",
  grid: "rgb(255 255 255 / 0.035)",
  padTop: "#332626",
  convTop: "#151010",
  convFront: "#2a2121",
  convRight: "#201818",
  lane: "#e3241b",
  steel: "#6d6463",
  white: "#ece6e4",
  whiteShade: "#bfb5b2",
};

const TINT: Record<string, string> = {
  run: "rgb(23 160 93 / 0.16)",
  slow: "rgb(212 155 0 / 0.16)",
  starved: "rgb(154 163 181 / 0.09)",
  blocked: "rgb(212 155 0 / 0.18)",
  down: "rgb(224 59 59 / 0.26)",
  idle: "rgb(255 255 255 / 0.03)",
};

const BEACON = { run: "#22c573", idle: "#8f8686", down: "#ff3b30" };
const ITEM_COLORS = ["#F2F3F0", "#B8BDC3", "#6C727A", "#A9242C", "#234E86", "#d9b26a"];

const PROCESS: Kind[] = ["station", "assembly", "inspection"];
const CW = 22;
const CH = 10;

interface EqSlot {
  code: string;
  type: EqType;
  x: number;
  y: number;
  w: number;
  d: number;
  beacon: Pt;
}

interface Cell {
  id: string;
  kind: Kind;
  name: string;
  x: number;
  y: number;
  w: number;
  d: number;
  cy: number;
  eq: EqSlot[];
  capacity: number;
  stockCap: number;
}

interface Route {
  id: string;
  key: string;
  ng: boolean;
  world: Pt[];
  path: string;
  len: number;
}

interface Geo {
  cells: Cell[];
  routes: Route[];
  minX: number;
  minY: number;
  W: number;
  H: number;
  floor: { x0: number; y0: number; x1: number; y1: number };
}

const EQ_H: Record<EqType, number> = { robot: 40, press: 50, booth: 38, oven: 32, conveyor: 13, jig: 34, tool: 22, lift: 36, tester: 32, tank: 36, machine: 30 };

function buildGeo(nodes: PlantNode[], edges: PlantEdge[]): Geo {
  const cells: Cell[] = nodes.map((n) => {
    const kind = n.data.kind;
    const wide = PROCESS.includes(kind);
    const w = Math.max(120, n.measured?.width ?? (wide ? 250 : 200));
    const d = Math.min(200, Math.max(90, n.measured?.height ?? (wide ? 150 : 110)));
    const x = n.position.x;
    const y = n.position.y;
    const cy = y + d * (wide ? 0.7 : 0.6);
    const list = n.data.equipment ?? [];
    const eq: EqSlot[] = [];
    if (wide && list.length) {
      const cols = Math.max(1, Math.min(list.length, Math.floor((w - 16) / 30)));
      const rows = Math.ceil(list.length / cols);
      const zoneD = cy - CW / 2 - 6 - (y + 8);
      const sw = (w - 16) / cols;
      const sd = Math.max(14, zoneD / rows);
      list.forEach((e, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const type = e.type ?? guessEqType(e.code, kind);
        const ex = x + 8 + col * sw + 2;
        const ey = y + 8 + row * sd + 1;
        const ew = sw - 4;
        const ed = sd - 2;
        const scale = Math.min(1, sd / 34);
        eq.push({ code: e.code, type, x: ex, y: ey, w: ew, d: ed, beacon: S(ex + ew - 3, ey + 3, EQ_H[type] * scale + 7) });
      });
    }
    return { id: n.id, kind, name: n.data.name, x, y, w, d, cy, eq, capacity: n.data.capacity ?? 6, stockCap: n.data.stock_cap ?? 60 };
  });
  const byId = new Map(cells.map((c) => [c.id, c]));
  const routes: Route[] = [];
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b || a === b) continue;
    const ng = e.sourceHandle === "ng";
    const ax = a.x + a.w;
    const ay = ng ? a.y + a.d - 8 : a.cy;
    const bx = b.x;
    const by = b.cy;
    let world: Pt[];
    if (bx >= ax + 30) {
      const mx = (ax + bx) / 2;
      world = [
        [ax, ay],
        [mx, ay],
        [mx, by],
        [bx, by],
      ];
    } else {
      const ly = Math.max(a.y + a.d, b.y + b.d) + 34;
      world = [
        [ax, ay],
        [ax + 26, ay],
        [ax + 26, ly],
        [bx - 26, ly],
        [bx - 26, by],
        [bx, by],
      ];
    }
    world = world.filter((p, i) => i === 0 || p[0] !== world[i - 1][0] || p[1] !== world[i - 1][1]);
    const screen = world.map(([x, y]) => S(x, y, CH + 1));
    let len = 0;
    for (let i = 1; i < screen.length; i++) len += Math.hypot(screen[i][0] - screen[i - 1][0], screen[i][1] - screen[i - 1][1]);
    routes.push({ id: e.id, key: `${e.source}>${e.target}`, ng, world, path: `M${screen.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L")}`, len });
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  cells.forEach((c) => {
    grow(c.x, c.y);
    grow(c.x + c.w, c.y + c.d);
  });
  routes.forEach((r) => r.world.forEach(([x, y]) => grow(x, y)));
  if (!Number.isFinite(x0)) {
    x0 = 0;
    y0 = 0;
    x1 = 400;
    y1 = 300;
  }
  const floor = { x0: x0 - 60, y0: y0 - 60, x1: x1 + 60, y1: y1 + 60 };
  const corners = [S(floor.x0, floor.y0, 140), S(floor.x1, floor.y0, 140), S(floor.x0, floor.y1, -14), S(floor.x1, floor.y1, -14), S(floor.x0, floor.y1, 140)];
  const minX = Math.min(...corners.map((p) => p[0])) - 20;
  const maxX = Math.max(...corners.map((p) => p[0])) + 20;
  const minY = Math.min(...corners.map((p) => p[1])) - 20;
  const maxY = Math.max(...corners.map((p) => p[1])) + 20;
  return { cells, routes, minX, minY, W: maxX - minX, H: maxY - minY, floor };
}

function geoKey(nodes: PlantNode[], edges: PlantEdge[]): string {
  return (
    nodes
      .map((n) => `${n.id}:${n.data.kind}:${Math.round(n.position.x)},${Math.round(n.position.y)}:${n.measured?.width ?? 0}x${n.measured?.height ?? 0}:${n.data.name}:${(n.data.equipment ?? []).map((e) => `${e.code}/${e.type ?? ""}`).join(",")}`)
      .join("|") +
    "#" +
    edges.map((e) => `${e.source}>${e.target}:${e.sourceHandle ?? ""}`).join("|")
  );
}

function Box({ b, top, front, right, opacity, stroke }: { b: Faces; top: string; front: string; right: string; opacity?: number; stroke?: string }) {
  return (
    <g opacity={opacity}>
      <polygon points={b.front} fill={front} stroke={stroke} strokeWidth={stroke ? 0.7 : 0} />
      <polygon points={b.right} fill={right} stroke={stroke} strokeWidth={stroke ? 0.7 : 0} />
      <polygon points={b.top} fill={top} stroke={stroke} strokeWidth={stroke ? 0.7 : 0} />
    </g>
  );
}

const tone = (hex: string) => ({ top: shade(hex, 0.2), front: hex, right: shade(hex, -0.28) });

function Equipment({ s }: { s: EqSlot }) {
  const { x, y, w, d } = s;
  const k = Math.min(1, d / 34, w / 30);
  const h = EQ_H[s.type] * k;
  const cx = x + w / 2;
  const cy = y + d / 2;
  const shadow = <polygon points={pts([S(x, y, 0.4), S(x + w, y, 0.4), S(x + w, y + d, 0.4), S(x, y + d, 0.4)])} fill="rgb(0 0 0 / 0.28)" />;
  switch (s.type) {
    case "robot": {
      const r = Math.min(w, d) * 0.34;
      const base = cylinder(cx, cy, 0, r, 6 * k);
      const turret = cylinder(cx, cy, 6 * k, r * 0.7, 8 * k);
      const j1 = S(cx, cy, 14 * k);
      const j2 = S(cx + r * 0.6, cy + d * 0.25, h);
      const j3 = S(cx + r * 1.4, cy + d * 0.55, h * 0.62);
      return (
        <g>
          {shadow}
          <polygon points={base.side} fill="#3a3131" />
          <polygon points={base.top} fill="#4c4141" />
          <polygon points={turret.side} fill={C.whiteShade} />
          <polygon points={turret.top} fill={C.white} />
          <polyline points={pts([j1, j2, j3])} fill="none" stroke="#d7cfcc" strokeWidth={4.2 * k} strokeLinecap="round" strokeLinejoin="round" />
          <polyline points={pts([j1, j2, j3])} fill="none" stroke="#f4efed" strokeWidth={2 * k} strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={j3[0]} cy={j3[1]} r={2.4 * k} fill="#e3241b" />
        </g>
      );
    }
    case "press": {
      const t = tone("#5d5655");
      return (
        <g>
          {shadow}
          <Box b={box(x + w * 0.1, y + d * 0.1, 0, w * 0.8, d * 0.8, h * 0.35)} {...t} />
          <Box b={box(x + w * 0.1, y + d * 0.1, h * 0.35, w * 0.12, d * 0.8, h * 0.45)} {...tone("#7a7271")} />
          <Box b={box(x + w * 0.78, y + d * 0.1, h * 0.35, w * 0.12, d * 0.8, h * 0.45)} {...tone("#7a7271")} />
          <Box b={box(x + w * 0.06, y + d * 0.06, h * 0.8, w * 0.88, d * 0.88, h * 0.2)} {...tone("#a33a33")} />
        </g>
      );
    }
    case "booth":
    case "oven": {
      const oven = s.type === "oven";
      const glass = oven ? "rgb(120 55 30 / 0.55)" : "rgb(255 255 255 / 0.08)";
      return (
        <g>
          {shadow}
          <Box b={box(x, y, 0, w, d, h)} top={oven ? "#5a3a2e" : "rgb(255 255 255 / 0.12)"} front={glass} right={oven ? "rgb(70 32 20 / 0.7)" : "rgb(255 255 255 / 0.05)"} stroke="rgb(255 255 255 / 0.22)" />
          <polygon points={pts([S(x, y + d, h - 4 * k), S(x + w, y + d, h - 4 * k), S(x + w, y + d, h - 8 * k), S(x, y + d, h - 8 * k)])} fill={oven ? "#ff8a3d" : "#e3241b"} opacity={0.9} />
          {oven &&
            [0.3, 0.6].map((f) => <line key={f} x1={S(x + 3, y + d, h * f)[0]} y1={S(x + 3, y + d, h * f)[1]} x2={S(x + w - 3, y + d, h * f)[0]} y2={S(x + w - 3, y + d, h * f)[1]} stroke="#ff8a3d" strokeWidth={1.4} opacity={0.75} />)}
        </g>
      );
    }
    case "conveyor": {
      const g = cylinder(cx, cy, h, Math.min(w, d) * 0.22, 2);
      return (
        <g>
          {shadow}
          <Box b={box(x + w * 0.15, y + d * 0.2, 0, w * 0.7, d * 0.6, h)} {...tone("#4a4140")} />
          <polygon points={g.side} fill="#2c2525" />
          <polygon points={g.top} fill="#e3241b" />
        </g>
      );
    }
    case "jig":
    case "lift": {
      const post = tone("#8d8382");
      return (
        <g>
          {shadow}
          <Box b={box(x + 2, y + 2, 0, 4 * k, 4 * k, h)} {...post} />
          <Box b={box(x + w - 6, y + 2, 0, 4 * k, 4 * k, h)} {...post} />
          <Box b={box(x + 2, y + d - 6, 0, 4 * k, 4 * k, h)} {...post} />
          <Box b={box(x + w - 6, y + d - 6, 0, 4 * k, 4 * k, h)} {...post} />
          {s.type === "jig" ? (
            <Box b={box(x + 2, y + 2, h - 3 * k, w - 4, d - 4, 3 * k)} {...tone("#c9a227")} />
          ) : (
            <Box b={box(x + 4, y + 4, h * 0.45, w - 8, d - 8, 2.5 * k)} {...tone("#d49b00")} />
          )}
        </g>
      );
    }
    case "tool":
      return (
        <g>
          {shadow}
          <Box b={box(cx - 3, cy - 3, 0, 6, 6, h)} {...tone("#6d6463")} />
          <Box b={box(cx - 2, cy - 7, h - 3, 4, 10, 3)} {...tone("#3b6fd1")} />
        </g>
      );
    case "tester": {
      return (
        <g>
          {shadow}
          <Box b={box(x + 2, y + 2, 0, w * 0.18, d - 4, h)} {...tone("#5e6670")} />
          <Box b={box(x + w * 0.82 - 2, y + 2, 0, w * 0.18, d - 4, h)} {...tone("#5e6670")} />
          <Box b={box(x + 2, y + 2, h, w - 4, d - 4, 3 * k)} {...tone("#7c8590")} />
          <polygon points={pts([S(x + w * 0.2, y + d - 2, h - 2), S(x + w * 0.8, y + d - 2, h - 2), S(x + w * 0.8, y + d - 2, h - 6), S(x + w * 0.2, y + d - 2, h - 6)])} fill="#7fd1ff" opacity={0.6} />
        </g>
      );
    }
    case "tank": {
      const t = cylinder(cx, cy, 0, Math.min(w, d) * 0.36, h);
      return (
        <g>
          {shadow}
          <polygon points={t.side} fill="#6b5e5c" />
          <polygon points={t.top} fill="#a69c9a" />
        </g>
      );
    }
    default: {
      return (
        <g>
          {shadow}
          <Box b={box(x + 2, y + 2, 0, w - 4, d - 4, h)} {...tone("#8a8382")} />
          <polygon points={pts([S(x + w * 0.2, y + d - 2, h * 0.85), S(x + w * 0.65, y + d - 2, h * 0.85), S(x + w * 0.65, y + d - 2, h * 0.35), S(x + w * 0.2, y + d - 2, h * 0.35)])} fill="#2a3440" opacity={0.85} />
          <Box b={box(x + w - 7, y + d - 5, h * 0.4, 5, 3, h * 0.5)} {...tone("#3a3333")} />
        </g>
      );
    }
  }
}

function Belt({ world }: { world: Pt[] }) {
  const out: ReactNode[] = [];
  for (let i = 1; i < world.length; i++) {
    const [ax, ay] = world[i - 1];
    const [bx, by] = world[i];
    const hx = ay === by;
    const x = Math.min(ax, bx) - (hx ? 0 : CW / 2);
    const y = Math.min(ay, by) - (hx ? CW / 2 : 0);
    const w = hx ? Math.abs(bx - ax) + (i < world.length - 1 ? CW / 2 : 0) : CW;
    const d = hx ? CW : Math.abs(by - ay) + CW / 2;
    out.push(<Box key={i} b={box(x, y, 0, Math.max(w, 1), Math.max(d, 1), CH)} top={C.convTop} front={C.convFront} right={C.convRight} />);
  }
  return <g>{out}</g>;
}

function FloorLayer({ geo }: { geo: Geo }) {
  const f = geo.floor;
  const slab = box(f.x0, f.y0, -10, f.x1 - f.x0, f.y1 - f.y0, 10);
  const lines: ReactNode[] = [];
  const step = 80;
  for (let x = Math.ceil(f.x0 / step) * step; x <= f.x1; x += step) {
    const a = S(x, f.y0);
    const b = S(x, f.y1);
    lines.push(<line key={`x${x}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={C.grid} />);
  }
  for (let y = Math.ceil(f.y0 / step) * step; y <= f.y1; y += step) {
    const a = S(f.x0, y);
    const b = S(f.x1, y);
    lines.push(<line key={`y${y}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={C.grid} />);
  }
  return (
    <g>
      <Box b={slab} top={C.floorTop} front={C.floorFront} right={C.floorRight} />
      {lines}
      {geo.cells.map((c) => (
        <polygon key={c.id} points={pts([S(c.x, c.y, 0.3), S(c.x + c.w, c.y, 0.3), S(c.x + c.w, c.y + c.d, 0.3), S(c.x, c.y + c.d, 0.3)])} fill={C.padTop} />
      ))}
    </g>
  );
}

function Racks({ c }: { c: Cell }) {
  const out: ReactNode[] = [];
  const rows = c.kind === "source" ? 2 : 1;
  for (let r = 0; r < rows; r++) {
    const ry = c.y + 10 + r * ((c.d - 20) / rows);
    const rd = (c.d - 20) / rows - 12;
    out.push(<Box key={`b${r}`} b={box(c.x + 10, ry, 0, c.w * 0.62, rd, 2)} {...tone("#3b3232")} />);
    for (let lvl = 1; lvl < 3; lvl++) out.push(<Box key={`s${r}${lvl}`} b={box(c.x + 10, ry, lvl * 14, c.w * 0.62, rd, 1.5)} {...tone("#4b3f3e")} />);
    [0, c.w * 0.62 - 4].forEach((dx) => out.push(<Box key={`p${r}${dx}`} b={box(c.x + 10 + dx, ry + rd - 4, 0, 4, 4, 40)} {...tone("#8d8382")} />));
  }
  return <g>{out}</g>;
}

function CellStatic({ c }: { c: Cell }) {
  const parts: ReactNode[] = [];
  if (PROCESS.includes(c.kind)) {
    parts.push(<Belt key="belt" world={[[c.x + 4, c.cy], [c.x + c.w - 4, c.cy]]} />);
    c.eq.forEach((s) => parts.push(<Equipment key={s.code} s={s} />));
    if (c.kind === "inspection") {
      parts.push(<Box key="gate-l" b={box(c.x + c.w * 0.55, c.cy - CW / 2 - 5, 0, 4, 4, 30)} {...tone("#5e6670")} />);
    }
  } else if (c.kind === "source") {
    parts.push(<Racks key="r" c={c} />);
    parts.push(<Belt key="belt" world={[[c.x + c.w * 0.7, c.cy], [c.x + c.w, c.cy]]} />);
  } else if (c.kind === "buffer") {
    const len = c.w - 20;
    parts.push(<Box key="bed" b={box(c.x + 10, c.cy - CW / 2 - 2, 0, len, CW + 4, 4)} {...tone("#3e3434")} />);
    for (let i = 0; i < 12; i++) {
      const x = c.x + 14 + (i * (len - 8)) / 11;
      const a = S(x, c.cy - CW / 2, 4.5);
      const b = S(x, c.cy + CW / 2, 4.5);
      parts.push(<line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#9a8f8d" strokeWidth={1.3} />);
    }
  } else if (c.kind === "splitter") {
    const t = cylinder(c.x + c.w / 2, c.cy, 0, Math.min(c.w, c.d) * 0.22, 8);
    parts.push(<polygon key="s" points={t.side} fill="#2a2121" />, <polygon key="t" points={t.top} fill="#3a2e2e" stroke="#e3241b" strokeWidth={1} strokeDasharray="5 4" />);
    parts.push(<Belt key="in" world={[[c.x, c.cy], [c.x + c.w / 2 - 20, c.cy]]} />);
    parts.push(<Belt key="out" world={[[c.x + c.w / 2 + 20, c.cy], [c.x + c.w, c.cy]]} />);
  } else if (c.kind === "transport") {
    for (let x = c.x + 16; x < c.x + c.w - 8; x += 46) parts.push(<Box key={`p${x}`} b={box(x, c.cy - 3, 0, 5, 5, 14)} {...tone("#6d6463")} />);
    parts.push(
      <g key="belt" transform="translate(0 -14)">
        <Belt world={[[c.x, c.cy], [c.x + c.w, c.cy]]} />
      </g>,
    );
  } else if (c.kind === "sink") {
    for (let r = 0; r < 4; r++) {
      const y = c.y + 12 + r * ((c.d - 24) / 4);
      const a = S(c.x + 30, y, 0.5);
      const b = S(c.x + c.w - 8, y, 0.5);
      parts.push(<line key={`l${r}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="rgb(255 255 255 / 0.14)" />);
    }
    parts.push(<Belt key="belt" world={[[c.x, c.cy], [c.x + 26, c.cy]]} />);
  }
  return <g>{parts}</g>;
}

function StaticPlant({ geo }: { geo: Geo }) {
  const cells = [...geo.cells].sort((a, b) => a.y + a.d - (b.y + b.d) || a.x - b.x);
  return (
    <g>
      {geo.routes.map((r) => (
        <g key={r.id}>
          <Belt world={r.world} />
          <path d={r.path} fill="none" stroke={r.ng ? "#e08a1e" : C.lane} strokeWidth={1.2} strokeDasharray="10 7" opacity={0.65} />
        </g>
      ))}
      {cells.map((c) => (
        <CellStatic key={c.id} c={c} />
      ))}
    </g>
  );
}

function useStats(): SimStats | null {
  const s = useStatsStore();
  return useSyncExternalStore(s.subscribe, s.get);
}

function Item({ color }: { color: string }) {
  const b = box(-7, -5, 0, 14, 10, 7);
  return <Box b={b} top={shade(color, 0.15)} front={color} right={shade(color, -0.3)} />;
}

function liveParts(geo: Geo, stats: SimStats | null, selected?: string | null): { overlays: ReactNode[]; items: ReactNode[]; beacons: ReactNode[] } {
  const items: ReactNode[] = [];
  const perRoute = geo.routes.length > 40 ? 1 : geo.routes.length > 16 ? 3 : 6;
  for (const r of geo.routes) {
    if (!stats?.flowing.has(r.key)) continue;
    const n = Math.max(1, Math.min(perRoute, Math.round(r.len / 110)));
    const dur = Math.max(1.6, r.len / 70);
    for (let i = 0; i < n; i++) {
      items.push(
        <g key={`${r.id}-${i}`}>
          <Item color={r.ng ? "#e08a1e" : ITEM_COLORS[(i + r.id.length) % ITEM_COLORS.length]} />
          <animateMotion dur={`${dur.toFixed(2)}s`} begin={`-${((dur * i) / n).toFixed(2)}s`} repeatCount="indefinite" path={r.path} />
        </g>,
      );
    }
  }
  const overlays: ReactNode[] = [];
  const beacons: ReactNode[] = [];
  for (const c of geo.cells) {
    const st = stats?.nodes[c.id];
    const state = st?.state ?? "idle";
    const outline = pts([S(c.x, c.y, 0.6), S(c.x + c.w, c.y, 0.6), S(c.x + c.w, c.y + c.d, 0.6), S(c.x, c.y + c.d, 0.6)]);
    const sel = selected === c.id;
    overlays.push(
      <polygon
        key={`o${c.id}`}
        points={outline}
        fill={TINT[state]}
        stroke={sel ? "#ff5a4f" : state === "down" ? "var(--color-down)" : "rgb(255 255 255 / 0.12)"}
        strokeWidth={sel ? 2.4 : state === "down" ? 1.6 : 1}
        strokeDasharray={sel ? undefined : "9 6"}
      />,
    );
    if (st && geo.cells.length <= 40 && PROCESS.includes(c.kind) && (state === "run" || state === "slow")) {
      const a = S(c.x + 10, c.cy, CH + 1);
      const b = S(c.x + c.w - 10, c.cy, CH + 1);
      items.push(
        <g key={`w${c.id}`}>
          <Item color={ITEM_COLORS[c.id.length % ITEM_COLORS.length]} />
          <animateMotion dur={state === "slow" ? "5s" : "3.2s"} repeatCount="indefinite" path={`M${a[0]} ${a[1]} L${b[0]} ${b[1]}`} />
        </g>,
      );
    }
    if (c.kind === "source") {
      const cap = Math.max(1, c.stockCap);
      const n = Math.round((Math.min(st?.stock ?? 0, cap) / cap) * 16);
      for (let i = 0; i < n; i++) {
        const r = i < 8 ? 0 : 1;
        const k = i % 8;
        const col = k % 4;
        const lvl = Math.floor(k / 4);
        const rd = (c.d - 20) / 2 - 12;
        const bx = c.x + 13 + col * ((c.w * 0.62 - 6) / 4);
        const by = c.y + 13 + r * ((c.d - 20) / 2);
        const cc = st?.supplyPaused ? "#8a6a2a" : "#b98a4a";
        beacons.push(<Box key={`k${c.id}${i}`} b={box(bx, by, lvl * 14 + 2, (c.w * 0.62 - 6) / 4 - 4, rd - 6, 10)} {...tone(cc)} top={shade(cc, 0.2)} />);
      }
    } else if (c.kind === "buffer" || c.kind === "splitter") {
      const n = Math.min(st?.stock ?? 0, 12);
      const len = c.kind === "buffer" ? c.w - 28 : c.w * 0.3;
      const x0 = c.kind === "buffer" ? c.x + 14 : c.x + c.w * 0.35;
      for (let i = 0; i < n; i++) {
        const p = S(x0 + 7 + (i * len) / Math.max(12, n), c.cy, 5);
        beacons.push(
          <g key={`b${c.id}${i}`} transform={`translate(${p[0]} ${p[1]})`}>
            <Item color={ITEM_COLORS[i % ITEM_COLORS.length]} />
          </g>,
        );
      }
    } else if (c.kind === "transport" && st?.transit) {
      const a = S(c.x + 8, c.cy, CH + 15);
      const b = S(c.x + c.w - 8, c.cy, CH + 15);
      const n = Math.min(st.transit, 10);
      const dur = Math.max(2.5, c.w / 60);
      for (let i = 0; i < n; i++) {
        items.push(
          <g key={`t${c.id}${i}`}>
            <Item color={ITEM_COLORS[i % ITEM_COLORS.length]} />
            <animateMotion dur={`${dur}s`} begin={`-${((dur * i) / n).toFixed(2)}s`} repeatCount="indefinite" path={`M${a[0]} ${a[1]} L${b[0]} ${b[1]}`} />
          </g>,
        );
      }
    } else if (c.kind === "sink" && st) {
      const n = Math.min(st.produced, 24);
      const cols = Math.max(1, Math.floor((c.w - 40) / 30));
      for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols) % 4;
        const p = S(c.x + 40 + col * 30, c.y + 18 + row * ((c.d - 24) / 4), 0);
        beacons.push(
          <g key={`c${c.id}${i}`} transform={`translate(${p[0]} ${p[1]})`}>
            <Box b={box(0, 0, 0, 22, 12, 6)} {...tone(ITEM_COLORS[(i * 7) % ITEM_COLORS.length])} top={shade(ITEM_COLORS[(i * 7) % ITEM_COLORS.length], 0.15)} />
            <Box b={box(5, 1.5, 6, 11, 9, 4)} top="#2a3440" front="#1c242c" right="#151b21" />
          </g>,
        );
      }
    }
    if (st) {
      st.eq.forEach((e, i) => {
        const slot = c.eq[i];
        if (!slot) return;
        const [bx, by] = slot.beacon;
        const color = e.alarm ? "#ff9a3d" : BEACON[e.state];
        beacons.push(
          <g key={`e${c.id}${i}`}>
            {(e.state === "down" || e.alarm) && <circle cx={bx} cy={by} r={7} fill={color} opacity={0.25} className="animate-[blink_1s_ease-in-out_infinite]" />}
            <circle cx={bx} cy={by} r={2.6} fill={color} stroke="rgb(0 0 0 / 0.45)" strokeWidth={0.6} className={e.state === "down" ? "animate-[blink_1s_ease-in-out_infinite]" : undefined} />
          </g>,
        );
      });
    }
  }
  return { overlays, items, beacons };
}

function Label({ c, st, bottleneck, compact, onSelect, selected }: { c: Cell; st?: NodeStats; bottleneck: boolean; compact: boolean; onSelect?: (id: string) => void; selected: boolean }) {
  const state = st ? STATE[st.state] : null;
  const big =
    c.kind === "source" || c.kind === "buffer" || c.kind === "splitter" ? (st?.stock ?? null) : c.kind === "transport" ? (st?.transit ?? null) : st ? st.produced : null;
  return (
    <button
      type="button"
      onClick={() => onSelect?.(c.id)}
      className={clsx(
        "pointer-events-auto block max-w-[190px] min-w-[96px] rounded-[12px] border px-2.5 py-1.5 text-left text-white shadow-[0_10px_30px_-12px_rgb(0_0_0/0.8)] transition-transform hover:-translate-y-0.5",
        selected ? "border-[#ff5a4f] bg-[#3a1514]/95" : st?.state === "down" ? "border-down/70 bg-[#3a1514]/92" : bottleneck ? "border-brand/70 bg-[#2a1716]/92" : "border-white/12 bg-[#1f1616]/88",
      )}
    >
      <span className="flex items-center gap-1.5">
        <span className="display truncate text-[12.5px] leading-4 font-medium">{c.name}</span>
        {bottleneck && <span className="shrink-0 rounded-full bg-brand px-1 text-[9px] leading-3.5 font-bold">узкое</span>}
      </span>
      {!compact && (
        <span className="mt-0.5 flex items-center justify-between gap-2 text-[10.5px] font-semibold text-white/70">
          <span className="inline-flex items-center gap-1">
            <span className={clsx("size-1.5 rounded-full", st?.state === "down" && "animate-[blink_1s_ease-in-out_infinite]")} style={{ background: state?.color ?? "rgb(255 255 255 / 0.3)" }} />
            {state?.label ?? "Не запущен"}
          </span>
          {big != null && <span className="display num text-[15px] leading-none font-light text-white">{num(big)}</span>}
        </span>
      )}
    </button>
  );
}

function useViewport(ref: RefObject<HTMLDivElement | null>, W: number, H: number, fitKey: string) {
  const [view, setViewState] = useState({ k: 1, x: 0, y: 0 });
  const touched = useRef(false);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || !el.clientWidth) return;
    touched.current = false;
    const k = Math.min(el.clientWidth / W, el.clientHeight / H) * 0.97;
    setViewState({ k, x: (el.clientWidth - W * k) / 2, y: (el.clientHeight - H * k) / 2 });
  }, [ref, W, H]);
  const setView: typeof setViewState = (v) => {
    touched.current = true;
    setViewState(v);
  };
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    fitRef.current();
  }, [fitKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!touched.current) fitRef.current();
    });
    ro.observe(el);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setViewState((v) => {
        const k = Math.max(0.05, Math.min(4, v.k * Math.exp(-e.deltaY * 0.0016)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [ref]);
  const zoom = (f: number) => {
    const el = ref.current;
    if (!el) return;
    touched.current = true;
    const mx = el.clientWidth / 2;
    const my = el.clientHeight / 2;
    setViewState((v) => {
      const k = Math.max(0.05, Math.min(4, v.k * f));
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
    });
  };
  return { view, setView, fit, zoom };
}

export function Plant3D({
  nodes,
  edges,
  selected,
  onSelect,
  className,
}: {
  nodes: PlantNode[];
  edges: PlantEdge[];
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  className?: string;
}) {
  const dn = useDeferredValue(nodes);
  const de = useDeferredValue(edges);
  const key = geoKey(dn, de);
  const geo = useMemo(() => buildGeo(dn, de), [key]);
  const stats = useStats();
  const ref = useRef<HTMLDivElement>(null);
  const projectKey = `${dn.length ? dn[0].id : ""}:${dn.length > 40 ? Math.round(dn.length / 20) : dn.length}`;
  const { view, setView, fit, zoom } = useViewport(ref, geo.W, geo.H, projectKey);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const floor = useMemo(() => <FloorLayer geo={geo} />, [geo]);
  const plant = useMemo(() => <StaticPlant geo={geo} />, [geo]);
  const live = liveParts(geo, stats, selected);
  const compact = view.k < 0.55;
  const far = view.k < 0.3 && geo.cells.length > 24;
  const labelScale = far ? 0.85 / view.k : Math.min(1 / view.k, compact ? 2.4 : 1.6);
  const layer = { willChange: "transform" } as const;

  return (
    <div
      ref={ref}
      className={clsx("relative h-full w-full cursor-grab touch-none overflow-hidden bg-[#1d1313] select-none active:cursor-grabbing", className)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        if (!d.moved) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        d.moved = true;
        setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d?.moved) {
          const stop = (ev: Event) => {
            ev.stopPropagation();
            window.removeEventListener("click", stop, true);
          };
          window.addEventListener("click", stop, true);
          setTimeout(() => window.removeEventListener("click", stop, true), 0);
        }
      }}
      aria-label="3D-цех по схеме"
      role="img"
    >
      <div className="absolute top-0 left-0 origin-top-left will-change-transform" style={{ width: geo.W, height: geo.H, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg width={geo.W} height={geo.H} viewBox={`${geo.minX} ${geo.minY} ${geo.W} ${geo.H}`} className="absolute inset-0" style={layer} aria-hidden>
          {floor}
        </svg>
        <svg width={geo.W} height={geo.H} viewBox={`${geo.minX} ${geo.minY} ${geo.W} ${geo.H}`} className="absolute inset-0" style={layer} aria-hidden>
          {live.overlays}
        </svg>
        <svg width={geo.W} height={geo.H} viewBox={`${geo.minX} ${geo.minY} ${geo.W} ${geo.H}`} className="absolute inset-0" style={layer} aria-hidden>
          {plant}
        </svg>
        <svg width={geo.W} height={geo.H} viewBox={`${geo.minX} ${geo.minY} ${geo.W} ${geo.H}`} className="absolute inset-0" style={layer} aria-hidden>
          <g>{live.beacons}</g>
          <g>{live.items}</g>
          <g>
            {geo.cells.map((c) => (
              <polygon
                key={c.id}
                points={pts([S(c.x, c.y, 0), S(c.x + c.w, c.y, 0), S(c.x + c.w, c.y + c.d, 0), S(c.x, c.y + c.d, 0)])}
                fill="transparent"
                className="cursor-pointer"
                onClick={() => onSelect?.(c.id)}
              />
            ))}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0">
          {geo.cells.map((c) => {
            const st = stats?.nodes[c.id];
            if (far && selected !== c.id && stats?.bottleneck !== c.id && st?.state !== "down" && c.kind !== "sink") return null;
            const [sx, sy] = S(c.x + c.w * 0.5, c.y, 52);
            return (
              <div key={c.id} className="absolute origin-bottom" style={{ left: sx - geo.minX, top: sy - geo.minY, transform: `translate(-50%, -100%) scale(${labelScale})` }}>
                <Label c={c} st={st} bottleneck={stats?.bottleneck === c.id} compact={compact} onSelect={onSelect ?? undefined} selected={selected === c.id} />
              </div>
            );
          })}
        </div>
      </div>

      {nodes.length === 0 && <p className="absolute inset-0 grid place-items-center text-sm text-white/60">Добавьте узлы на схеме — здесь появится цех.</p>}

      <div className="absolute right-3 bottom-3 flex flex-col gap-1" onPointerDown={(e) => e.stopPropagation()}>
        {[
          { label: "Приблизить", icon: <Plus className="size-4" />, on: () => zoom(1.25) },
          { label: "Отдалить", icon: <Minus className="size-4" />, on: () => zoom(0.8) },
          { label: "Весь цех", icon: <Maximize2 className="size-4" />, on: fit },
        ].map((b) => (
          <button key={b.label} type="button" title={b.label} aria-label={b.label} onClick={b.on} className="grid size-9 place-items-center rounded-[10px] bg-white/10 text-white backdrop-blur-sm hover:bg-white/20">
            {b.icon}
          </button>
        ))}
      </div>
      <div className="pointer-events-none absolute top-3 right-3 hidden flex-wrap justify-end gap-x-3 gap-y-1 rounded-full bg-black/35 px-3 py-1.5 text-[11px] font-semibold text-white/75 sm:flex">
        {[
          ["Работает", BEACON.run],
          ["Ждёт", BEACON.idle],
          ["Тревога датчика", "#ff9a3d"],
          ["Отказ", BEACON.down],
        ].map(([l, c]) => (
          <span key={l} className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: c }} /> {l}
          </span>
        ))}
      </div>
    </div>
  );
}
