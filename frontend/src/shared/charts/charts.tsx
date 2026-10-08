import { clsx } from "clsx";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (max === min) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
}

const PAD = { top: 12, right: 22, bottom: 24, left: 40 };

export function LineChart({
  labels,
  series,
  height = 220,
  target,
  band,
  yMin,
  yMax,
  format = (v) => String(Math.round(v)),
  xEvery,
  marker,
}: {
  labels: string[];
  marker?: { at: number; label: string };
  series: Series[];
  height?: number;
  target?: { value: number; label: string };
  band?: { low: (number | null)[]; high: (number | null)[]; color: string };
  yMin?: number;
  yMax?: number;
  format?: (v: number) => string;
  xEvery?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const all = [
    ...series.flatMap((s) => s.values),
    ...(band ? [...band.low, ...band.high] : []),
    ...(target ? [target.value] : []),
  ].filter((v): v is number => v != null);
  let lo = yMin ?? Math.min(...all);
  let hi = yMax ?? Math.max(...all);
  if (yMin === undefined) lo -= (hi - lo) * 0.08 || 1;
  if (yMax === undefined) hi += (hi - lo) * 0.08 || 1;
  const ticks = niceTicks(lo, hi);
  const w = Math.max(width - PAD.left - PAD.right, 10);
  const h = height - PAD.top - PAD.bottom;
  const n = labels.length;
  const x = (i: number) => PAD.left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => PAD.top + h - ((v - lo) / (hi - lo || 1)) * h;
  const every = xEvery ?? Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 64))));

  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const bandPath = () => {
    if (!band) return "";
    const idx = band.low.map((v, i) => (v != null && band.high[i] != null ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return "";
    const top = idx.map((i, k) => `${k ? "L" : "M"}${x(i)},${y(band.high[i] as number)}`).join("");
    const bottom = [...idx].reverse().map((i) => `L${x(i)},${y(band.low[i] as number)}`).join("");
    return `${top}${bottom}Z`;
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left - PAD.left;
    const i = Math.round((px / w) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };

  return (
    <div ref={ref} className="relative w-full select-none">
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.name, color: s.color, dashed: s.dashed }))} />}
      {width > 0 && (
        <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={series.map((s) => s.name).join(", ")}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={PAD.left + w} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="fill-ink-3 text-[11px]">
                {format(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            i % every === 0 ? (
              <text key={l + i} x={x(i)} y={height - 6} textAnchor="middle" className="fill-ink-3 text-[11px]">
                {l}
              </text>
            ) : null,
          )}
          {band && <path d={bandPath()} fill={band.color} opacity={0.14} />}
          {target && (
            <g>
              <line x1={PAD.left} x2={PAD.left + w} y1={y(target.value)} y2={y(target.value)} stroke="var(--color-ink)" strokeWidth={1} strokeDasharray="4 4" opacity={0.55} />
              <text x={PAD.left + w} y={y(target.value) - 5} textAnchor="end" className="fill-ink-2 text-[11px] font-medium">
                {target.label}
              </text>
            </g>
          )}
          {marker && marker.at >= 0 && (
            <g>
              <line x1={x(marker.at)} x2={x(marker.at)} y1={PAD.top - 4} y2={PAD.top + h} stroke="var(--color-brand)" strokeWidth={1.5} />
              <text x={Math.min(x(marker.at) + 5, PAD.left + w - 4)} y={PAD.top + 8} textAnchor={x(marker.at) > PAD.left + w - 60 ? "end" : "start"} className="fill-brand text-[11px] font-semibold">
                {marker.label}
              </text>
            </g>
          )}
          {series.map((s) => (
            <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "5 4" : undefined} />
          ))}
          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + h} stroke="var(--color-ink-3)" strokeWidth={1} />
              {series.map((s) =>
                s.values[hover] != null ? <circle key={s.name} cx={x(hover)} cy={y(s.values[hover] as number)} r={4} fill={s.color} stroke="white" strokeWidth={2} /> : null,
              )}
            </g>
          )}
        </svg>
      )}
      {hover != null && width > 0 && (
        <Tip x={x(hover)} width={width}>
          <div className="mb-1 font-medium">{labels[hover]}</div>
          {series.map((s) =>
            s.values[hover] != null ? (
              <div key={s.name} className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ background: s.color }} />
                <span className="text-ink-2">{s.name}</span>
                <span className="num ml-auto pl-3 font-medium">{format(s.values[hover] as number)}</span>
              </div>
            ) : null,
          )}
          {band && band.low[hover] != null && (
            <div className="mt-0.5 text-ink-3">
              коридор {format(band.low[hover] as number)}–{format(band.high[hover] as number)}
            </div>
          )}
        </Tip>
      )}
    </div>
  );
}

