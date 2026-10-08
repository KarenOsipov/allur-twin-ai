import type { Kind, PlantEdge, PlantNode, SplitMode } from "./model";

export type EqState = "run" | "idle" | "down";
export type NodeState = "run" | "starved" | "blocked" | "down" | "slow" | "idle";

interface Item {
  id: number;
  defect: boolean;
}

interface EqRt {
  code: string;
  critical: boolean;
  mtbf_h: number;
  mttr_min: number;
  state: EqState;
  until: number;
  runSinceRepair: number;
  forced: boolean;
  temp: number;
  vib: number;
  failures: number;
}

interface Slot {
  item: Item | null;
  progress: number;
  target: number;
  done: boolean;
  reject: boolean;
}

interface NodeRt {
  id: string;
  kind: Kind;
  name: string;
  preds: string[];
  succs: string[];
  succHandle: Map<string, string>;
  out: Item[];
  ng: Item[];
  lanes: Map<string, Item[]>;
  sent: Map<string, number>;
  transit: { item: Item; ready: number }[];
  outCap: number;
  slots: Slot[];
  eq: EqRt[];
  cycle: number;
  variability: number;
  defect: number;
  detect: number;
  rework: boolean;
  rate: number;
  stockCap: number;
  supplyCredit: number;
  supplyPausedUntil: number;
  capacity: number;
  splitMode: SplitMode;
  shares: Record<string, number>;
  travel: number;
  produced: number;
  scrapped: number;
  rejected: number;
  reworked: number;
  activeS: number;
  totalS: number;
  downS: number;
  rr: number;
  state: NodeState;
  recent: number[];
}

export interface EqStats {
  code: string;
  critical: boolean;
  state: EqState;
  temp: number;
  vib: number;
  wear: number;
  alarm: boolean;
  until: number | null;
  failures: number;
}

export interface NodeStats {
  state: NodeState;
  produced: number;
  scrapped: number;
  rejected: number;
  reworked: number;
  wip: number;
  queue: number;
  utilization: number;
  perHour: number;
  stock?: number;
  supplyPaused?: boolean;
  transit?: number;
  lanes?: Record<string, number>;
  eq: EqStats[];
  downCount: number;
  alarmCount: number;
}

export interface Problem {
  node: string;
  nodeName: string;
  kind: "down" | "alarm" | "starved_supply";
  text: string;
  equipment?: string;
}

export interface SimStats {
  t: number;
  nodes: Record<string, NodeStats>;
  output: number;
  perHour: number;
  wip: number;
  equipment: number;
  down: number;
  alarms: number;
  bottleneck: string | null;
  scrapped: number;
  problems: Problem[];
  flowing: Set<string>;
  edgeRate: Record<string, number>;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3600;
const PROCESS: Kind[] = ["station", "assembly", "inspection"];

export class PlantSim {
  t = 0;
  private nodes = new Map<string, NodeRt>();
  private order: NodeRt[] = [];
  private rand: () => number;
  private itemSeq = 1;
  private flows = new Map<string, number[]>();

  constructor(nodes: PlantNode[], edges: PlantEdge[], seed = 42) {
    this.rand = rng(seed);
    this.nodes = this.build(nodes, edges, true);
    this.order = this.topo().reverse();
  }

