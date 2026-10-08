import { useSyncExternalStore } from "react";
import type { ChatMessage } from "@/shared/api/types";
import { session } from "@/shared/auth/session";
import { toast } from "@/shared/ui/Toaster";

interface State {
  open: boolean;
  channel: string | null;
}

let state: State = { open: false, channel: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let names: Record<string, string> = {};
let typingMap: Record<string, { userId: number; name: string; until: number }[]> = {};
const typingListeners = new Set<() => void>();
const emitTyping = () => typingListeners.forEach((l) => l());

export const chatBus = {
  get: () => state,
  open(channel?: string | null) {
    state = { open: true, channel: channel ?? state.channel };
    emit();
  },
  close() {
    state = { ...state, open: false };
    emit();
  },
  select(channel: string | null) {
    state = { ...state, channel };
    emit();
  },
  setNames(n: Record<string, string>) {
    names = n;
  },
  incoming(m: ChatMessage) {
    const me = session.get();
    if (!me || m.author_id === me.id) return;
    if (state.open && state.channel === m.channel) return;
    if (m.kind === "system") return;
    const dm = m.channel.startsWith("dm:");
    if (typeof document !== "undefined" && document.hidden && "Notification" in window && Notification.permission === "granted" && (dm || m.kind === "alert")) {
      try {
        new Notification(dm ? m.author : `${names[m.channel] ?? "Чат"}: ${m.author}`, { body: m.text || "Фото", tag: `chat-${m.channel}` });
      } catch {
      }
    }
    if (m.kind === "alert" && me.role !== "worker") return;
    toast(
      {
        title: dm ? `${m.author} · личное сообщение` : `${m.author === "Система" ? "Чат" : m.author} · ${names[m.channel] ?? "чат"}`,
        body: !m.text ? "Фото" : m.text.length > 140 ? `${m.text.slice(0, 140)}…` : m.text,
        tone: m.kind === "alert" ? "down" : "run",
      },
      6000,
    );
  },
  typing(channel: string, userId: number, name: string) {
    const now = Date.now();
    const list = (typingMap[channel] ?? []).filter((t) => t.userId !== userId && t.until > now);
    typingMap = { ...typingMap, [channel]: [...list, { userId, name, until: now + 5000 }] };
    emitTyping();
    window.setTimeout(emitTyping, 5100);
  },
  typingStop(channel: string, userId: number | null) {
    if (!typingMap[channel]) return;
    typingMap = { ...typingMap, [channel]: typingMap[channel].filter((t) => t.userId !== userId) };
    emitTyping();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useTyping(channel: string | null): string[] {
  const map = useSyncExternalStore(
    (l) => {
      typingListeners.add(l);
      return () => typingListeners.delete(l);
    },
    () => typingMap,
  );
  if (!channel) return [];
  const now = Date.now();
  return (map[channel] ?? []).filter((t) => t.until > now).map((t) => t.name);
}

export function useChatState(): State {
  return useSyncExternalStore(chatBus.subscribe, chatBus.get);
}
