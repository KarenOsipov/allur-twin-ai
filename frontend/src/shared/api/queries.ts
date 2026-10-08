import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can, session, useSession } from "@/shared/auth/session";
import { useSandboxId } from "@/shared/sim/store";
import { request } from "./client";
import type {
  DbStatus,
  ChatChannel,
  ChatMessage,
  ChatPeer,
  ShiftPlanSetup,
  ShiftSetup,
  Answer,
  DataCheck,
  DataSummary,
  Economics,
  Floor,
  ImportResult,
  IncidentList,
  Insights,
  Me,
  Overview,
  Plant,
  Preset,
  ShiftForecast,
  UsersOut,
  StaffFull,
  ShiftInfo,
  ShiftSession,
  ProblemInput,
  ProblemOut,
  WorkerOverview,
  Impact,
  AdviceOut,
  PlantEconomy,
  LineParams,
  LayoutMeta,
  FloorLayout,
  Incident,
  SandboxResult,
  JournalList,
  SimEventInput,
  ScenarioInput,
  WhatIfResult,
} from "./types";

export const keys = {
  plant: ["plant"] as const,
  floor: ["floor"] as const,
  overview: (days: number) => ["overview", days] as const,
  insights: ["insights"] as const,
  incidents: (status: string, severity: string) => ["incidents", status, severity] as const,
  checks: ["checks"] as const,
  summary: ["data-summary"] as const,
  table: (kind: string, source: string) => ["table", kind, source] as const,
};

export const useStaff = () => useQuery({ queryKey: ["login-users"], queryFn: () => request<UsersOut>("/auth/users"), staleTime: 60_000 });

export function useMe() {
  const s = useSession();
  return useQuery({ queryKey: ["me", s?.token], queryFn: () => request<Me>("/auth/me"), enabled: !!s, staleTime: 60_000 });
}

export const usePlant = () => useQuery({ queryKey: keys.plant, queryFn: () => request<Plant>("/plant"), staleTime: 5 * 60_000 });

export const useFloorSnapshot = () => useQuery({ queryKey: keys.floor, queryFn: () => request<Floor>("/floor"), staleTime: 2_000 });