  private build(nodes: PlantNode[], edges: PlantEdge[], fresh: boolean): Map<string, NodeRt> {
    const map = new Map<string, NodeRt>();
    for (const n of nodes) {
      const d = n.data;
      const parallel = Math.max(1, Math.round(d.parallel ?? 1));
      const cap = Math.max(1, d.capacity ?? 6);
      const rt: NodeRt = {
        id: n.id,
        kind: d.kind,
        name: d.name,
        preds: [],
        succs: [],
        succHandle: new Map(),
        out: [],
        ng: [],
        lanes: new Map(),
        sent: new Map(),
        transit: [],
        outCap: d.kind === "buffer" || d.kind === "transport" || d.kind === "splitter" ? cap : d.kind === "source" ? Math.max(1, d.stock_cap ?? 60) : parallel,
        slots: PROCESS.includes(d.kind) ? Array.from({ length: parallel }, () => ({ item: null, progress: 0, target: 0, done: false, reject: false })) : [],
        eq: (d.equipment ?? []).map((e) => ({
          code: e.code,
          critical: e.critical,
          mtbf_h: Math.max(1, e.mtbf_h),
          mttr_min: Math.max(1, e.mttr_min),
          state: "idle" as EqState,
          until: 0,
          runSinceRepair: this.rand() * e.mtbf_h * HOUR * 0.6,
          forced: false,
          temp: 30,
          vib: 1,
          failures: 0,
        })),
        cycle: Math.max(5, d.cycle_s ?? 120),
        variability: (d.variability ?? 5) / 100,
        defect: (d.defect_pct ?? 0) / 100,
        detect: (d.detect_pct ?? 0) / 100,
        rework: Boolean(d.rework),
        rate: d.rate_per_hour ?? 0,
        stockCap: d.stock_cap ?? 60,
        supplyCredit: 0,
        supplyPausedUntil: 0,
        capacity: cap,
        splitMode: d.split_mode ?? "free",
        shares: d.shares ?? {},
        travel: Math.max(1, d.travel_s ?? 60),
        produced: 0,
        scrapped: 0,
        rejected: 0,
        reworked: 0,
        activeS: 0,
        totalS: 0,
        downS: 0,
        rr: 0,
        state: "idle",
        recent: [],
      };
      if (fresh && (d.kind === "source" || d.kind === "buffer")) rt.out = Array.from({ length: Math.min(d.stock_init ?? 0, rt.outCap) }, () => this.item());
      map.set(n.id, rt);
    }
    for (const e of edges) {
      const a = map.get(e.source);
      const b = map.get(e.target);
      if (!a || !b || a === b) continue;
      if (!a.succs.includes(b.id)) a.succs.push(b.id);
      if (!b.preds.includes(a.id)) b.preds.push(a.id);
      a.succHandle.set(b.id, e.sourceHandle === "ng" ? "ng" : "ok");
    }
    for (const n of map.values()) {
      if (n.kind === "splitter") for (const s of n.succs) n.lanes.set(s, []);
    }
    return map;
  }

  reconfigure(nodes: PlantNode[], edges: PlantEdge[]) {
    const old = this.nodes;
    const next = this.build(nodes, edges, false);
    for (const n of next.values()) {
      const o = old.get(n.id);
      if (!o) {
        const src = nodes.find((x) => x.id === n.id)?.data;
        if (src && (n.kind === "source" || n.kind === "buffer")) n.out = Array.from({ length: Math.min(src.stock_init ?? 0, n.outCap) }, () => this.item());
        continue;
      }
      const items: Item[] = [...o.out, ...[...o.lanes.values()].flat(), ...o.transit.map((x) => x.item)];
      if (n.slots.length) {
        o.slots.forEach((s, i) => {
          if (i < n.slots.length) n.slots[i] = { ...s };
          else if (s.item) items.push(s.item);
        });
      } else {
        for (const s of o.slots) if (s.item) items.push(s.item);
      }
      if (n.kind === "transport" && o.kind === "transport") {
        n.transit = o.transit.slice(0, n.capacity);
        items.splice(0, items.length, ...o.out);
      }
      if (n.kind === "splitter" && o.kind === "splitter" && n.splitMode === o.splitMode && n.splitMode !== "free") {
        for (const [k, q] of o.lanes) if (n.lanes.has(k)) n.lanes.set(k, q.slice());
        items.splice(0, items.length, ...o.out, ...[...o.lanes.entries()].filter(([k]) => !n.lanes.has(k)).flatMap(([, q]) => q));
        for (const [k, v] of o.sent) n.sent.set(k, v);
      }
      n.out = items.slice(0, n.kind === "sink" ? 0 : Math.max(n.outCap, items.length));
      n.ng = o.ng;
      for (const e of n.eq) {
        const oe = o.eq.find((x) => x.code === e.code);
        if (oe) Object.assign(e, { state: oe.state, until: oe.until, runSinceRepair: oe.runSinceRepair, forced: oe.forced, temp: oe.temp, vib: oe.vib, failures: oe.failures });
      }
      n.produced = o.produced;
      n.scrapped = o.scrapped;
      n.rejected = o.rejected;
      n.reworked = o.reworked;
      n.activeS = o.activeS;
      n.totalS = o.totalS;
      n.downS = o.downS;
      n.recent = o.recent;
      n.supplyCredit = o.supplyCredit;
      n.supplyPausedUntil = o.supplyPausedUntil;
      n.state = o.state;
    }
    this.nodes = next;
    this.order = this.topo().reverse();
    for (const key of [...this.flows.keys()]) {
      const [a, b] = key.split(">");
      if (!next.get(a)?.succs.includes(b)) this.flows.delete(key);
    }
  }

