import { createContext, useContext, useSyncExternalStore } from "react";
import type { NodeStats, SimStats } from "./engine";

export interface StatsStore {
  get(): SimStats | null;
  set(s: SimStats | null): void;
  subscribe(l: () => void): () => void;
}

export function createStatsStore(): StatsStore {
  let stats: SimStats | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => stats,
    set(s) {
      stats = s;
      listeners.forEach((l) => l());
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export const builderStats = createStatsStore();

const StatsContext = createContext<StatsStore>(builderStats);
export const StatsProvider = StatsContext.Provider;
export const useStatsStore = () => useContext(StatsContext);

export function useBuilderStats(): SimStats | null {
  const s = useStatsStore();
  return useSyncExternalStore(s.subscribe, s.get);
}

export function useNodeStats(id: string): NodeStats | undefined {
  const s = useStatsStore();
  return useSyncExternalStore(s.subscribe, () => s.get()?.nodes[id]);
}

export function useIsBottleneck(id: string): boolean {
  const s = useStatsStore();
  return useSyncExternalStore(s.subscribe, () => s.get()?.bottleneck === id);
}

export function useEdgeFlow(key: string): { on: boolean; rate: number } {
  const s = useStatsStore();
  const on = useSyncExternalStore(s.subscribe, () => s.get()?.flowing.has(key) ?? false);
  const rate = useSyncExternalStore(s.subscribe, () => Math.round(s.get()?.edgeRate[key] ?? 0));
  return { on, rate };
}
