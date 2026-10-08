import { clsx } from "clsx";
import { memo, type ReactNode, useMemo } from "react";
import type { Body, Floor, FloorArea, FloorEquipment } from "@/shared/api/types";
import { AREA_STATE, STATE_COLOR, num } from "@/shared/lib/format";
import {
  BUFFERS,
  box,
  C,
  CONV_H,
  CONV_X0,
  CONV_X1,
  cylinder,
  D,
  disc,
  MACHINES,
  type MachineGeo,
  P,
  pctPos,
  pts,
  R,
  shade,
  VIEW_H,
  VIEW_W,
  W,
  ZONES,
  zone,
} from "./iso";

const CAR_L = 34;
const CAR_W = 18;

const S = {
  floorTop: "#2b2020",
  floorFront: "#1c1414",
  floorRight: "#150f0f",
  grid: "rgb(255 255 255 / 0.035)",
  wallTop: "#3a2c2c",
  wallFront: "#251b1b",
  steelTop: "#5c5251",
  steelFront: "#3f3736",
  steelRight: "#2f2828",
  convTop: "#151010",
  convFront: "#2a2121",
  convRight: "#201818",
  roller: "rgb(255 255 255 / 0.06)",
  lane: "var(--color-lane)",
  robot: "#ece6e4",
  robotShade: "#bfb5b2",
  glass: "rgb(255 255 255 / 0.07)",
  glassEdge: "rgb(255 255 255 / 0.22)",
};

const TINT: Record<string, string> = {
  run: "rgb(23 160 93 / 0.13)",
  starved: "rgb(154 163 181 / 0.08)",
  blocked: "rgb(212 155 0 / 0.16)",
  down: "rgb(224 59 59 / 0.22)",
  off: "rgb(255 255 255 / 0.02)",
};

export function IsoPlant({
  floor,
  onEquipment,
  onArea,
  selected,
}: {
  floor: Floor;
  onEquipment: (code: string) => void;
  onArea?: (code: string) => void;
  selected: string | null;
}) {
  const areas = useMemo(() => new Map(floor.areas.map((a) => [a.code, a])), [floor.areas]);
  const eq = useMemo(() => new Map(floor.equipment.map((e) => [e.code, e])), [floor.equipment]);
  const moving = floor.working && !floor.paused;

  const stateKey = floor.areas.map((a) => `${a.code}:${a.state}`).join("|") + floor.equipment.map((e) => e.status[0]).join("");
  const stockKey = `${areas.get("WH_IN")?.stock}|${areas.get("WH_OUT")?.stock}|${areas.get("WH_IN")?.delayed}`;

  return (
    <div className="scroll-thin -mx-1 overflow-x-auto px-1 pb-1">
      <div className="relative min-w-[1180px] select-none" style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}>
        <BackLayer areas={areas} equipment={eq} stateKey={stateKey} stockKey={stockKey} />
        <MotionLayer floor={floor} areas={areas} equipment={eq} moving={moving} />
        <FrontLayer equipment={eq} stateKey={stateKey} selected={selected} onEquipment={onEquipment} areas={areas} />
        <Labels floor={floor} areas={areas} onArea={onArea} />
      </div>
    </div>
  );
}