  private item(): Item {
    return { id: this.itemSeq++, defect: false };
  }

  private topo(): NodeRt[] {
    const indeg = new Map<string, number>();
    this.nodes.forEach((n) => indeg.set(n.id, n.preds.length));
    const queue = [...this.nodes.values()].filter((n) => n.preds.length === 0);
    const out: NodeRt[] = [];
    const seen = new Set<string>();
    while (queue.length) {
      const n = queue.shift() as NodeRt;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
      for (const s of n.succs) {
        const v = (indeg.get(s) ?? 0) - 1;
        indeg.set(s, v);
        if (v <= 0) queue.push(this.nodes.get(s) as NodeRt);
      }
    }
    this.nodes.forEach((n) => !seen.has(n.id) && out.push(n));
    return out;
  }

  fail(nodeId: string, code: string, minutes: number) {
    const e = this.nodes.get(nodeId)?.eq.find((x) => x.code === code);
    if (!e || e.state === "down") return;
    e.state = "down";
    e.until = this.t + minutes * 60;
    e.forced = true;
    e.failures += 1;
  }

  repair(nodeId: string, code: string) {
    const e = this.nodes.get(nodeId)?.eq.find((x) => x.code === code);
    if (!e) return;
    e.state = "idle";
    e.until = 0;
    e.runSinceRepair = 0;
    e.forced = false;
  }

  pauseSupply(nodeId: string, minutes: number) {
    const n = this.nodes.get(nodeId);
    if (n) n.supplyPausedUntil = this.t + minutes * 60;
  }

  step(dt: number) {
    this.t += dt;
    for (const n of this.order) {
      n.totalS += dt;
      switch (n.kind) {
        case "sink":
          this.pullAll(n);
          n.state = n.preds.length ? "run" : "idle";
          break;
        case "buffer":
          while (n.out.length < n.outCap) {
            const it = this.pullOne(n);
            if (!it) break;
            n.out.push(it);
          }
          n.state = n.out.length >= n.outCap ? "blocked" : n.out.length === 0 ? "starved" : "run";
          break;
        case "splitter":
          this.split(n);
          break;
        case "transport":
          this.carry(n);
          break;
        case "source":
          this.supply(n, dt);
          break;
        default:
          this.process(n, dt);
      }
    }
  }

  private supply(n: NodeRt, dt: number) {
    if (this.t < n.supplyPausedUntil) {
      n.state = n.out.length ? "run" : "starved";
      return;
    }
    n.supplyCredit += (n.rate / HOUR) * dt;
    while (n.supplyCredit >= 1 && n.out.length < n.outCap) {
      n.out.push(this.item());
      n.supplyCredit -= 1;
    }
    if (n.out.length >= n.outCap) n.supplyCredit = Math.min(n.supplyCredit, 1);
    n.state = n.out.length >= n.outCap ? "blocked" : n.out.length === 0 ? "starved" : "run";
  }

  private queueOf(from: NodeRt, by: NodeRt): Item[] {
    if (from.kind === "inspection" && from.succHandle.get(by.id) === "ng") return from.ng;
    if (from.kind === "splitter" && from.splitMode !== "free") return from.lanes.get(by.id) ?? [];
    return from.out;
  }

  private take(from: NodeRt, by: NodeRt): Item | null {
    const it = this.queueOf(from, by).shift() ?? null;
    if (it) {
      const key = `${from.id}>${by.id}`;
      const list = this.flows.get(key) ?? [];
      list.push(this.t);
      if (list.length > 30) list.shift();
      this.flows.set(key, list);
      if (from.kind !== "source" && from.kind !== "buffer" && !(from.kind === "inspection" && from.succHandle.get(by.id) === "ng")) this.mark(from);
    }
    return it;
  }