export const useShiftForecast = () =>
  useQuery({
    queryKey: ["shift-forecast"],
    queryFn: () => request<ShiftForecast>("/floor/forecast"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

const scope = (sb: string | null) => sb ?? "live";

export function useOverview(days: number) {
  const sb = useSandboxId();
  return useQuery({ queryKey: [...keys.overview(days), scope(sb)], queryFn: () => request<Overview>("/kpi/overview", { query: { days } }), staleTime: 30_000 });
}

export function useInsights() {
  const sb = useSandboxId();
  return useQuery({ queryKey: [...keys.insights, scope(sb)], queryFn: () => request<Insights>("/insights"), staleTime: 30_000 });
}

export function useIncidents(status: string, severity: string, source = "", enabled = true) {
  const sb = useSandboxId();
  return useQuery({
    queryKey: [...keys.incidents(status, severity), source, scope(sb)],
    queryFn: () =>
      request<IncidentList>("/incidents", { query: { status: status || undefined, severity: severity || undefined, source: source || undefined, limit: 100 } }),
    staleTime: 5_000,
    enabled,
  });
}

export const useChecks = () => useQuery({ queryKey: keys.checks, queryFn: () => request<DataCheck[]>("/data/checks") });
export const useDataSummary = () => useQuery({ queryKey: keys.summary, queryFn: () => request<DataSummary>("/data/summary") });
export const useTable = (kind: string, source: string) =>
  useQuery({
    queryKey: keys.table(kind, source),
    queryFn: () => request<Record<string, unknown>[]>(`/data/table/${kind}`, { query: { source: source || undefined, limit: 300 } }),
  });

export const usePresets = () => useQuery({ queryKey: ["presets"], queryFn: () => request<Preset[]>("/scenarios/presets"), staleTime: Infinity });
export function useSuggestions() {
  const sb = useSandboxId();
  return useQuery({ queryKey: ["suggestions", scope(sb)], queryFn: () => request<string[]>("/assistant/suggestions"), staleTime: Infinity });
}

export function useReport() {
  const sb = useSandboxId();
  return useQuery({
    queryKey: ["ai-report", scope(sb)],
    queryFn: () => request<Answer>("/assistant/report", { method: "POST" }),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export const useRunSandbox = () =>
  useMutation({
    mutationFn: (b: { events: SimEventInput[]; horizon: "shift" | "day" }) => request<SandboxResult>("/sandbox", { method: "POST", body: b }),
  });

export const fetchSandbox = (id: string) => request<SandboxResult>(`/sandbox/${id}`);
export const deleteSandbox = (id: string) => request(`/sandbox/${id}`, { method: "DELETE" });

function useInvalidateData() {
  const qc = useQueryClient();
  return () => {
    for (const k of ["overview", "insights", "checks", "data-summary", "table", "plant", "advice", "plant-economy", "params", "economics"]) qc.invalidateQueries({ queryKey: [k] });
  };
}

export function useFloorControl() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: keys.floor });
  return {
    speed: useMutation({ mutationFn: (speed: number) => request("/floor/speed", { method: "POST", body: { speed } }), onSuccess: done }),
    pause: useMutation({ mutationFn: (paused: boolean) => request("/floor/pause", { method: "POST", body: { paused } }), onSuccess: done }),
    fail: useMutation({
      mutationFn: (b: { equipment: string; minutes: number; reason?: string }) => request("/floor/failure", { method: "POST", body: b }),
      onSuccess: done,
    }),
    repair: useMutation({ mutationFn: (equipment: string) => request("/floor/repair", { method: "POST", body: { equipment } }), onSuccess: done }),
    supply: useMutation({ mutationFn: (minutes: number) => request("/floor/supply-delay", { method: "POST", body: { minutes } }), onSuccess: done }),
  };
}

export function useIncidentActions() {
  const qc = useQueryClient();
  const done = () => {
    qc.invalidateQueries({ queryKey: ["incidents"] });
    qc.invalidateQueries({ queryKey: ["incident"] });
  };
  return {
    ack: useMutation({ mutationFn: (id: number) => request<Incident>(`/incidents/${id}/ack`, { method: "POST" }), onSuccess: done }),
    resolve: useMutation({
      mutationFn: (b: { id: number; resolution?: string }) =>
        request<Incident>(`/incidents/${b.id}/resolve`, { method: "POST", body: b.resolution ? { resolution: b.resolution } : {} }),
      onSuccess: done,
    }),
  };
}

export const useIncident = (id: number | null) =>
  useQuery({ queryKey: ["incident", id], queryFn: () => request<Incident>(`/incidents/${id}`), enabled: id != null, staleTime: 3_000 });

export const useImpact = (id: number | null, minutes: number | null) =>
  useQuery({
    queryKey: ["impact", id, minutes],
    queryFn: () => request<Impact>(`/incidents/${id}/impact`, { query: { minutes: minutes ?? undefined } }),
    enabled: id != null,
    staleTime: 60_000,
    retry: false,
  });

export function useShift() {
  const s = useSession();
  return useQuery({ queryKey: ["shift"], queryFn: () => request<ShiftInfo>("/shift"), enabled: !!s, staleTime: 15_000, refetchInterval: 60_000 });
}

export function useShiftActions() {
  const qc = useQueryClient();
  const done = () => {
    qc.invalidateQueries({ queryKey: ["shift"] });
    qc.invalidateQueries({ queryKey: ["shift-history"] });
  };
  return {
    start: useMutation({
      mutationFn: (b: { staff?: number; note?: string; plan?: number; staff_by_area?: Record<string, number>; checklist?: string[] }) =>
        request<ShiftSession>("/shift/start", { method: "POST", body: b }),
      onSuccess: done,
    }),
    close: useMutation({ mutationFn: (b: { note?: string }) => request<ShiftSession>("/shift/close", { method: "POST", body: b }), onSuccess: done }),
  };
}

export const useShiftSetup = () => useQuery({ queryKey: ["shift-setup"], queryFn: () => request<ShiftSetup>("/shift/setup"), staleTime: 60_000 });

export function useSaveShiftSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { shifts: Record<string, ShiftPlanSetup>; checklist: string[] }) => request<ShiftSetup>("/shift/setup", { method: "PUT", body: b }),
    onSuccess: (res) => {
      qc.setQueryData(["shift-setup"], res);
      qc.invalidateQueries({ queryKey: ["shift"] });
    },
  });
}

