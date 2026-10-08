import { useSyncExternalStore } from "react";

export interface SessionData {
  token: string;
  expiresAt: number;
  id: number;
  name: string;
  position: string;
  role: "admin" | "director" | "supervisor" | "worker";
  area: string | null;
}

const GRANTS: Record<SessionData["role"], string[]> = {
  admin: ["view", "operate", "shift", "report", "manage_data", "manage_users"],
  director: ["view", "operate", "report"],
  supervisor: ["view", "operate", "shift", "report"],
  worker: ["view", "report"],
};

export function can(s: SessionData | null, permission: string): boolean {
  return !!s && (GRANTS[s.role] ?? []).includes(permission);
}

export function homeOf(s: SessionData | null): string {
  return s?.role === "worker" ? "/work" : "/app";
}

const KEY = "allur.session.v2";
for (const old of ["takt.session"]) {
  try {
    localStorage.removeItem(old);
  } catch {
  }
}
const listeners = new Set<() => void>();

function read(): SessionData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SessionData;
    if (data.expiresAt * 1000 < Date.now() || !data.id || !data.role) {
      localStorage.removeItem(KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

let current = read();
let loggedOut = false;

function emit() {
  for (const l of listeners) l();
}

export const session = {
  get: () => current,
  wasLoggedOut: () => loggedOut,
  set(data: SessionData) {
    current = data;
    loggedOut = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
    }
    emit();
  },
  clear(opts: { logout?: boolean } = {}) {
    current = null;
    loggedOut = Boolean(opts.logout);
    try {
      localStorage.removeItem(KEY);
    } catch {
    }
    emit();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useSession(): SessionData | null {
  return useSyncExternalStore(session.subscribe, session.get, () => null);
}