const BackLayer = memo(
  function BackLayer({ areas, equipment }: { areas: Map<string, FloorArea>; equipment: Map<string, FloorEquipment>; stateKey: string; stockKey: string }) {
    const slab = box(-14, -4, -12, W + 28, D + 8, 12);
    return (
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <pattern id="iso-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--color-down)" strokeWidth="3" opacity="0.35" />
          </pattern>
          <linearGradient id="iso-wall" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#3b2b2b" />
            <stop offset="1" stopColor="#221818" />
          </linearGradient>
        </defs>

        <polygon points={slab.front} fill={S.floorFront} />
        <polygon points={slab.right} fill={S.floorRight} />
        <polygon points={slab.top} fill={S.floorTop} />
        <FloorGrid />

        <Box b={box(-14, -10, 0, W + 28, 6, 30)} top={S.wallTop} front="url(#iso-wall)" right={S.wallFront} />
        {Array.from({ length: 13 }, (_, i) => {
          const x = 40 + i * 112;
          return <polygon key={i} points={pts([P(x, -4, 6), P(x + 60, -4, 6), P(x + 60, -4, 24), P(x, -4, 24)])} fill="rgb(255 255 255 / 0.035)" />;
        })}

        {ZONES.filter((z) => z.code !== "WH_IN" && z.code !== "WH_OUT").map((z) => {
          const st = areas.get(z.code)?.state ?? "off";
          const tile = pts([P(z.x0, 24, 0.5), P(z.x1, 24, 0.5), P(z.x1, D - 24, 0.5), P(z.x0, D - 24, 0.5)]);
          return (
            <g key={z.code}>
              <polygon points={tile} fill={TINT[st]} />
              {st === "down" && <polygon points={tile} fill="url(#iso-hatch)" />}
              <polygon points={tile} fill="none" stroke={st === "down" ? "var(--color-down)" : "rgb(255 255 255 / 0.1)"} strokeWidth={st === "down" ? 1.6 : 1} strokeDasharray="10 6" />
            </g>
          );
        })}

        <KitRacks stock={areas.get("WH_IN")?.stock ?? 0} delayed={Boolean(areas.get("WH_IN")?.delayed)} />

        {MACHINES.filter((m) => m.layer === "back").map((m) => (
          <BackMachine key={m.code} m={m} status={equipment.get(m.code)?.status ?? "run"} />
        ))}
        {MACHINES.filter((m) => m.kind === "jig" || m.kind === "gantry" || m.kind === "lift").map((m) => (
          <g key={m.code}>
            <Post x={m.x} y={m.y} h={m.h} />
            <Post x={m.x + m.w - 4} y={m.y} h={m.h} />
          </g>
        ))}
        {MACHINES.filter((m) => m.kind === "booth" || m.kind === "paint" || m.kind === "oven" || m.kind === "rain").map((m) => (
          <BoothBack key={m.code} m={m} />
        ))}

        <Worker x={880} y={112} />
        <Worker x={1000} y={116} />

        <Conveyor />

        <Parking count={areas.get("WH_OUT")?.stock ?? 0} />
      </svg>
    );
  },
  (a, b) => a.stateKey === b.stateKey && a.stockKey === b.stockKey,
);

function FloorGrid() {
  const lines: ReactNode[] = [];
  for (let x = 0; x <= W; x += 40) lines.push(<line key={`x${x}`} {...seg(P(x, 0, 0), P(x, D, 0))} stroke={S.grid} />);
  for (let y = 0; y <= D; y += 40) lines.push(<line key={`y${y}`} {...seg(P(0, y, 0), P(W, y, 0))} stroke={S.grid} />);
  return <g>{lines}</g>;
}

const seg = (a: [number, number], b: [number, number]) => ({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });

function Box({ b, top, front, right, stroke, opacity }: { b: ReturnType<typeof box>; top: string; front: string; right: string; stroke?: string; opacity?: number }) {
  return (
    <g opacity={opacity}>
      <polygon points={b.front} fill={front} stroke={stroke} strokeWidth={stroke ? 0.8 : 0} />
      <polygon points={b.right} fill={right} stroke={stroke} strokeWidth={stroke ? 0.8 : 0} />
      <polygon points={b.top} fill={top} stroke={stroke} strokeWidth={stroke ? 0.8 : 0} />
    </g>
  );
}

function Post({ x, y, h }: { x: number; y: number; h: number }) {
  return <Box b={box(x, y, 0, 4, 4, h)} top="#8d8382" front="#6d6463" right="#554d4c" />;
}

function Conveyor() {
  const len = CONV_X1 - CONV_X0;
  const b = box(CONV_X0, C - 16, 0, len, 32, CONV_H);
  const rollers: ReactNode[] = [];
  for (let x = CONV_X0 + 6; x < CONV_X1; x += 9) rollers.push(<line key={x} {...seg(P(x, C - 15, CONV_H), P(x, C + 15, CONV_H))} stroke={S.roller} strokeWidth={1.4} />);
  return (
    <g>
      <Box b={b} top={S.convTop} front={S.convFront} right={S.convRight} />
      {rollers}
      {[C - 16, C + 16].map((y) => (
        <line key={y} {...seg(P(CONV_X0, y, CONV_H + 0.5), P(CONV_X1, y, CONV_H + 0.5))} stroke={S.lane} strokeWidth={1.6} strokeDasharray="14 9" opacity={0.85} />
      ))}
      {Object.values(BUFFERS).map((bf) => (
        <polygon key={bf.x0} points={pts([P(bf.x0, C - 14, CONV_H + 0.6), P(bf.x1, C - 14, CONV_H + 0.6), P(bf.x1, C + 14, CONV_H + 0.6), P(bf.x0, C + 14, CONV_H + 0.6)])} fill="rgb(255 255 255 / 0.035)" stroke="rgb(255 255 255 / 0.12)" strokeDasharray="3 3" />
      ))}
    </g>
  );
}

