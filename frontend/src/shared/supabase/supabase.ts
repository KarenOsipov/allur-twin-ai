import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { request } from "@/shared/api/client";
import type { ChatMessage, LoginOut, Role, SystemConfig } from "@/shared/api/types";

let client: SupabaseClient | null = null;
let initPromise: Promise<SupabaseClient | null> | null = null;
let chatChannel: RealtimeChannel | null = null;

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;

async function createSupabaseClient(url: string, anonKey: string): Promise<SupabaseClient> {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

export async function ensureSupabase(): Promise<SupabaseClient | null> {
  if (client) return client;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const envUrl = env.VITE_SUPABASE_URL;
    const envKey = env.VITE_SUPABASE_ANON_KEY;
    if (envUrl && envKey) {
      client = await createSupabaseClient(envUrl, envKey);
      return client;
    }

    try {
      const response = await fetch("/api/v1/system/config");
      if (!response.ok) return null;
      const config: SystemConfig = await response.json();
      if (!config.supabase?.enabled || !config.supabase.url || !config.supabase.anon_key) return null;
      client = await createSupabaseClient(config.supabase.url, config.supabase.anon_key);
      return client;
    } catch (error) {
      console.warn("Supabase configuration fetch failed:", error);
      return null;
    }
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

export async function loginWithSupabase(login: string, password: string): Promise<LoginOut | null> {
  const supabase = await ensureSupabase();
  if (!supabase) return null;

  const normalizedLogin = login.trim().toLowerCase();
  const email = normalizedLogin.includes("@") ? normalizedLogin : `${normalizedLogin}@allur.local`;
  let { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error && /^\d{4,5}$/.test(password)) {
    const retry = await supabase.auth.signInWithPassword({ email, password: `Allur-${password}` });
    data = retry.data;
    error = retry.error;
  }
  if (error) throw error;
  if (!data.session) return null;

  try {
    return await request<LoginOut>("/auth/supabase-session", {
      method: "POST",
      body: { access_token: data.session.access_token },
    });
  } catch (exchangeError) {
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) console.warn("Supabase Auth sign-out failed:", signOutError);
    throw exchangeError;
  }
}

export async function signOutSupabase(): Promise<void> {
  const supabase = await ensureSupabase();
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) console.warn("Supabase Auth sign-out failed:", error);
}

export async function hasSupabaseSession(): Promise<boolean> {
  const supabase = await ensureSupabase();
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  return Boolean(data.session?.access_token);
}

export interface RealtimeChatCallbacks {
  onMessage: (message: ChatMessage) => void;
  onUpdate: (message: ChatMessage) => void;
  onStatus: (connected: boolean) => void;
}

function toChatMessage(raw: Record<string, unknown>): ChatMessage | null {
  if (raw.id == null || !raw.channel) return null;
  return {
    id: Number(raw.id),
    channel: String(raw.channel),
    at: String(raw.created_at || new Date().toISOString()),
    author_id: raw.author_id == null ? null : Number(raw.author_id),
    author: String(raw.author || "Коллега"),
    position: String(raw.position || ""),
    role: (raw.role as Role) || "worker",
    kind: (raw.kind as ChatMessage["kind"]) || "text",
    text: String(raw.text || ""),
    ref: (raw.ref as ChatMessage["ref"]) || null,
    reply_to: null,
    edited_at: raw.edited_at ? String(raw.edited_at) : null,
    deleted: Boolean(raw.deleted),
  };
}

export function subscribeSupabaseChat(callbacks: RealtimeChatCallbacks): (() => void) | null {
  const supabase = client;
  if (!supabase) return null;

  if (chatChannel) void supabase.removeChannel(chatChannel);
  const channel = supabase.channel("allur-chat-events");
  chatChannel = channel;

  channel
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload) => {
      const message = toChatMessage(payload.new as Record<string, unknown>);
      if (message) callbacks.onMessage(message);
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_messages" }, (payload) => {
      const message = toChatMessage(payload.new as Record<string, unknown>);
      if (message) callbacks.onUpdate(message);
    })
    .subscribe((status) => callbacks.onStatus(status === "SUBSCRIBED"));

  return () => {
    callbacks.onStatus(false);
    if (chatChannel === channel) chatChannel = null;
    void supabase.removeChannel(channel);
  };
}