export function BarChart({
  labels,
  values,
  color = "var(--color-accent)",
  height = 200,
  target,
  name,
  format = (v) => String(Math.round(v)),
  colorFor,
}: {
  labels: string[];
  values: number[];
  color?: string;
  height?: number;
  target?: { value: number; label: string };
  name: string;
  format?: (v: number) => string;
  colorFor?: (v: number, i: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const hi = Math.max(...values, target?.value ?? 0) * 1.1 || 1;
  const ticks = niceTicks(0, hi);
  const w = Math.max(width - PAD.left - PAD.right, 10);
  const h = height - PAD.top - PAD.bottom;
  const n = values.length;
  const slot = w / Math.max(n, 1);
  const bw = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number) => PAD.top + h - (v / hi) * h;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 56))));
  return (
    <div ref={ref} className="relative w-full select-none">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={name} onPointerLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={PAD.left + w} y1={y(t)} y2={y(t)} stroke="var(--color-line)" />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="fill-ink-3 text-[11px]">
                {format(t)}
              </text>
            </g>
          ))}
          {values.map((v, i) => {
            const cx = PAD.left + slot * i + slot / 2;
            const top = y(v);
            const r = Math.min(4, bw / 2);
            return (
              <g key={labels[i] + i} onPointerEnter={() => setHover(i)}>
                <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={h} fill="transparent" />
                <path
                  d={`M${cx - bw / 2},${PAD.top + h}V${top + r}a${r},${r} 0 0 1 ${r},${-r}H${cx + bw / 2 - r}a${r},${r} 0 0 1 ${r},${r}V${PAD.top + h}Z`}
                  fill={colorFor ? colorFor(v, i) : color}
                  opacity={hover == null || hover === i ? 1 : 0.55}
                  style={{ transition: "opacity .15s" }}
                />
                {i % every === 0 && (
                  <text x={cx} y={height - 6} textAnchor="middle" className="fill-ink-3 text-[11px]">
                    {labels[i]}
                  </text>
                )}
              </g>
            );
          })}
          {target && (
            <g pointerEvents="none">
              <line x1={PAD.left} x2={PAD.left + w} y1={y(target.value)} y2={y(target.value)} stroke="var(--color-ink)" strokeDasharray="4 4" opacity={0.55} />
              <text x={PAD.left + w} y={y(target.value) - 5} textAnchor="end" className="fill-ink-2 text-[11px] font-medium">
                {target.label}
              </text>
            </g>
          )}
        </svg>
      )}
      {hover != null && width > 0 && (
        <Tip x={PAD.left + slot * hover + slot / 2} width={width}>
          <div className="font-medium">{labels[hover]}</div>
          <div className="flex gap-3 text-ink-2">
            {name}
            <span className="num ml-auto font-medium text-ink">{format(values[hover])}</span>
          </div>
        </Tip>
      )}
    </div>
  );
}

function Tip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x + 12, 0), width - 200);
  return (
    <div
      className="pointer-events-none absolute top-6 z-10 w-[188px] rounded-[14px] border border-line bg-panel px-3 py-2 text-xs shadow-[var(--shadow-float)]"
      style={{ left }}
    >
      {children}
    </div>
  );
}

export function Legend({ items, className }: { items: { label: string; color: string; dashed?: boolean }[]; className?: string }) {
  return (
    <div className={clsx("mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2", className)}>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <svg width="16" height="8" aria-hidden>
            <line x1="1" x2="15" y1="4" y2="4" stroke={i.color} strokeWidth="2" strokeDasharray={i.dashed ? "4 3" : undefined} strokeLinecap="round" />
          </svg>
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function Sparkline({ values, color = "var(--color-accent)", target, height = 36 }: { values: number[]; color?: string; target?: number; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const lo = Math.min(...values, target ?? Infinity);
  const hi = Math.max(...values, target ?? -Infinity);
  const x = (i: number) => (i / Math.max(values.length - 1, 1)) * (width - 4) + 2;
  const y = (v: number) => height - 3 - ((v - lo) / (hi - lo || 1)) * (height - 6);
  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <svg width={width} height={height} aria-hidden>
          {target != null && <line x1={0} x2={width} y1={y(target)} y2={y(target)} stroke="var(--color-ink)" strokeDasharray="3 3" opacity={0.4} />}
          <path d={values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("")} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
          <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={3} fill={color} />
        </svg>
      )}
    </div>
  );
}