  private mark(n: NodeRt) {
    n.produced += 1;
    n.recent.push(this.t);
    if (n.recent.length > 40) n.recent.shift();
  }

  private pullOne(n: NodeRt): Item | null {
    const k = n.preds.length;
    for (let i = 0; i < k; i++) {
      const p = this.nodes.get(n.preds[(n.rr + i) % k]) as NodeRt;
      if (this.queueOf(p, n).length) {
        n.rr = (n.rr + i + 1) % k;
        return this.take(p, n);
      }
    }
    return null;
  }

  private pullAll(n: NodeRt) {
    for (const id of n.preds) {
      const p = this.nodes.get(id) as NodeRt;
      while (this.queueOf(p, n).length) {
        this.take(p, n);
        this.mark(n);
      }
    }
  }

  private split(n: NodeRt) {
    const lanes = [...n.lanes.keys()];
    if (n.splitMode === "free" || lanes.length === 0) {
      while (n.out.length < n.outCap) {
        const it = this.pullOne(n);
        if (!it) break;
        n.out.push(it);
      }
      n.state = n.out.length >= n.outCap ? "blocked" : n.out.length === 0 ? "starved" : "run";
      return;
    }
    const laneCap = Math.max(1, Math.ceil(n.capacity / lanes.length));
    let moved = false;
    for (let guard = 0; guard < n.capacity * 2; guard++) {
      const target = this.chooseLane(n, lanes, laneCap);
      if (!target) break;
      const it = this.pullOne(n);
      if (!it) break;
      (n.lanes.get(target) as Item[]).push(it);
      n.sent.set(target, (n.sent.get(target) ?? 0) + 1);
      moved = true;
    }
    const held = lanes.reduce((s, k) => s + (n.lanes.get(k)?.length ?? 0), 0);
    const full = lanes.every((k) => (n.lanes.get(k)?.length ?? 0) >= laneCap);
    n.state = full ? "blocked" : held === 0 && !moved ? "starved" : "run";
  }

  private chooseLane(n: NodeRt, lanes: string[], laneCap: number): string | null {
    const open = lanes.filter((k) => (n.lanes.get(k)?.length ?? 0) < laneCap);
    if (!open.length) return null;
    if (n.splitMode === "rr") {
      for (let i = 0; i < lanes.length; i++) {
        const k = lanes[(n.rr + i) % lanes.length];
        if (open.includes(k)) {
          n.rr = (n.rr + i + 1) % lanes.length;
          return k;
        }
      }
      return null;
    }
    const w = (k: string) => Math.max(0, n.shares[k] ?? 1);
    const totalW = lanes.reduce((s, k) => s + w(k), 0) || 1;
    const sent = lanes.reduce((s, k) => s + (n.sent.get(k) ?? 0), 0) + 1;
    let best: string | null = null;
    let gap = -Infinity;
    for (const k of open) {
      if (w(k) <= 0) continue;
      const g = (w(k) / totalW) * sent - (n.sent.get(k) ?? 0);
      if (g > gap) {
        gap = g;
        best = k;
      }
    }
    return best;
  }

  private carry(n: NodeRt) {
    while (n.transit.length && n.transit[0].ready <= this.t && n.out.length < n.capacity) {
      n.out.push((n.transit.shift() as { item: Item }).item);
    }
    let pulled = false;
    while (n.transit.length + n.out.length < n.capacity) {
      const it = this.pullOne(n);
      if (!it) break;
      n.transit.push({ item: it, ready: this.t + n.travel });
      pulled = true;
    }
    const waiting = n.transit.length && n.transit[0].ready <= this.t;
    n.state = waiting ? "blocked" : n.transit.length || pulled ? "run" : n.out.length ? "blocked" : "starved";
  }