export const useChatChannels = (enabled = true) =>
  useQuery({ queryKey: ["chat-channels"], queryFn: () => request<ChatChannel[]>("/chat"), enabled, staleTime: 20_000, refetchInterval: 60_000 });

export const useChatHistory = (channel: string | null) =>
  useQuery({ queryKey: ["chat", channel], queryFn: () => request<ChatMessage[]>(`/chat/${channel}`), enabled: !!channel, staleTime: 5 * 60_000 });

export function useSendChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channel, text, replyTo, photo }: { channel: string; text: string; replyTo?: number | null; photo?: { blob: Blob; width: number; height: number } | null }) => {
      if (photo) {
        const f = new FormData();
        f.append("file", photo.blob, "photo.jpg");
        f.append("text", text);
        f.append("width", String(photo.width));
        f.append("height", String(photo.height));
        if (replyTo) f.append("reply_to", String(replyTo));
        return request<ChatMessage>(`/chat/${channel}/photo`, { method: "POST", body: f });
      }
      return request<ChatMessage>(`/chat/${channel}`, { method: "POST", body: { text, reply_to: replyTo ?? undefined } });
    },
    onSuccess: (m) => {
      addChatMessage(qc, m);
    },
  });
}

export function useChatMessageActions() {
  const qc = useQueryClient();
  return {
    edit: useMutation({
      mutationFn: ({ id, text }: { id: number; text: string }) => request<ChatMessage>(`/chat/messages/${id}`, { method: "PATCH", body: { text } }),
      onSuccess: (m) => updateChatMessage(qc, m),
    }),
    remove: useMutation({
      mutationFn: (id: number) => request<ChatMessage>(`/chat/messages/${id}`, { method: "DELETE" }),
      onSuccess: (m) => updateChatMessage(qc, m),
    }),
  };
}

export const useChatPeople = (enabled = true) =>
  useQuery({ queryKey: ["chat-people"], queryFn: () => request<ChatPeer[]>("/chat/people"), enabled, staleTime: 30_000 });

export function updateChatMessage(qc: QueryClient, m: ChatMessage) {
  qc.setQueryData<ChatMessage[]>(["chat", m.channel], (old) => old?.map((x) => (x.id === m.id ? m : x.reply_to?.id === m.id ? { ...x, reply_to: { ...x.reply_to, text: m.deleted ? "Сообщение удалено" : m.text } } : x)));
  qc.setQueryData<ChatChannel[]>(["chat-channels"], (old) => old?.map((c) => (c.id === m.channel && c.last?.id === m.id ? { ...c, last: m } : c)));
}

export function applyChatRead(qc: QueryClient, channel: string, lastId: number) {
  qc.setQueryData<ChatChannel[]>(["chat-channels"], (old) => old?.map((c) => (c.id === channel ? { ...c, peer_read_id: Math.max(c.peer_read_id ?? 0, lastId) } : c)));
}

export function setPresence(qc: QueryClient, userId: number, online: boolean) {
  qc.setQueryData<ChatPeer[]>(["chat-people"], (old) => old?.map((p) => (p.id === userId ? { ...p, online } : p)));
  qc.setQueryData<ChatChannel[]>(["chat-channels"], (old) => old?.map((c) => (c.peer?.id === userId ? { ...c, peer: { ...c.peer, online } } : c)));
}

