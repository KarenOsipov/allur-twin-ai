import { useNodes, ViewportPortal } from "@xyflow/react";
import { memo, useMemo } from "react";
import type { PlantNode } from "./model";
import { zoneCode, zoneColor } from "./procs";

export interface ZoneBox {
  name: string;
  code: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
}

const PAD = 28;

export function zoneBoxes(nodes: { position: { x: number; y: number }; measured?: { width?: number; height?: number }; data: PlantNode["data"] }[]): ZoneBox[] {
  const map = new Map<string, { x0: number; y0: number; x1: number; y1: number; n: number }>();
  for (const n of nodes) {
    const z = n.data.zone?.trim();
    if (!z) continue;
    const wide = n.data.kind === "station" || n.data.kind === "assembly" || n.data.kind === "inspection";
    const w = n.measured?.width ?? (wide ? 250 : 200);
    const h = n.measured?.height ?? (wide ? 150 : 120);
    const b = map.get(z) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 };
    b.x0 = Math.min(b.x0, n.position.x);
    b.y0 = Math.min(b.y0, n.position.y);
    b.x1 = Math.max(b.x1, n.position.x + w);
    b.y1 = Math.max(b.y1, n.position.y + h);
    b.n += 1;
    map.set(z, b);
  }
  return [...map.entries()].map(([name, b]) => ({
    name,
    code: zoneCode(name),
    color: zoneColor(name),
    x: b.x0 - PAD,
    y: b.y0 - PAD - 22,
    w: b.x1 - b.x0 + PAD * 2,
    h: b.y1 - b.y0 + PAD * 2 + 22,
    count: b.n,
  }));
}

export const ZoneLayer = memo(function ZoneLayer({ onPick }: { onPick?: (zone: string) => void }) {
  const nodes = useNodes<PlantNode>();
  const key = nodes.map((n) => `${n.data.zone ?? ""}:${Math.round(n.position.x)}:${Math.round(n.position.y)}:${n.measured?.width ?? 0}:${n.measured?.height ?? 0}`).join("|");
  const boxes = useMemo(() => zoneBoxes(nodes), [key]);
  return (
    <ViewportPortal>
      {boxes.map((b) => (
        <div
          key={b.name}
          className="pointer-events-none absolute rounded-[6px] border-[1.5px] border-dashed"
          style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: -1, borderColor: `color-mix(in srgb, ${b.color} 55%, transparent)`, background: `color-mix(in srgb, ${b.color} 6%, transparent)` }}
        >
          <button
            type="button"
            title={onPick ? `Выделить все узлы зоны «${b.name}»` : b.name}
            onClick={() => onPick?.(b.name)}
            className="nodrag nopan pointer-events-auto absolute top-0 left-0 flex h-[22px] items-center gap-1.5 rounded-tl-[4px] rounded-br-[6px] px-2 text-[10.5px] font-bold tracking-[0.08em] text-white uppercase"
            style={{ background: b.color }}
          >
            <span className="font-mono opacity-80">{b.code}</span>
            <span>{b.name}</span>
            <span className="font-medium opacity-70">· {b.count}</span>
          </button>
        </div>
      ))}
    </ViewportPortal>
  );
});