function KitRacks({ stock, delayed }: { stock: number; delayed: boolean }) {
  const crates = Math.min(30, Math.ceil(stock / 2));
  const racks = [
    { x: 8, y: 34 },
    { x: 8, y: 214 },
  ];
  const out: ReactNode[] = [];
  racks.forEach((r, ri) => {
    out.push(<Box key={`rk${ri}`} b={box(r.x, r.y, 0, 112, 40, 2)} top="#4b3f3e" front="#2f2727" right="#271f1f" />);
    for (let lvl = 0; lvl < 3; lvl++) {
      out.push(<Box key={`sh${ri}${lvl}`} b={box(r.x, r.y, lvl * 16 + 15, 112, 40, 1.5)} top="#5a4e4d" front="#3b3232" right="#302827" />);
    }
    [0, 108].forEach((dx) => out.push(<Box key={`p${ri}${dx}`} b={box(r.x + dx, r.y + 36, 0, 4, 4, 50)} top="#8d8382" front="#6d6463" right="#554d4c" />));
  });
  for (let i = 0; i < crates; i++) {
    const r = racks[i < 15 ? 0 : 1];
    const k = i % 15;
    const col = k % 5;
    const lvl = Math.floor(k / 5);
    const c = delayed ? "#8a6a2a" : "#b98a4a";
    out.push(<Box key={`c${i}`} b={box(r.x + 4 + col * 22, r.y + 6, lvl * 16 + 1.5, 18, 28, 12)} top={shade(c, 0.18)} front={c} right={shade(c, -0.3)} />);
  }
  return <g>{out}</g>;
}

function Parking({ count }: { count: number }) {
  const shown = Math.min(count, 24);
  const palette = ["#F2F3F0", "#B8BDC3", "#202327", "#6C727A", "#A9242C", "#234E86"];
  const cars: ReactNode[] = [];
  for (let r = 0; r < 8; r++) {
    const y = 34 + r * 30;
    cars.push(<line key={`l${r}`} {...seg(P(1316, y - 4, 0.5), P(1436, y - 4, 0.5))} stroke="rgb(255 255 255 / 0.12)" />);
  }
  for (let i = 0; i < shown; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const [sx, sy] = P(1316 + col * 40, 34 + row * 30, 0);
    cars.push(
      <g key={i} transform={`translate(${sx} ${sy})`}>
        <CarShape hex={palette[(i * 7) % palette.length]} />
      </g>,
    );
  }
  return <g>{cars}</g>;
}

function BackMachine({ m, status }: { m: MachineGeo; status: string }) {
  if (m.kind === "robot") {
    const cx = m.x + m.w / 2;
    const cy = m.y + m.d / 2;
    const base = cylinder(cx, cy, 0, 10, 10);
    const turret = cylinder(cx, cy, 10, 7, 12);
    return (
      <g>
        <polygon points={pts(disc(cx, cy, 0.4, 13))} fill="rgb(0 0 0 / 0.35)" />
        <polygon points={base.side} fill="#3a3131" />
        <polygon points={base.top} fill="#4c4141" />
        <polygon points={turret.side} fill={status === "down" ? "#a33a33" : S.robotShade} />
        <polygon points={turret.top} fill={S.robot} />
      </g>
    );
  }
  if (m.kind === "tanks") {
    return (
      <g>
        {[0, 18, 36].map((dx, i) => {
          const cyl = cylinder(m.x + 8 + dx, m.y + 12, 0, 8, m.h - i * 6);
          return (
            <g key={dx}>
              <polygon points={cyl.side} fill={["#6b5e5c", "#8a7f7d", "#5a4f4e"][i]} />
              <polygon points={cyl.top} fill={["#8a7f7d", "#a69c9a", "#76696a"][i]} />
            </g>
          );
        })}
        <polyline points={pts([P(m.x + 30, m.y + 12, 26), P(m.x + 30, C - 18, 26), P(m.x + 30, C - 18, 16)])} fill="none" stroke="#9a8f8d" strokeWidth={2.4} />
      </g>
    );
  }
  if (m.kind === "rollers") {
    const plate = box(m.x, m.y, 0, m.w, m.d, 2);
    const lines: ReactNode[] = [];
    for (let i = 1; i < 6; i++) lines.push(<line key={i} {...seg(P(m.x + 4, m.y + i * 7, 2.2), P(m.x + m.w - 4, m.y + i * 7, 2.2))} stroke="#9a8f8d" strokeWidth={1.6} />);
    return (
      <g>
        <Box b={plate} top="#3e3434" front="#2a2222" right="#221b1b" />
        {lines}
      </g>
    );
  }
  return null;
}

