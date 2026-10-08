import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { addChatMessage, applyChatRead, setPresence, updateChatMessage } from "@/shared/api/queries";
import type { ChatMessage, Floor, Incident } from "@/shared/api/types";
import { chatBus } from "@/shared/chat/bus";
import { alerts } from "@/shared/alerts/store";
import { can, session } from "@/shared/auth/session";
import { toast } from "@/shared/ui/Toaster";

type Status = "connecting" | "online" | "offline";

let floor: Floor | null = null;
let status: Status = "connecting";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

let socket: WebSocket | null = null;
let retry = 0;
let timer: number | undefined;
let stopped = true;

function url() {
  const u = new URL("/api/v1/ws", window.location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

export function connectLive(qc: QueryClient) {
  stopped = false;
  const token = session.get()?.token;
  if (!token || socket) return;
  status = "connecting";
  emit();
  const ws = new WebSocket(url());
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ token }));
  ws.onmessage = (m) => {
    let msg: { event: string; data: unknown };
    try {
      msg = JSON.parse(m.data as string);
    } catch {
      return;
    }
    if (msg.event === "hello") {
      if (retry > 0 || status === "offline") for (const k of ["chat", "chat-channels", "incidents", "shift", "my-problems"]) qc.invalidateQueries({ queryKey: [k] });
      retry = 0;
      status = "online";
      emit();
    } else if (msg.event === "floor") {
      floor = msg.data as Floor;
      emit();
    } else if (msg.event === "problem.reported") {
      const inc = msg.data as Incident;
      qc.invalidateQueries({ queryKey: ["incidents"] });
      if (can(session.get(), "view") && inc.reported_by !== session.get()?.name) alerts.push(inc);
    } else if (msg.event === "incident.created") {
      const inc = msg.data as Incident;
      qc.invalidateQueries({ queryKey: ["incidents"] });
      if (inc.severity !== "info" && inc.source !== "worker" && can(session.get(), "view")) {
        toast({ title: inc.title, body: inc.details, tone: inc.severity === "critical" ? "down" : "blocked" }, inc.severity === "critical" ? 9000 : 6000);
      }
    } else if (msg.event === "journal") {
      qc.invalidateQueries({ queryKey: ["journal"] });
    } else if (msg.event === "incident.updated") {
      alerts.update(msg.data as Incident);
      for (const k of ["incidents", "incident", "my-problems"]) qc.invalidateQueries({ queryKey: [k] });
    } else if (msg.event === "shift.session") {
      for (const k of ["shift", "shift-history"]) qc.invalidateQueries({ queryKey: [k] });
    } else if (msg.event === "users.request") {
      const d = msg.data as { id: number; name?: string; role_name?: string; decided?: string };
      qc.invalidateQueries({ queryKey: ["users"] });
      if (!d.decided && can(session.get(), "manage_users")) toast({ title: "Новая заявка на доступ", body: `${d.name} — ${d.role_name?.toLowerCase()}. Подтвердите в разделе «Сотрудники».`, tone: "blocked" }, 9000);
    } else if (msg.event === "shift.setup") {
      for (const k of ["shift-setup", "shift"]) qc.invalidateQueries({ queryKey: [k] });
    } else if (msg.event === "chat.message") {
      const m = msg.data as ChatMessage;
      addChatMessage(qc, m);
      chatBus.typingStop(m.channel, m.author_id);
      chatBus.incoming(m);
    } else if (msg.event === "chat.updated") {
      updateChatMessage(qc, msg.data as ChatMessage);
    } else if (msg.event === "chat.read") {
      const d = msg.data as { channel: string; user_id: number; last_id: number };
      if (d.user_id !== session.get()?.id) applyChatRead(qc, d.channel, d.last_id);
    } else if (msg.event === "chat.typing") {
      const d = msg.data as { channel: string; user_id: number; name: string };
      chatBus.typing(d.channel, d.user_id, d.name);
    } else if (msg.event === "db.status") {
      qc.setQueryData(["db-status"], (old: object | undefined) => ({ ...(old ?? {}), ...(msg.data as object) }));
      qc.invalidateQueries();
    } else if (msg.event === "presence") {
      const d = msg.data as { user_id: number; online: boolean };
      setPresence(qc, d.user_id, d.online);
    } else if (msg.event === "params.changed") {
      for (const k of ["params", "advice", "plant", "shift-forecast"]) qc.invalidateQueries({ queryKey: [k] });
    } else if (msg.event === "floor.layout") {
      for (const k of ["floor-layout", "layouts"]) qc.invalidateQueries({ queryKey: [k] });
    } else if (msg.event === "shift.closed") {
      const d = msg.data as { shift: number; finished: number };
      if (can(session.get(), "view")) toast({ title: `Смена ${d.shift} закрыта`, body: `Выпущено ${d.finished} автомобилей. Итоги записаны в историю.`, tone: "run" });
      for (const k of ["overview", "insights", "checks", "data-summary", "shift", "shift-history"]) qc.invalidateQueries({ queryKey: [k] });
    }
  };
  ws.onclose = (e) => {
    socket = null;
    status = "offline";
    emit();
    if (e.code === 4401) {
      session.clear();
      return;
    }
    if (stopped) return;
    retry = Math.min(retry + 1, 6);
    timer = window.setTimeout(() => connectLive(qc), 500 * 2 ** retry);
  };
}

export function sendLive(data: unknown) {
  if (socket && socket.readyState === WebSocket.OPEN && status === "online") socket.send(JSON.stringify(data));
}

export function disconnectLive() {
  stopped = true;
  alerts.clear();
  window.clearTimeout(timer);
  socket?.close();
  socket = null;
}

export function useFloor(): Floor | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => floor,
  );
}

export function useLiveStatus(): Status {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

export function seedFloor(f: Floor) {
  if (!floor) {
    floor = f;
    emit();
  }
}