  private equipment(n: NodeRt, dt: number, working: boolean) {
    for (const e of n.eq) {
      if (e.state === "down") {
        if (this.t >= e.until) {
          e.state = "idle";
          e.runSinceRepair = 0;
          e.forced = false;
        }
      } else {
        e.state = working ? "run" : "idle";
        if (working) {
          e.runSinceRepair += dt;
          const wear = e.runSinceRepair / (e.mtbf_h * HOUR);
          const hazard = (dt / (e.mtbf_h * HOUR)) * (0.4 + 1.6 * wear);
          if (this.rand() < hazard) {
            e.state = "down";
            const repair = Math.max(5, e.mttr_min * (0.6 + this.rand() * 0.8)) * 60;
            e.until = this.t + repair;
            e.failures += 1;
          }
        }
      }
      const wear = e.runSinceRepair / (e.mtbf_h * HOUR);
      const targetTemp = e.state === "run" ? 48 + 22 * Math.min(wear, 1.5) : e.state === "down" ? 32 : 38;
      e.temp += (targetTemp - e.temp) * Math.min(1, dt / 300) + (this.rand() - 0.5) * 0.4;
      const targetVib = (e.state === "run" ? 1.4 : 0.4) + 3.2 * Math.max(0, wear - 0.4);
      e.vib += (targetVib - e.vib) * Math.min(1, dt / 200) + (this.rand() - 0.5) * 0.05;
    }
  }

  private process(n: NodeRt, dt: number) {
    const stop = n.eq.some((e) => e.critical && e.state === "down");
    const slow = n.eq.filter((e) => !e.critical && e.state === "down").length;
    const speed = 1 / (1 + 0.35 * slow);
    const ngOut = n.kind === "inspection" && [...n.succHandle.values()].includes("ng");
    let active = false;
    let blocked = 0;
    let starved = 0;
    if (!stop) {
      for (const s of n.slots) {
        if (s.done) {
          if (s.reject) {
            if (!ngOut) {
              n.scrapped += 1;
              s.item = null;
              s.done = false;
              s.reject = false;
            } else if (n.ng.length < n.outCap) {
              n.ng.push(s.item as Item);
              n.rejected += 1;
              s.item = null;
              s.done = false;
              s.reject = false;
            } else {
              blocked += 1;
              continue;
            }
          } else if (n.out.length < n.outCap) {
            n.out.push(s.item as Item);
            s.item = null;
            s.done = false;
          } else {
            blocked += 1;
            continue;
          }
        }
        if (!s.item) {
          const it = n.kind === "assembly" ? this.pullAssembly(n) : this.pullOne(n);
          if (!it) {
            starved += 1;
            continue;
          }
          s.item = it;
          s.progress = 0;
          s.target = n.cycle * Math.exp((this.rand() - 0.5) * 2 * n.variability);
        }
        active = true;
        s.progress += dt * speed;
        if (s.progress >= s.target) {
          const it = s.item as Item;
          if (n.kind === "inspection") {
            s.reject = it.defect && this.rand() < n.detect;
          } else {
            if (n.rework && it.defect) {
              it.defect = false;
              n.reworked += 1;
            }
            if (this.rand() < n.defect) it.defect = true;
          }
          s.done = true;
        }
      }
    } else {
      n.downS += dt;
    }
    if (active || stop) n.activeS += dt;
    this.equipment(n, dt, active && !stop);
    n.state = stop ? "down" : active ? (slow ? "slow" : "run") : blocked ? "blocked" : starved ? "starved" : "idle";
  }

  private pullAssembly(n: NodeRt): Item | null {
    const ps = n.preds.map((id) => this.nodes.get(id) as NodeRt);
    if (!ps.length || ps.some((p) => this.queueOf(p, n).length === 0)) return null;
    const items = ps.map((p) => this.take(p, n) as Item);
    const it = this.item();
    it.defect = items.some((x) => x.defect);
    return it;
  }