function BoothBack({ m }: { m: MachineGeo }) {
  const back = pts([P(m.x, m.y, 0), P(m.x + m.w, m.y, 0), P(m.x + m.w, m.y, m.h), P(m.x, m.y, m.h)]);
  const left = pts([P(m.x, m.y, 0), P(m.x, m.y + m.d, 0), P(m.x, m.y + m.d, m.h), P(m.x, m.y, m.h)]);
  const tone = m.kind === "oven" ? "rgb(60 30 20 / 0.7)" : m.kind === "rain" ? "rgb(70 120 200 / 0.12)" : "rgb(255 255 255 / 0.05)";
  return (
    <g>
      <polygon points={pts([P(m.x, m.y, 0.6), P(m.x + m.w, m.y, 0.6), P(m.x + m.w, m.y + m.d, 0.6), P(m.x, m.y + m.d, 0.6)])} fill="rgb(0 0 0 / 0.25)" />
      <polygon points={back} fill={tone} stroke={S.glassEdge} strokeWidth={0.8} />
      <polygon points={left} fill={tone} stroke={S.glassEdge} strokeWidth={0.8} />
    </g>
  );
}

function Worker({ x, y }: { x: number; y: number }) {
  const body = box(x - 3, y - 3, 0, 6, 6, 14);
  const [hx, hy] = P(x, y, 18);
  return (
    <g>
      <polygon points={pts(disc(x, y, 0.3, 5))} fill="rgb(0 0 0 / 0.35)" />
      <Box b={body} top="#2f3c55" front="#25314a" right="#1c263a" />
      <circle cx={hx} cy={hy} r={3.4} fill="#e8c9a8" />
      <path d={`M${hx - 3.6} ${hy - 0.5} a3.6 3.6 0 0 1 7.2 0 z`} fill="var(--color-blocked)" />
    </g>
  );
}

function MotionLayer({ floor, areas, equipment, moving }: { floor: Floor; areas: Map<string, FloorArea>; equipment: Map<string, FloorEquipment>; moving: boolean }) {
  const cars = placeCars(floor);
  const [fx1, fy1] = P(CONV_X0 + 2, C, CONV_H + 0.8);
  const [fx2, fy2] = P(CONV_X1 - 2, C, CONV_H + 0.8);
  const weld = areas.get("WELD")?.state === "run" && moving;
  const paint = areas.get("PAINT")?.state === "run" && moving;
  const rainOn = areas.get("QC")?.state === "run" && moving;
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="pointer-events-none absolute inset-0 h-full w-full [will-change:transform]" aria-hidden>
      <defs>
        <radialGradient id="iso-spray">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ff6a5c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <line x1={fx1} y1={fy1} x2={fx2} y2={fy2} stroke="rgb(255 255 255 / 0.16)" strokeWidth={1.4} strokeDasharray="5 9" style={moving ? { animation: "flow 1.1s linear infinite" } : undefined} />

      {MACHINES.filter((m) => m.kind === "robot").map((m, i) => (
        <RobotArm key={m.code} m={m} active={weld && equipment.get(m.code)?.status !== "down"} delay={i * 0.37} down={equipment.get(m.code)?.status === "down"} />
      ))}

      {cars.map((c) => {
        const [sx, sy] = P(c.x, C - CAR_W / 2 + c.dy, CONV_H + 0.5);
        return (
          <g key={c.body.vin} style={{ transform: `translate(${sx}px, ${sy}px) scale(${c.scale})`, transition: "transform var(--frame-ms, 500ms) linear" }}>
            <CarShape hex={c.body.hex} defect={c.body.defect} title={`${c.body.model}, ${c.body.color.toLowerCase()} · ${c.body.vin}${c.body.defect ? " · есть дефект" : ""}`} />
          </g>
        );
      })}

      {paint && (
        <ellipse cx={P(628, C, 30)[0]} cy={P(628, C, 30)[1]} rx={46} ry={22} fill="url(#iso-spray)" style={{ animation: "blink 1.6s ease-in-out infinite" }} />
      )}
      {rainOn && <Rain />}

      {MACHINES.filter((m) => equipment.get(m.code)?.status === "down").map((m) => {
        const [bx, by] = beaconOf(m);
        return (
          <g key={m.code}>
            <circle cx={bx} cy={by} r={9} fill="none" stroke="var(--color-down)" strokeWidth={2} style={{ animation: "pulse-ring 1.4s ease-out infinite", transformOrigin: `${bx}px ${by}px` }} />
          </g>
        );
      })}
    </svg>
  );
}

