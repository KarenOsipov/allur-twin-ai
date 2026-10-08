import { useSyncExternalStore } from "react";
import type { SandboxResult } from "@/shared/api/types";

const KEY = "allur.sandbox";

interface State {
  result: SandboxResult | null;
  playhead: number;
  playing: boolean;
  speed: number;
}

let state: State = { result: null, playhead: 0, playing: false, speed: 120 };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  emit();
};

export const SIM_SPEEDS = [60, 240, 900] as const;
export const TICK_MS = 120;

let timer: number | undefined;
function loop() {
  window.clearTimeout(timer);
  if (!state.playing || !state.result) return;
  timer = window.setTimeout(() => {
    const r = state.result;
    if (!r) return;
    const step = (state.speed * TICK_MS) / 1000 / r.frame_every_s;
    const next = Math.min(state.playhead + step, r.frames.length - 1);
    set({ playhead: next, playing: next < r.frames.length - 1 });
    loop();
  }, TICK_MS);
}

let onChange: (() => void) | null = null;
export function onSimChange(fn: () => void) {
  onChange = fn;
}

export const sim = {
  get: () => state,
  sandboxId: () => state.result?.id ?? null,
  storedId: () => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  enter(result: SandboxResult, opts: { autoplay?: boolean } = {}) {
    try {
      sessionStorage.setItem(KEY, result.id);
    } catch {
    }
    set({ result, playhead: 0, playing: opts.autoplay ?? true });
    onChange?.();
    loop();
  },
  exit() {
    window.clearTimeout(timer);
    try {
      sessionStorage.removeItem(KEY);
    } catch {
    }
    if (state.result) {
      set({ result: null, playhead: 0, playing: false });
      onChange?.();
    }
  },
  play() {
    if (!state.result) return;
    const atEnd = state.playhead >= state.result.frames.length - 1;
    set({ playing: true, playhead: atEnd ? 0 : state.playhead });
    loop();
  },
  pause() {
    set({ playing: false });
    window.clearTimeout(timer);
  },
  seek(index: number) {
    if (!state.result) return;
    set({ playhead: Math.max(0, Math.min(index, state.result.frames.length - 1)) });
  },
  setSpeed(speed: number) {
    set({ speed });
  },
  frameMs() {
    return TICK_MS;
  },
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSim(): State {
  return useSyncExternalStore(subscribe, () => state);
}

export function useSandboxId(): string | null {
  return useSyncExternalStore(subscribe, () => state.result?.id ?? null);
}

export function useSimFrame() {
  const s = useSim();
  if (!s.result) return null;
  return s.result.frames[Math.floor(s.playhead)] ?? null;
}
