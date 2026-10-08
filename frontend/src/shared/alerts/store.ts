import { useSyncExternalStore } from "react";
import type { Incident } from "@/shared/api/types";

interface State {
  alerts: Incident[];
  openId: number | null;
}

let state: State = { alerts: [], openId: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const alerts = {
  get: () => state,
  push(inc: Incident) {
    if (state.alerts.some((a) => a.id === inc.id)) return;
    state = { ...state, alerts: [inc, ...state.alerts].slice(0, 5) };
    emit();
  },
  dismiss(id: number) {
    state = { ...state, alerts: state.alerts.filter((a) => a.id !== id) };
    emit();
  },
  update(inc: Incident) {
    if (inc.status !== "open") this.dismiss(inc.id);
  },
  open(id: number) {
    state = { alerts: state.alerts.filter((a) => a.id !== id), openId: id };
    emit();
  },
  close() {
    state = { ...state, openId: null };
    emit();
  },
  clear() {
    state = { alerts: [], openId: null };
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useAlerts(): State {
  return useSyncExternalStore(alerts.subscribe, alerts.get);
}