function beaconOf(m: MachineGeo): [number, number] {
  if (m.kind === "robot") return P(m.x + m.w / 2, m.y + m.d / 2, 58);
  return P(m.x + m.w, m.y, m.h + 14);
}

function RobotArm({ m, active, delay, down }: { m: MachineGeo; active: boolean; delay: number; down: boolean }) {
  const cx = m.x + m.w / 2;
  const cy = m.y + m.d / 2;
  const sh = P(cx, cy, 22);
  const el = P(cx + 4, cy + 22, 54);
  const tip = P(cx + 8, C - 6, 34);
  const line = pts([sh, el, tip]);
  return (
    <g style={active ? { transformOrigin: `${sh[0]}px ${sh[1]}px`, animation: `arm 1.5s ease-in-out ${delay}s infinite alternate` } : undefined}>
      <polyline points={line} fill="none" stroke={down ? "#7a2a25" : S.robotShade} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" />
      <polyline points={line} fill="none" stroke={down ? "#c4463e" : S.robot} strokeWidth={5.4} strokeLinecap="round" strokeLinejoin="round" />
      <line x1={el[0] - (el[0] - sh[0]) * 0.28} y1={el[1] - (el[1] - sh[1]) * 0.28} x2={el[0] - (el[0] - sh[0]) * 0.12} y2={el[1] - (el[1] - sh[1]) * 0.12} stroke="var(--color-brand)" strokeWidth={5.6} />
      <circle cx={sh[0]} cy={sh[1]} r={4.6} fill="#9b908e" />
      <circle cx={el[0]} cy={el[1]} r={4} fill="#9b908e" />
      <circle cx={tip[0]} cy={tip[1]} r={2.6} fill={active ? "#ffd27a" : "#6b605e"} />
    </g>
  );
}

function Rain() {
  const drops: ReactNode[] = [];
  for (let i = 0; i < 9; i++) {
    const x = 1240 + (i % 3) * 16 + 4;
    const y = 124 + Math.floor(i / 3) * 22;
    const [x1, y1] = P(x, y, 42);
    drops.push(<line key={i} x1={x1} y1={y1} x2={x1} y2={y1 + 26} stroke="rgb(140 190 255 / 0.55)" strokeWidth={1.2} strokeDasharray="3 6" style={{ animation: `flow 0.6s linear ${i * 0.07}s infinite reverse` }} />);
  }
  return <g>{drops}</g>;
}

interface Placed {
  body: Body;
  x: number;
  dy: number;
  scale: number;
}

function placeCars(floor: Floor): Placed[] {
  const out: Placed[] = [];
  for (const a of floor.areas) {
    if (a.kind === "store") continue;
    const z = zone(a.code);
    if (a.current) {
      const travel = z.x1 - z.x0 - 24 - CAR_L;
      out.push({ body: a.current, x: z.x0 + 12 + (a.progress ?? 0) * travel, dy: 0, scale: 1 });
    }
    const buf = BUFFERS[a.code];
    if (buf && a.buffer?.length) {
      const cap = Math.max(a.buffer_cap ?? a.buffer.length, 1);
      const cols = Math.ceil(cap / 2);
      const cw = (buf.x1 - buf.x0) / cols;
      a.buffer.forEach((b, i) => {
        const col = cols - 1 - Math.floor(i / 2);
        out.push({ body: b, x: buf.x0 + col * cw + (cw - CAR_L * 0.38) / 2, dy: i % 2 === 0 ? -5 : 7, scale: 0.38 });
      });
    }
  }
  return out;
}

function CarShape({ hex, defect, title }: { hex: string; defect?: boolean; title?: string }) {
  const body = box(0, 0, 0, CAR_L, CAR_W, 7, true);
  const cabin = box(9, 1.5, 7, 17, CAR_W - 3, 6, true);
  const light = luminance(hex) > 0.6;
  const glass = light ? "#26313f" : "#9fb2c7";
  return (
    <g>
      {title && <title>{title}</title>}
      <polygon points={pts([R(-2, 2, 0), R(CAR_L + 2, 2, 0), R(CAR_L + 2, CAR_W + 3, 0), R(-2, CAR_W + 3, 0)])} fill="rgb(0 0 0 / 0.4)" />
      <polygon points={body.front} fill={hex} />
      <polygon points={body.right} fill={shade(hex, -0.32)} />
      <polygon points={body.top} fill={shade(hex, 0.16)} />
      <polygon points={cabin.front} fill={glass} opacity={0.9} />
      <polygon points={cabin.right} fill={shade(glass, -0.25)} opacity={0.9} />
      <polygon points={cabin.top} fill={shade(hex, 0.08)} />
      {defect && <polygon points={pts([R(-3, -3, 14), R(CAR_L + 3, -3, 14), R(CAR_L + 3, CAR_W + 3, 14), R(-3, CAR_W + 3, 14)])} fill="none" stroke="var(--color-down)" strokeWidth={1.4} strokeDasharray="3 2" />}
    </g>
  );
}

