export const W = 1440;
export const D = 300;
export const C = 150;
export const CONV_W = 32;
export const CONV_H = 12;
export const PAD = 20;
const EX: [number, number] = [1, 0.18];
const EY: [number, number] = [-0.62, 0.36];
const OX = PAD + 0.62 * D;
const OY = 170;

export const VIEW_W = Math.round(W + 0.62 * D + PAD * 2);
export const VIEW_H = Math.round(OY + EX[1] * W + EY[1] * D + PAD + 14);

export type Pt = [number, number];

export function P(x: number, y: number, z = 0): Pt {
  return [OX + x * EX[0] + y * EY[0], OY + x * EX[1] + y * EY[1] - z];
}

export function R(x: number, y: number, z = 0): Pt {
  return [x * EX[0] + y * EY[0], x * EX[1] + y * EY[1] - z];
}

export const pts = (list: Pt[]) => list.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");

export interface BoxFaces {
  top: string;
  front: string;
  right: string;
}

export function box(x: number, y: number, z: number, w: number, d: number, h: number, rel = false): BoxFaces {
  const f = rel ? R : P;
  return {
    top: pts([f(x, y, z + h), f(x + w, y, z + h), f(x + w, y + d, z + h), f(x, y + d, z + h)]),
    front: pts([f(x, y + d, z + h), f(x + w, y + d, z + h), f(x + w, y + d, z), f(x, y + d, z)]),
    right: pts([f(x + w, y, z + h), f(x + w, y + d, z + h), f(x + w, y + d, z), f(x + w, y, z)]),
  };
}

export function disc(cx: number, cy: number, z: number, r: number, n = 22): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return P(cx + r * Math.cos(t), cy + r * Math.sin(t), z);
  });
}

export function cylinder(cx: number, cy: number, z: number, r: number, h: number) {
  const bottom = disc(cx, cy, z, r);
  const top = disc(cx, cy, z + h, r);
  let lo = 0;
  let hi = 0;
  bottom.forEach((p, i) => {
    if (p[0] < bottom[lo][0]) lo = i;
    if (p[0] > bottom[hi][0]) hi = i;
  });
  const arc: Pt[] = [];
  for (let i = lo; ; i = (i + bottom.length - 1) % bottom.length) {
    arc.push(bottom[i]);
    if (i === hi) break;
  }
  const arcFront = arc.reduce((s, p) => s + p[1], 0) / arc.length;
  const other: Pt[] = [];
  for (let i = lo; ; i = (i + 1) % bottom.length) {
    other.push(bottom[i]);
    if (i === hi) break;
  }
  const front = arcFront >= other.reduce((s, p) => s + p[1], 0) / other.length ? arc : other;
  const side = pts([top[lo], ...front, top[hi]]);
  return { side, top: pts(top) };
}

export function shade(hex: string, k: number): string {
  const v = Number.parseInt(hex.slice(1), 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const t = k >= 0 ? c + (255 - c) * k : c * (1 + k);
    return Math.max(0, Math.min(255, Math.round(t)));
  });
  return `rgb(${ch[0]} ${ch[1]} ${ch[2]})`;
}

export function pctPos(x: number, y: number, z = 0): { left: string; top: string } {
  const [sx, sy] = P(x, y, z);
  return { left: `${(sx / VIEW_W) * 100}%`, top: `${(sy / VIEW_H) * 100}%` };
}

export interface ZoneGeo {
  code: string;
  x0: number;
  x1: number;
}

export const ZONES: ZoneGeo[] = [
  { code: "WH_IN", x0: 0, x1: 130 },
  { code: "WELD", x0: 150, x1: 410 },
  { code: "PAINT", x0: 470, x1: 770 },
  { code: "ASSY", x0: 830, x1: 1070 },
  { code: "QC", x0: 1120, x1: 1290 },
  { code: "WH_OUT", x0: 1310, x1: 1440 },
];

export const BUFFERS: Record<string, { x0: number; x1: number }> = {
  WELD: { x0: 414, x1: 466 },
  PAINT: { x0: 774, x1: 826 },
  ASSY: { x0: 1074, x1: 1116 },
};

export const CONV_X0 = 112;
export const CONV_X1 = 1328;

export const zone = (code: string) => ZONES.find((z) => z.code === code) as ZoneGeo;

export type MachineKind = "robot" | "jig" | "drive" | "booth" | "paint" | "oven" | "tanks" | "gantry" | "lift" | "rollers" | "rain";

export interface MachineGeo {
  code: string;
  kind: MachineKind;
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  layer: "back" | "front";
}

export const MACHINES: MachineGeo[] = [
  { code: "ABB-01", kind: "robot", x: 186, y: 96, w: 18, d: 18, h: 10, layer: "back" },
  { code: "ABB-02", kind: "robot", x: 246, y: 96, w: 18, d: 18, h: 10, layer: "back" },
  { code: "ABB-03", kind: "robot", x: 326, y: 96, w: 18, d: 18, h: 10, layer: "back" },
  { code: "ABB-04", kind: "robot", x: 380, y: 96, w: 18, d: 18, h: 10, layer: "back" },
  { code: "Кондуктор-01", kind: "jig", x: 276, y: 124, w: 42, d: 52, h: 34, layer: "front" },
  { code: "Конвейер-01", kind: "drive", x: 176, y: 214, w: 22, d: 14, h: 26, layer: "front" },
  { code: "Камера-01", kind: "booth", x: 484, y: 112, w: 82, d: 76, h: 44, layer: "front" },
  { code: "Камера-02", kind: "paint", x: 578, y: 104, w: 100, d: 92, h: 54, layer: "front" },
  { code: "Печь-01", kind: "oven", x: 690, y: 110, w: 72, d: 80, h: 46, layer: "front" },
  { code: "Конвейер-02", kind: "drive", x: 500, y: 222, w: 22, d: 14, h: 26, layer: "front" },
  { code: "Конвейер-03", kind: "drive", x: 846, y: 214, w: 22, d: 14, h: 26, layer: "front" },
  { code: "Гайковёрт-01", kind: "gantry", x: 930, y: 112, w: 44, d: 76, h: 52, layer: "front" },
  { code: "Заливка-01", kind: "tanks", x: 1010, y: 70, w: 50, d: 30, h: 40, layer: "back" },
  { code: "Стенд-ТС", kind: "lift", x: 1128, y: 120, w: 40, d: 60, h: 30, layer: "front" },
  { code: "Стенд-РС", kind: "rollers", x: 1178, y: 128, w: 44, d: 44, h: 4, layer: "back" },
  { code: "Дождь-01", kind: "rain", x: 1232, y: 112, w: 52, d: 76, h: 46, layer: "front" },
];

export function beacon(m: MachineGeo): Pt {
  if (m.kind === "robot") return P(m.x + m.w / 2, m.y - 2, 64);
  return P(m.x + m.w, m.y, m.h + 12);
}