export function addChatMessage(qc: QueryClient, m: ChatMessage) {
  const list = qc.getQueryData<ChatChannel[]>(["chat-channels"]);
  const known = qc.getQueryData<ChatMessage[]>(["chat", m.channel])?.some((x) => x.id === m.id)
    || list?.some((c) => c.id === m.channel && c.last?.id === m.id);
  if (list && !list.some((c) => c.id === m.channel)) qc.invalidateQueries({ queryKey: ["chat-channels"] });
  qc.setQueryData<ChatMessage[]>(["chat", m.channel], (old) => (old ? (old.some((x) => x.id === m.id) ? old : [...old, m]) : old));
  qc.setQueryData<ChatChannel[]>(["chat-channels"], (old) =>
    old?.map((c) =>
      c.id === m.channel
        ? { ...c, last: m, unread: known || m.author_id === session.get()?.id ? c.unread : c.unread + 1 }
        : c,
    ),
  );
}

export function markChatRead(qc: QueryClient, channel: string, lastId: number) {
  qc.setQueryData<ChatChannel[]>(["chat-channels"], (old) => old?.map((c) => (c.id === channel ? { ...c, unread: 0, read_id: Math.max(c.read_id, lastId) } : c)));
  request(`/chat/${channel}/read`, { method: "POST", body: { last_id: lastId } }).catch(() => undefined);
}

export const useShiftHistory = () => useQuery({ queryKey: ["shift-history"], queryFn: () => request<ShiftSession[]>("/shift/history"), staleTime: 30_000 });

export const useWorkerOverview = (area?: string) =>
  useQuery({
    queryKey: ["worker-overview", area ?? ""],
    queryFn: () => request<WorkerOverview>("/worker/overview", { query: { area } }),
    refetchInterval: 5_000,
  });

export const useMyProblems = () => useQuery({ queryKey: ["my-problems"], queryFn: () => request<Incident[]>("/problems/mine"), refetchInterval: 8_000 });

export function useReportProblem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: ProblemInput) => request<ProblemOut>("/problems", { method: "POST", body: b }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-problems"] });
      qc.invalidateQueries({ queryKey: ["worker-overview"] });
      qc.invalidateQueries({ queryKey: ["incidents"] });
    },
  });
}

export const useDemoProblem = () => useMutation({ mutationFn: () => request<ProblemOut>("/demo/problem", { method: "POST" }) });

export function useAdvice() {
  return useQuery({
    queryKey: ["advice"],
    queryFn: () => request<AdviceOut>("/advice"),
    staleTime: 30_000,
    refetchInterval: (q) => (q.state.data?.status === "computing" ? 3_000 : false),
  });
}

export const usePlantEconomy = () => useQuery({ queryKey: ["plant-economy"], queryFn: () => request<PlantEconomy>("/economics/plant"), staleTime: 30_000 });

export const useParams = () => useQuery({ queryKey: ["params"], queryFn: () => request<LineParams>("/params"), staleTime: 10_000 });

export function useSaveParams() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { areas?: Record<string, Record<string, number | null>>; equipment?: Record<string, Record<string, number | null>>; supply?: Record<string, number | null> }) =>
      request<LineParams>("/params", { method: "PUT", body: { areas: {}, equipment: {}, supply: {}, ...b } }),
    onSuccess: (d) => {
      qc.setQueryData(["params"], d);
      for (const k of ["advice", "plant", "shift-forecast"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

export function useResetParams() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<LineParams>("/params/reset", { method: "POST" }),
    onSuccess: (d) => {
      qc.setQueryData(["params"], d);
      qc.invalidateQueries({ queryKey: ["advice"] });
    },
  });
}

export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: () => request<StaffFull[]>("/users") });