function luminance(hex: string) {
  const v = Number.parseInt(hex.slice(1), 16);
  return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
}

const FrontLayer = memo(
  function FrontLayer({
    equipment,
    selected,
    onEquipment,
  }: {
    equipment: Map<string, FloorEquipment>;
    stateKey: string;
    selected: string | null;
    onEquipment: (code: string) => void;
    areas: Map<string, FloorArea>;
  }) {
    return (
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="absolute inset-0 h-full w-full" role="group" aria-label="Оборудование цеха">
        <Worker x={900} y={196} />
        <Worker x={1046} y={192} />
        {MACHINES.map((m) => {
          const e = equipment.get(m.code);
          const status = e?.status ?? "run";
          return (
            <g
              key={m.code}
              role="button"
              tabIndex={0}
              aria-label={`${m.code}: ${statusWord(status)}`}
              onClick={() => onEquipment(m.code)}
              onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && onEquipment(m.code)}
              className="group cursor-pointer outline-none"
            >
              <title>{`${m.code} — ${statusWord(status)}${e?.reason ? `: ${e.reason.toLowerCase()}` : ""}. Нажмите, чтобы открыть риск и историю`}</title>
              <FrontMachine m={m} status={status} />
              <HitArea m={m} selected={selected === m.code} />
              <Beacon m={m} status={status} />
            </g>
          );
        })}
      </svg>
    );
  },
  (a, b) => a.stateKey === b.stateKey && a.selected === b.selected && a.onEquipment === b.onEquipment,
);

const statusWord = (s: string) => ({ run: "работает", idle: "ожидает кузов", down: "отказ", maint: "обслуживание", off: "выключено" })[s] ?? s;

function HitArea({ m, selected }: { m: MachineGeo; selected: boolean }) {
  const b = m.kind === "robot" ? box(m.x - 6, m.y - 4, 0, m.w + 16, m.d + 34, 60) : box(m.x - 2, m.y - 2, 0, m.w + 4, m.d + 4, m.h + 6);
  const cls = clsx(
    "transition-opacity duration-150",
    selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
  );
  const stroke = selected ? "var(--color-brand)" : "rgb(255 255 255 / 0.55)";
  return (
    <g>
      <polygon points={b.top} fill="transparent" />
      <polygon points={b.front} fill="transparent" />
      <polygon points={b.right} fill="transparent" />
      <g className={cls} fill="none" stroke={stroke} strokeWidth={1.6} strokeDasharray={selected ? undefined : "4 3"}>
        <polygon points={b.top} />
        <polygon points={b.front} />
        <polygon points={b.right} />
      </g>
    </g>
  );
}

function Beacon({ m, status }: { m: MachineGeo; status: string }) {
  const [bx, by] = beaconOf(m);
  const base = m.kind === "robot" ? P(m.x + m.w / 2, m.y + m.d / 2, 22) : P(m.x + m.w, m.y, m.h);
  const color = STATE_COLOR[status] ?? STATE_COLOR.run;
  return (
    <g>
      <line x1={base[0]} y1={base[1]} x2={bx} y2={by} stroke="rgb(255 255 255 / 0.25)" strokeWidth={1} />
      <circle cx={bx} cy={by} r={4.6} fill={color} stroke="rgb(0 0 0 / 0.5)" strokeWidth={1} />
      <circle cx={bx - 1.3} cy={by - 1.3} r={1.4} fill="rgb(255 255 255 / 0.6)" />
    </g>
  );
}

function FrontMachine({ m, status }: { m: MachineGeo; status: string }) {
  const down = status === "down";
  switch (m.kind) {
    case "drive": {
      const b = box(m.x, m.y, 0, m.w, m.d, m.h);
      const [s1, s2] = [P(m.x + 4, m.y + m.d, m.h - 6), P(m.x + m.w - 4, m.y + m.d, m.h - 14)];
      return (
        <g>
          <polygon points={pts(disc(m.x + m.w / 2, m.y + m.d / 2, 0.3, 16))} fill="rgb(0 0 0 / 0.3)" />
          <Box b={b} top="#6a605f" front={down ? "#5a2a26" : "#4a4141"} right="#373030" />
          <rect x={s1[0]} y={s1[1]} width={Math.max(4, s2[0] - s1[0])} height={7} rx={1} fill={down ? "var(--color-down)" : "#3fbf86"} opacity={0.85} />
          <polyline points={pts([P(m.x + m.w / 2, m.y, 2), P(m.x + m.w / 2, C + 17, 2)])} fill="none" stroke="#151010" strokeWidth={2} />
        </g>
      );
    }
    case "jig":
    case "gantry":
    case "lift":
      return <Frame m={m} down={down} />;
    case "booth":
    case "paint":
    case "oven":
    case "rain":
      return <BoothFront m={m} down={down} />;
    default:
      return null;
  }
}