  stats(): SimStats {
    const nodes: Record<string, NodeStats> = {};
    const problems: Problem[] = [];
    let wip = 0;
    let output = 0;
    let perHourOut = 0;
    let eqTotal = 0;
    let down = 0;
    let alarms = 0;
    let scrapped = 0;
    let best: NodeRt | null = null;
    let bestU = -1;
    for (const n of this.nodes.values()) {
      const inSlots = n.slots.filter((s) => s.item).length;
      const lanesHeld = [...n.lanes.values()].reduce((s, q) => s + q.length, 0);
      const q = n.out.length + n.ng.length + lanesHeld;
      if (n.kind !== "source" && n.kind !== "sink") wip += inSlots + q + n.transit.length;
      const util =
        n.kind === "transport"
          ? ((n.transit.length + n.out.length) / Math.max(1, n.capacity)) * 100
          : n.totalS
            ? (n.activeS / n.totalS) * 100
            : 0;
      const ph = this.rate(n);
      const eq = n.eq.map((e) => {
        const wear = e.runSinceRepair / (e.mtbf_h * HOUR);
        const alarm = e.state !== "down" && (e.vib > 3.2 || e.temp > 70);
        return { code: e.code, critical: e.critical, state: e.state, temp: e.temp, vib: e.vib, wear, alarm, until: e.state === "down" ? e.until : null, failures: e.failures };
      });
      const downCount = eq.filter((e) => e.state === "down").length;
      const alarmCount = eq.filter((e) => e.alarm).length;
      eqTotal += eq.length;
      down += downCount;
      alarms += alarmCount;
      scrapped += n.scrapped;
      for (const e of eq) {
        if (e.state === "down") {
          const left = Math.max(0, Math.round(((e.until ?? this.t) - this.t) / 60));
          problems.push({ node: n.id, nodeName: n.name, kind: "down", equipment: e.code, text: `${e.code}: отказ, ремонт ещё ~${left} мин${e.critical ? " — участок стоит" : " — участок замедлен"}` });
        } else if (e.alarm) {
          problems.push({ node: n.id, nodeName: n.name, kind: "alarm", equipment: e.code, text: `${e.code}: ${e.vib > 3.2 ? `вибрация ${e.vib.toFixed(1)} мм/с` : `нагрев ${Math.round(e.temp)} °C`} — вероятен отказ, нужен осмотр` });
        }
      }
      if (n.kind === "source" && this.t < n.supplyPausedUntil) {
        problems.push({ node: n.id, nodeName: n.name, kind: "starved_supply", text: `${n.name}: поставка остановлена ещё ~${Math.round((n.supplyPausedUntil - this.t) / 60)} мин` });
      }
      if (n.kind === "sink") {
        output += n.produced;
        perHourOut += ph;
      }
      if (PROCESS.includes(n.kind) && util > bestU) {
        bestU = util;
        best = n;
      }
      nodes[n.id] = {
        state: n.state,
        produced: n.produced,
        scrapped: n.scrapped,
        rejected: n.rejected,
        reworked: n.reworked,
        wip: inSlots + q + n.transit.length,
        queue: q,
        utilization: util,
        perHour: ph,
        stock: n.kind === "source" || n.kind === "buffer" || n.kind === "splitter" ? q : undefined,
        supplyPaused: n.kind === "source" ? this.t < n.supplyPausedUntil : undefined,
        transit: n.kind === "transport" ? n.transit.length : undefined,
        lanes: n.kind === "splitter" ? Object.fromEntries([...n.lanes.keys()].map((k) => [k, n.sent.get(k) ?? 0])) : undefined,
        eq,
        downCount,
        alarmCount,
      };
    }
    const flowing = new Set<string>();
    const edgeRate: Record<string, number> = {};
    this.flows.forEach((list, key) => {
      const last = list[list.length - 1] ?? -Infinity;
      if (this.t - last < 600) flowing.add(key);
      edgeRate[key] = list.length >= 2 ? ((list.length - 1) / Math.max(this.t - list[0], 60)) * HOUR : 0;
    });
    problems.sort((a, b) => (a.kind === "down" ? 0 : 1) - (b.kind === "down" ? 0 : 1));
    return {
      t: this.t,
      nodes,
      output,
      perHour: perHourOut,
      wip,
      equipment: eqTotal,
      down,
      alarms,
      bottleneck: this.t > 1800 && best ? best.id : null,
      scrapped,
      problems,
      flowing,
      edgeRate,
    };
  }

  private rate(n: NodeRt): number {
    const r = n.recent;
    if (r.length < 2) return 0;
    const span = Math.max(this.t - r[0], 60);
    return ((r.length - 1) / span) * HOUR;
  }
}