export function useUserActions() {
  const qc = useQueryClient();
  const done = () => {
    qc.invalidateQueries({ queryKey: ["users"] });
    qc.invalidateQueries({ queryKey: ["login-users"] });
  };
  return {
    create: useMutation({
      mutationFn: (b: { name: string; position: string; role: string; area?: string | null; login?: string; pin: string }) => request<StaffFull>("/users", { method: "POST", body: b }),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: ({ id, ...b }: { id: number; name?: string; position?: string; role?: string; area?: string | null; active?: boolean; login?: string; pin?: string }) =>
        request<StaffFull>(`/users/${id}`, { method: "PATCH", body: b }),
      onSuccess: done,
    }),
    approve: useMutation({
      mutationFn: ({ id, ...b }: { id: number; role?: string; area?: string | null; position?: string }) => request<StaffFull>(`/users/${id}/approve`, { method: "POST", body: b }),
      onSuccess: done,
    }),
    reject: useMutation({ mutationFn: (id: number) => request<StaffFull>(`/users/${id}/reject`, { method: "POST" }), onSuccess: done }),
  };
}

export const useLayouts = () => useQuery({ queryKey: ["layouts"], queryFn: () => request<LayoutMeta[]>("/layouts"), staleTime: 10_000 });

export const useFloorLayout = () => useQuery({ queryKey: ["floor-layout"], queryFn: () => request<FloorLayout>("/layouts/floor"), staleTime: 60_000 });

export const useSetFloorLayout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number | null) => request<FloorLayout>("/layouts/floor", { method: "PUT", body: { id } }),
    onSuccess: (res) => {
      qc.setQueryData(["floor-layout"], res);
      for (const k of ["layouts", "params", "advice", "plant"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
};

export const useRunScenario = () =>
  useMutation({
    mutationFn: (b: { scenario: ScenarioInput; runs: number }) => request<WhatIfResult>("/scenarios/run", { method: "POST", body: b }),
  });

export function useImportText() {
  const invalidate = useInvalidateData();
  return useMutation({
    mutationFn: (b: { text: string; name?: string }) => request<ImportResult>("/data/import-text", { method: "POST", body: b }),
    onSuccess: invalidate,
  });
}

export function useImport() {
  const invalidate = useInvalidateData();
  return useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return request<ImportResult>("/data/import", { method: "POST", body: fd });
    },
    onSuccess: invalidate,
  });
}

export function useResetData() {
  const invalidate = useInvalidateData();
  return useMutation({ mutationFn: () => request("/data/reset", { method: "POST" }), onSuccess: invalidate });
}

export const useEconomicsValues = () => useQuery({ queryKey: ["economics"], queryFn: () => request<Economics>("/settings/economics"), staleTime: 30_000 });

export function useEconomics() {
  const invalidate = useInvalidateData();
  return useMutation({
    mutationFn: (b: Partial<Economics>) => request<Economics>("/settings/economics", { method: "PUT", body: b }),
    onSuccess: invalidate,
  });
}

export const useAsk = () => useMutation({ mutationFn: (question: string) => request<Answer>("/assistant", { method: "POST", body: { question } }) });

export interface JournalFilter {
  category?: string;
  severity?: string;
  actor?: string;
  q?: string;
  since?: string;
  until?: string;
}

export const useJournal = (f: JournalFilter, limit: number) =>
  useQuery({
    queryKey: ["journal", f, limit],
    queryFn: () => request<JournalList>("/journal", { query: { ...f, limit } }),
    refetchInterval: 8_000,
    placeholderData: (prev) => prev,
  });

export const useDbStatus = () => {
  const s = useSession();
  return useQuery({ queryKey: ["db-status"], queryFn: () => request<DbStatus>("/system/db"), enabled: can(s, "view"), staleTime: 15_000, refetchInterval: 30_000 });
};

export function useDbActions() {
  const qc = useQueryClient();
  const done = (st: DbStatus) => {
    qc.setQueryData(["db-status"], st);
    qc.invalidateQueries();
  };
  return {
    mirror: useMutation({ mutationFn: () => request<DbStatus>("/system/db/mirror", { method: "POST" }), onSuccess: done }),
    usePrimary: useMutation({ mutationFn: (transfer: boolean) => request<DbStatus>("/system/db/use-primary", { method: "POST", query: { transfer } }), onSuccess: done }),
    seedSupabase: useMutation({
      mutationFn: () => request<{ ok: boolean; created: number; updated: number; error?: string; errors?: string[] }>(
        "/system/supabase/seed-users",
        { method: "POST" },
      ),
    }),
  };
}