function Frame({ m, down }: { m: MachineGeo; down: boolean }) {
  const beam = down ? "#c4463e" : m.kind === "gantry" ? "#d9a12b" : "#9b908e";
  const top = shade(m.kind === "gantry" ? "#d9a12b" : "#9b908e", 0.15);
  return (
    <g>
      <Post x={m.x} y={m.y + m.d - 4} h={m.h} />
      <Post x={m.x + m.w - 4} y={m.y + m.d - 4} h={m.h} />
      <Box b={box(m.x, m.y, m.h, m.w, 4, 4)} top={top} front={beam} right={shade(beam, -0.3)} />
      <Box b={box(m.x, m.y + m.d - 4, m.h, m.w, 4, 4)} top={top} front={beam} right={shade(beam, -0.3)} />
      <Box b={box(m.x, m.y, m.h, 4, m.d, 4)} top={top} front={beam} right={shade(beam, -0.3)} />
      <Box b={box(m.x + m.w - 4, m.y, m.h, 4, m.d, 4)} top={top} front={beam} right={shade(beam, -0.3)} />
      {m.kind === "gantry" && (
        <g>
          <line {...seg(P(m.x + m.w / 2, C, m.h), P(m.x + m.w / 2, C, 26))} stroke="#cfc6c4" strokeWidth={1.2} />
          <Box b={box(m.x + m.w / 2 - 4, C - 4, 18, 8, 8, 8)} top="#f0c869" front="#d9a12b" right="#a8791d" />
        </g>
      )}
      {m.kind === "jig" && (
        <g>
          {[C - 10, C + 10].map((y) => (
            <line key={y} {...seg(P(m.x + 8, y, m.h), P(m.x + 8, y, 20))} stroke="#cfc6c4" strokeWidth={1.4} />
          ))}
        </g>
      )}
    </g>
  );
}

function BoothFront({ m, down }: { m: MachineGeo; down: boolean }) {
  const b = box(m.x, m.y, 0, m.w, m.d, m.h);
  const edge = down ? "var(--color-down)" : S.glassEdge;
  const isOven = m.kind === "oven";
  const front = isOven ? "rgb(70 34 24 / 0.82)" : m.kind === "rain" ? "rgb(90 140 220 / 0.13)" : S.glass;
  const right = isOven ? "rgb(50 24 18 / 0.86)" : m.kind === "rain" ? "rgb(90 140 220 / 0.1)" : "rgb(255 255 255 / 0.05)";
  const roof = isOven ? "#4a2c22" : m.kind === "paint" ? "rgb(255 255 255 / 0.1)" : "rgb(255 255 255 / 0.08)";
  return (
    <g>
      <polygon points={b.front} fill={front} stroke={edge} strokeWidth={1} />
      <polygon points={b.right} fill={right} stroke={edge} strokeWidth={1} />
      <polygon points={b.top} fill={roof} stroke={edge} strokeWidth={1} />
      {m.kind === "paint" && (
        <g>
          <polygon points={pts([P(m.x, m.y + m.d, m.h - 6), P(m.x + m.w, m.y + m.d, m.h - 6), P(m.x + m.w, m.y + m.d, m.h - 12), P(m.x, m.y + m.d, m.h - 12)])} fill="var(--color-brand)" opacity={0.9} />
          <Box b={box(m.x + 30, m.y + 30, m.h, 40, 30, 8)} top="#7a706e" front="#5a5150" right="#4a4241" />
        </g>
      )}
      {isOven &&
        [0.25, 0.5, 0.75].map((k) => {
          const a = P(m.x + 8, m.y + m.d, m.h * k);
          const c = P(m.x + m.w - 8, m.y + m.d, m.h * k);
          return <line key={k} x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} stroke="#ff8a3d" strokeWidth={2} opacity={0.75} />;
        })}
      {m.kind === "booth" && (
        <polygon points={pts([P(m.x, m.y + m.d, m.h - 5), P(m.x + m.w, m.y + m.d, m.h - 5), P(m.x + m.w, m.y + m.d, m.h - 9), P(m.x, m.y + m.d, m.h - 9)])} fill="rgb(255 255 255 / 0.25)" />
      )}
    </g>
  );
}

function Labels({ floor, areas, onArea }: { floor: Floor; areas: Map<string, FloorArea>; onArea?: (code: string) => void }) {
  const bottleneck = floor.kpi.bottleneck;
  return (
    <div className="pointer-events-none absolute inset-0">
      {ZONES.map((z) => {
        const a = areas.get(z.code);
        if (!a) return null;
        const cx = (z.x0 + z.x1) / 2;
        const pos = pctPos(cx, 0, 82);
        return (
          <div key={z.code} className="absolute -translate-x-1/2 -translate-y-full" style={pos}>
            <button
              type="button"
              onClick={() => onArea?.(a.code)}
              disabled={!onArea}
              aria-label={`${a.name}: подробнее`}
              className="pointer-events-auto block cursor-pointer rounded-[14px] text-left transition-transform duration-150 outline-none hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-default disabled:hover:translate-y-0"
            >
              {a.kind === "store" ? <StoreCard a={a} /> : <AreaCard a={a} bottleneck={bottleneck === a.code} />}
            </button>
            <div className="mx-auto h-3 w-px bg-white/25" />
          </div>
        );
      })}
      {Object.entries(BUFFERS).map(([code, b]) => {
        const a = areas.get(code);
        const cap = a?.buffer_cap ?? 0;
        const n = a?.buffer?.length ?? 0;
        const full = cap > 0 && n >= cap;
        const empty = n === 0;
        return (
          <div key={code} className="absolute -translate-x-1/2" style={pctPos((b.x0 + b.x1) / 2, C + 58, 0)}>
            <div
              className={clsx(
                "rounded-full border px-2 py-0.5 text-[11px] leading-4 font-semibold whitespace-nowrap backdrop-blur-[2px]",
                full ? "border-blocked/60 bg-blocked/20 text-[#ffd970]" : empty ? "border-white/10 bg-black/30 text-white/50" : "border-white/15 bg-black/35 text-white/85",
              )}
            >
              буфер {n}/{cap}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AreaCard({ a, bottleneck }: { a: FloorArea; bottleneck: boolean }) {
  const st = a.state ?? "off";
  const down = st === "down";
  return (
    <div
      className={clsx(
        "w-[176px] rounded-[14px] border px-3 py-2 text-white shadow-[0_10px_30px_-12px_rgb(0_0_0/0.8)]",
        down ? "border-down/70 bg-[#3a1514]/90" : bottleneck ? "border-brand/70 bg-[#2a1716]/90" : "border-white/12 bg-[#1f1616]/88",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="display truncate text-[0.92rem] leading-5 font-medium" title={a.name}>{a.name}</span>
        {bottleneck && <span className="shrink-0 rounded-full bg-brand px-1.5 text-[10px] leading-4 font-bold">узкое</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: down ? "#ff9a93" : "rgb(255 255 255 / 0.7)" }}>
        <span className={clsx("size-1.5 rounded-full", down && "animate-[blink_1s_ease-in-out_infinite]")} style={{ background: STATE_COLOR[st] }} />
        {AREA_STATE[st]}
      </div>
      <div className="mt-1 flex items-baseline justify-between">
        <span className="display num text-[1.55rem] leading-none font-light">{num(a.output)}</span>
        <span className="text-[10.5px] text-white/60">
          {a.kind === "inspection" ? "проверено" : `OEE ${a.oee == null ? "—" : `${Math.round(a.oee)}%`}`}
          {a.defects ? ` · брак ${a.defects}` : ""}
        </span>
      </div>
    </div>
  );
}

function StoreCard({ a }: { a: FloorArea }) {
  const incoming = a.code === "WH_IN";
  const warn = incoming && ((a.stock ?? 0) < 6 || a.delayed);
  return (
    <div className={clsx("w-[112px] rounded-[14px] border px-3 py-2 text-white", warn ? "border-blocked/70 bg-[#3a2c10]/90" : "border-white/12 bg-[#1f1616]/88")}>
      <div className="text-[11px] leading-4 font-semibold text-white/70">{incoming ? "Склад комплектов" : "Готовые авто"}</div>
      <div className="display num mt-0.5 text-[1.45rem] leading-none font-light">{num(a.stock)}</div>
      {incoming && a.delayed && <div className="mt-1 text-[10.5px] leading-3 font-bold text-[#ffd970]">поставка задержана</div>}
    </div>
  );
}
