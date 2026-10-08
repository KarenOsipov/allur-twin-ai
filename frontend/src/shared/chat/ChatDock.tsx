import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  Check,
  CheckCheck,
  ChevronUp,
  Factory,
  ImagePlus,
  Megaphone,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Reply,
  Search,
  SendHorizontal,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getBlob, request } from "@/shared/api/client";
import { markChatRead, useChatChannels, useChatHistory, useChatMessageActions, useChatPeople, useSendChat } from "@/shared/api/queries";
import type { ChatChannel, ChatMessage, ChatPeer } from "@/shared/api/types";
import { alerts } from "@/shared/alerts/store";
import { can, useSession } from "@/shared/auth/session";
import { sendLive, useFloor } from "@/shared/realtime/live";
import { toast } from "@/shared/ui/Toaster";
import { chatBus, useChatState, useTyping } from "./bus";

const ICON = { all: Megaphone, staff: ShieldCheck } as Record<string, typeof Factory>;

const hhmm = (iso: string) => iso.slice(11, 16);
function dayLabel(iso: string, today: string) {
  const d = iso.slice(0, 10);
  if (d === today) return "Сегодня";
  const [y, m, dd] = d.split("-");
  return `${dd}.${m}.${y}`;
}
const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");

let pendingDm: ChatChannel | null = null;

export function ChatDock({ hideLauncherOnPhone = false }: { hideLauncherOnPhone?: boolean }) {
  const me = useSession();
  const st = useChatState();
  const channels = useChatChannels(!!me);
  const unread = (channels.data ?? []).reduce((n, c) => n + c.unread, 0);
  const [people, setPeople] = useState(false);

  useEffect(() => {
    chatBus.setNames(Object.fromEntries((channels.data ?? []).map((c) => [c.id, c.name])));
  }, [channels.data]);

  useEffect(() => {
    document.body.dataset.chat = st.open ? "open" : "closed";
    return () => {
      delete document.body.dataset.chat;
    };
  }, [st.open]);

  useEffect(() => {
    if (!st.open) setPeople(false);
    if (!st.open) return;
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && chatBus.close();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [st.open]);

  if (!me) return null;
  const listed = channels.data?.find((c) => c.id === st.channel);
  const current = listed ?? (pendingDm && pendingDm.id === st.channel ? pendingDm : null);

  return (
    <>
      {!st.open && (
        <button
          type="button"
          onClick={() => chatBus.open()}
          aria-label={unread ? `Чат производства, непрочитанных: ${unread}` : "Чат производства"}
          className={clsx(
            "fixed right-4 bottom-4 z-40 size-14 place-items-center rounded-full bg-deep text-white shadow-[0_14px_30px_-12px_rgb(30_10_9/0.7)] transition-transform duration-200 hover:scale-105 active:scale-95",
            hideLauncherOnPhone ? "hidden md:grid" : "grid",
          )}
        >
          <MessageSquareText className="size-6" aria-hidden />
          {unread > 0 && (
            <span className="num absolute -top-1 -right-1 grid h-6 min-w-6 place-items-center rounded-full bg-brand px-1.5 text-xs font-bold ring-2 ring-white">{unread > 99 ? "99+" : unread}</span>
          )}
        </button>
      )}
      {st.open && (
        <section
          aria-label="Чат производства"
          className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-panel sm:inset-auto sm:right-4 sm:bottom-4 sm:h-[min(680px,calc(100dvh-2rem))] sm:w-[420px] sm:rounded-[24px] sm:shadow-[var(--shadow-float)] sm:ring-1 sm:ring-line"
        >
          {current ? (
            <Conversation key={current.id} channel={current} />
          ) : people ? (
            <People
              onBack={() => setPeople(false)}
              onPick={async (p) => {
                try {
                  const { channel } = await request<{ channel: string }>(`/chat/dm/${p.id}`);
                  pendingDm = { id: channel, kind: "dm", name: p.name, hint: p.position, peer: p, last: null, unread: 0, read_id: 0, peer_read_id: 0 };
                  setPeople(false);
                  chatBus.select(channel);
                } catch (e) {
                  toast({ title: "Не удалось открыть переписку", body: (e as Error).message, tone: "down" });
                }
              }}
            />
          ) : (
            <ChannelList channels={channels.data ?? []} loading={channels.isLoading} error={channels.isError} onPeople={() => setPeople(true)} />
          )}
        </section>
      )}
    </>
  );
}

function Header({ title, hint, onBack, avatar }: { title: string; hint?: React.ReactNode; onBack?: () => void; avatar?: React.ReactNode }) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] sm:pt-2.5">
      {onBack && (
        <button type="button" onClick={onBack} aria-label="Назад" className="grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-sunken">
          <ArrowLeft className="size-5" />
        </button>
      )}
      {avatar}
      <div className={clsx("min-w-0 flex-1", !onBack && !avatar && "pl-2")}>
        <h2 className="truncate text-[1.05rem] font-semibold">{title}</h2>
        {hint && <div className="truncate text-xs text-ink-3">{hint}</div>}
      </div>
      <button type="button" onClick={() => chatBus.close()} aria-label="Закрыть чат" className="grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-sunken">
        <X className="size-5" />
      </button>
    </header>
  );
}

function Avatar({ name, online, size = "size-10", channel }: { name: string; online?: boolean; size?: string; channel?: ChatChannel }) {
  if (channel && channel.kind === "channel") {
    const Icon = ICON[channel.id] ?? Factory;
    return (
      <span className={clsx("grid shrink-0 place-items-center rounded-full", size, channel.id === "all" ? "bg-brand text-white" : channel.id === "staff" ? "bg-deep text-white" : "bg-sunken text-ink-2")} aria-hidden>
        <Icon className="size-[18px]" />
      </span>
    );
  }
  return (
    <span className={clsx("display relative grid shrink-0 place-items-center rounded-full bg-deep text-[0.78rem] font-medium text-white", size)} aria-hidden>
      {initials(name)}
      {online !== undefined && <span className={clsx("absolute right-0 bottom-0 size-3 rounded-full ring-2 ring-panel", online ? "bg-run" : "bg-line-strong")} />}
    </span>
  );
}

function preview(c: ChatChannel) {
  const m = c.last;
  if (!m) return c.hint;
  if (m.deleted) return "Сообщение удалено";
  const body = m.text || "Фото";
  if (m.author === "Система" || c.kind === "dm") return body;
  return `${m.author.split(" ")[0]}: ${body}`;
}

function ChannelList({ channels, loading, error, onPeople }: { channels: ChatChannel[]; loading: boolean; error: boolean; onPeople: () => void }) {
  const groups: [string, ChatChannel[]][] = [
    ["Каналы", channels.filter((c) => c.kind === "channel")],
    ["Личные", channels.filter((c) => c.kind === "dm")],
  ];
  const [perm, setPerm] = useState(typeof Notification !== "undefined" ? Notification.permission : "denied");
  return (
    <>
      <Header title="Чат производства" hint="Сообщения приходят всем сразу" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {perm === "default" && (
          <button
            type="button"
            onClick={() => Notification.requestPermission().then(setPerm)}
            className="mb-2 flex w-full items-center gap-3 rounded-[16px] bg-sunken px-3 py-2.5 text-left text-sm hover:bg-floor"
          >
            <Bell className="size-4 shrink-0 text-brand" aria-hidden />
            <span className="min-w-0 flex-1">
              <b>Включить уведомления</b>
              <span className="block text-xs text-ink-3">Личные сообщения и тревоги с участков, даже когда вкладка свёрнута</span>
            </span>
          </button>
        )}
        {loading && <p className="px-3 py-6 text-center text-sm text-ink-3">Загружаю каналы…</p>}
        {error && <p className="px-3 py-6 text-center text-sm text-down">Нет связи с сервером. Повторю автоматически.</p>}
        {groups.map(([title, list]) => (
          <div key={title} className="mb-1">
            <div className="flex items-center justify-between px-3 pt-2 pb-1">
              <h3 className="text-xs font-semibold text-ink-3">{title}</h3>
              {title === "Личные" && (
                <button type="button" onClick={onPeople} className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-accent hover:bg-sunken">
                  <UserPlus className="size-3.5" aria-hidden /> Написать коллеге
                </button>
              )}
            </div>
            <ul>
              {list.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => chatBus.select(c.id)} className="flex w-full items-center gap-3 rounded-[16px] px-2.5 py-2.5 text-left hover:bg-sunken">
                    <Avatar name={c.name} online={c.peer?.online} channel={c} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-bold">{c.name}</span>
                        {c.last && <span className="num shrink-0 text-xs text-ink-3">{hhmm(c.last.at)}</span>}
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className={clsx("truncate text-[0.8125rem]", c.unread ? "font-semibold text-ink" : "text-ink-3")}>{preview(c)}</span>
                        {c.unread > 0 && <span className="num grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-brand px-1.5 text-2xs font-bold text-white">{c.unread}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {title === "Личные" && list.length === 0 && !loading && <li className="px-3 py-2 text-sm text-ink-3">Личных переписок пока нет.</li>}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

const ROLE_LABEL: Record<string, string> = { admin: "Администраторы", director: "Руководство", supervisor: "Начальники смены", worker: "Рабочие" };

function People({ onBack, onPick }: { onBack: () => void; onPick: (p: ChatPeer) => void }) {
  const q = useChatPeople();
  const [find, setFind] = useState("");
  const list = (q.data ?? []).filter((p) => `${p.name} ${p.position}`.toLowerCase().includes(find.trim().toLowerCase()));
  const order = ["supervisor", "director", "worker", "admin"];
  return (
    <>
      <Header title="Написать коллеге" hint={q.data ? `в сети: ${q.data.filter((p) => p.online).length}` : undefined} onBack={onBack} />
      <div className="border-b border-line p-2.5">
        <label className="relative block">
          <span className="sr-only">Поиск сотрудника</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            autoFocus
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Имя или должность"
            className="h-10 w-full rounded-full border border-line-strong bg-sunken pr-3 pl-9 text-sm focus:border-accent focus:bg-panel focus:outline-none"
          />
        </label>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {q.isLoading && <p className="px-3 py-6 text-center text-sm text-ink-3">Загружаю сотрудников…</p>}
        {order.map((role) => {
          const group = list.filter((p) => p.role === role).sort((a, b) => Number(b.online) - Number(a.online));
          if (!group.length) return null;
          return (
            <div key={role} className="mb-1">
              <h3 className="px-3 pt-2 pb-1 text-xs font-semibold text-ink-3">{ROLE_LABEL[role]}</h3>
              <ul>
                {group.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => onPick(p)} className="flex w-full items-center gap-3 rounded-[16px] px-2.5 py-2 text-left hover:bg-sunken">
                      <Avatar name={p.name} online={p.online} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold">{p.name}</span>
                        <span className="block truncate text-xs text-ink-3">
                          {p.position}
                          {p.online && <span className="text-run"> · в сети</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {q.data && list.length === 0 && <p className="px-3 py-6 text-center text-sm text-ink-3">Никого не нашли.</p>}
      </div>
    </>
  );
}

const photoCache = new Map<number, string>();

async function shrink(file: File): Promise<{ blob: Blob; width: number; height: number; url: string }> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k);
  const h = Math.round(bmp.height * k);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Не удалось подготовить фото"))), "image/jpeg", 0.85));
  return { blob, width: w, height: h, url: URL.createObjectURL(blob) };
}

function Photo({ id, w, h, onOpen }: { id: number; w?: number | null; h?: number | null; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState(photoCache.get(id) ?? null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (url) return;
    let live = true;
    getBlob(`/chat/files/${id}`)
      .then((b) => {
        const u = URL.createObjectURL(b);
        photoCache.set(id, u);
        if (live) setUrl(u);
      })
      .catch(() => live && setErr(true));
    return () => {
      live = false;
    };
  }, [id, url]);
  const ratio = w && h ? `${w} / ${h}` : "4 / 3";
  return (
    <button type="button" onClick={() => url && onOpen(url)} className="mb-1 block w-full max-w-[260px] overflow-hidden rounded-[12px] bg-sunken" style={{ aspectRatio: ratio }} aria-label="Открыть фото">
      {url ? <img src={url} alt="Фото из чата" className="size-full object-cover" /> : <span className="grid size-full place-items-center text-xs text-ink-3">{err ? "Фото недоступно" : "Загружаю фото…"}</span>}
    </button>
  );
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", esc, true);
    return () => document.removeEventListener("keydown", esc, true);
  }, [onClose]);
  return (
    <div role="dialog" aria-label="Фото" className="fixed inset-0 z-[80] grid place-items-center bg-black/85 p-4" onClick={onClose}>
      <img src={url} alt="Фото из чата" className="max-h-full max-w-full rounded-[12px] object-contain" />
      <button type="button" onClick={onClose} aria-label="Закрыть фото" className="absolute top-4 right-4 grid size-11 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25">
        <X className="size-6" />
      </button>
    </div>
  );
}

function Conversation({ channel }: { channel: ChatChannel }) {
  const qc = useQueryClient();
  const me = useSession();
  const hist = useChatHistory(channel.id);
  const send = useSendChat();
  const actions = useChatMessageActions();
  const typing = useTyping(channel.id);
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [noMore, setNoMore] = useState(false);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [photo, setPhoto] = useState<{ blob: Blob; width: number; height: number; url: string } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const lastTyping = useRef(0);
  const firstUnread = useRef<number | null>(null);
  const messages = useMemo(() => {
    const seen = new Set<number>();
    return [...older, ...(hist.data ?? [])].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  }, [older, hist.data]);
  const lastId = messages.at(-1)?.id ?? 0;
  const clock = useFloor()?.clock;
  const today = clock ? clock.slice(0, 10) : new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const isDm = channel.kind === "dm";

  useEffect(() => {
    if (firstUnread.current !== null || !hist.data) return;
    const f = hist.data.find((m) => m.id > channel.read_id && m.author_id !== me?.id && m.kind !== "system");
    firstUnread.current = f && channel.unread > 0 ? f.id : 0;
  }, [hist.data, channel.read_id, channel.unread, me?.id]);

  useEffect(() => {
    stick.current = true;
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (lastId && (lastId > channel.read_id || channel.unread > 0)) markChatRead(qc, channel.id, lastId);
  }, [lastId, channel.id, channel.read_id, channel.unread, qc]);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, typing.length]);

  const onScroll = () => {
    const el = list.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    const first = messages[0];
    if (!first) return;
    const el = list.current;
    const before = el?.scrollHeight ?? 0;
    const page = await request<ChatMessage[]>(`/chat/${channel.id}`, { query: { before: first.id } });
    if (page.length === 0) setNoMore(true);
    stick.current = false;
    setOlder((o) => [...page, ...o]);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  };

  const onType = (v: string) => {
    setText(v.slice(0, 1000));
    const now = Date.now();
    if (v && now - lastTyping.current > 3000) {
      lastTyping.current = now;
      sendLive({ type: "typing", channel: channel.id });
    }
  };

  const reset = () => {
    setText("");
    setReply(null);
    setEditing(null);
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto(null);
  };

  const submit = () => {
    const t = text.trim();
    if (editing) {
      if (!t && !editing.ref?.photo) return;
      actions.edit.mutate({ id: editing.id, text: t }, { onSuccess: reset, onError: (e) => toast({ title: "Не удалось исправить", body: e.message, tone: "down" }) });
      return;
    }
    if ((!t && !photo) || send.isPending) return;
    stick.current = true;
    send.mutate(
      { channel: channel.id, text: t, replyTo: reply?.id, photo },
      { onSuccess: reset, onError: (e) => toast({ title: "Сообщение не отправлено", body: e.message, tone: "down" }) },
    );
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape" && (reply || editing)) {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      reset();
    }
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPhoto(await shrink(f));
      input.current?.focus();
    } catch {
      toast({ title: "Не удалось открыть фото", body: "Выберите снимок в формате JPEG или PNG.", tone: "down" });
    }
  };

  const peerRead = channel.peer_read_id ?? 0;
  const status = typing.length
    ? `${typing.join(", ")} ${typing.length > 1 ? "печатают" : "печатает"}…`
    : isDm
      ? channel.peer?.online
        ? "в сети"
        : channel.hint
      : channel.hint;

  return (
    <>
      <Header
        title={channel.name}
        hint={<span className={clsx(typing.length || (isDm && channel.peer?.online) ? "text-run" : undefined)}>{status}</span>}
        onBack={() => chatBus.select(null)}
        avatar={<Avatar name={channel.name} online={isDm ? channel.peer?.online : undefined} size="size-9" channel={channel} />}
      />
      <div ref={list} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-paper/60 px-3 py-3" aria-live="polite">
        {hist.isLoading && <p className="py-8 text-center text-sm text-ink-3">Загружаю сообщения…</p>}
        {hist.isError && <p className="py-8 text-center text-sm text-down">Не удалось загрузить сообщения.</p>}
        {messages.length >= 60 && !noMore && (
          <div className="mb-2 flex justify-center">
            <button type="button" onClick={loadOlder} className="inline-flex h-8 items-center gap-1 rounded-full bg-panel px-3 text-xs font-semibold text-ink-2 shadow-sm hover:text-ink">
              <ChevronUp className="size-3.5" aria-hidden /> Показать раньше
            </button>
          </div>
        )}
        {hist.data && messages.length === 0 && <p className="py-10 text-center text-sm text-ink-3">{isDm ? `Напишите ${channel.name.split(" ")[0]} первым.` : "Здесь пока тихо. Напишите первым."}</p>}
        <ol className="flex flex-col gap-1.5">
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || prev.at.slice(0, 10) !== m.at.slice(0, 10);
            const grouped = !newDay && prev && prev.author_id === m.author_id && prev.kind === "text" && m.kind === "text" && m.id !== firstUnread.current;
            const mine = m.author_id === me?.id;
            return (
              <li key={m.id}>
                {newDay && <div className="my-2 text-center text-2xs font-semibold tracking-wide text-ink-3">{dayLabel(m.at, today)}</div>}
                {m.id === firstUnread.current && (
                  <div className="my-2 flex items-center gap-2 text-2xs font-bold text-brand" role="separator">
                    <span className="h-px flex-1 bg-brand/30" /> Новые сообщения <span className="h-px flex-1 bg-brand/30" />
                  </div>
                )}
                <Bubble
                  m={m}
                  mine={mine}
                  grouped={!!grouped}
                  canAnalyse={can(me, "view")}
                  read={isDm && mine ? m.id <= peerRead : undefined}
                  canDelete={mine || (me?.role === "admin" && !isDm)}
                  onReply={() => {
                    setEditing(null);
                    setReply(m);
                    input.current?.focus();
                  }}
                  onEdit={() => {
                    setReply(null);
                    setEditing(m);
                    setText(m.text);
                    input.current?.focus();
                  }}
                  onDelete={() => actions.remove.mutate(m.id, { onError: (e) => toast({ title: "Не удалось удалить", body: e.message, tone: "down" }) })}
                  onPhoto={setLightbox}
                />
              </li>
            );
          })}
        </ol>
        {typing.length > 0 && (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-panel px-3 py-1.5 text-xs text-ink-3 shadow-sm">
            <span className="flex gap-0.5" aria-hidden>
              {[0, 1, 2].map((d) => (
                <span key={d} className="size-1.5 animate-pulse rounded-full bg-ink-3" style={{ animationDelay: `${d * 150}ms` }} />
              ))}
            </span>
            {typing[0].split(" ")[0]} печатает
          </div>
        )}
      </div>
      {(reply || editing || photo) && (
        <div className="flex shrink-0 items-center gap-3 border-t border-line bg-panel px-3 pt-2.5">
          {photo && <img src={photo.url} alt="" className="size-12 shrink-0 rounded-[10px] object-cover" />}
          <div className="min-w-0 flex-1 border-l-2 border-brand pl-2.5">
            <div className="text-xs font-bold text-brand">{editing ? "Исправить сообщение" : reply ? `Ответ: ${reply.author}` : "Фото"}</div>
            <div className="truncate text-xs text-ink-3">{editing ? editing.text || "Фото" : reply ? reply.text || "Фото" : "добавьте подпись или отправьте так"}</div>
          </div>
          <button type="button" onClick={reset} aria-label="Отменить" className="grid size-8 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-sunken">
            <X className="size-4" />
          </button>
        </div>
      )}
      <form
        className="flex shrink-0 items-end gap-1.5 border-t border-line bg-panel p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] data-[ctx=true]:border-t-0"
        data-ctx={!!(reply || editing || photo)}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {!editing && (
          <>
            <input ref={file} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ""))} />
            <button type="button" onClick={() => file.current?.click()} aria-label="Прикрепить фото" className="grid size-11 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-sunken">
              <ImagePlus className="size-5" />
            </button>
          </>
        )}
        <label className="min-w-0 flex-1">
          <span className="sr-only">Сообщение: {channel.name}</span>
          <textarea
            ref={input}
            value={text}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={onKey}
            rows={Math.min(4, Math.max(1, text.split("\n").length))}
            placeholder={photo ? "Подпись к фото…" : "Сообщение…"}
            aria-label={`Сообщение в канал «${channel.name}»`}
            className="block w-full resize-none rounded-[18px] border border-line-strong bg-sunken px-4 py-2.5 text-[0.95rem] leading-snug focus:border-accent focus:bg-panel focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={(editing ? !text.trim() && !editing.ref?.photo : !text.trim() && !photo) || send.isPending}
          aria-label={editing ? "Сохранить" : "Отправить"}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-brand text-white transition-opacity hover:bg-brand-2 disabled:opacity-40"
        >
          {editing ? <Check className="size-5" /> : <SendHorizontal className="size-5" />}
        </button>
      </form>
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

function Bubble({
  m,
  mine,
  grouped,
  canAnalyse,
  read,
  canDelete,
  onReply,
  onEdit,
  onDelete,
  onPhoto,
}: {
  m: ChatMessage;
  mine: boolean;
  grouped: boolean;
  canAnalyse: boolean;
  read?: boolean;
  canDelete: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPhoto: (url: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [down, setDown] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = () => {
    const r = box.current?.getBoundingClientRect();
    const list = box.current?.closest("[aria-live]")?.getBoundingClientRect();
    setDown(!!r && !!list && r.top - list.top < 150);
    setMenu((v) => !v);
    setConfirm(false);
  };
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setMenu(false);
        setConfirm(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [menu]);

  if (m.kind === "system")
    return (
      <div className="mx-auto my-1 max-w-[92%] rounded-[12px] bg-sunken px-3 py-1.5 text-center text-xs text-ink-2">
        {m.text} <span className="num text-ink-3">· {hhmm(m.at)}</span>
      </div>
    );
  if (m.kind === "alert")
    return (
      <div className="my-1 rounded-[16px] bg-down-soft px-3.5 py-2.5 text-sm text-ink ring-1 ring-down/20">
        <div className="flex items-center gap-1.5 text-xs font-bold text-down">
          <AlertTriangle className="size-3.5" aria-hidden /> Сообщение с участка · <span className="num">{hhmm(m.at)}</span>
        </div>
        <p className="mt-1">{m.text}</p>
        {canAnalyse && m.ref?.incident && (
          <button type="button" onClick={() => alerts.open(m.ref!.incident!)} className="mt-2 inline-flex h-8 items-center rounded-full bg-down px-3 text-xs font-bold text-white hover:opacity-90">
            Анализ за минуту
          </button>
        )}
      </div>
    );
  const photo = m.ref?.photo;
  const actionsBtn = !m.deleted && (
    <div ref={box} className="relative self-center">
      <button
        type="button"
        onClick={toggle}
        aria-label="Действия с сообщением"
        aria-expanded={menu}
        className="grid size-8 place-items-center rounded-full text-ink-3 opacity-60 transition-opacity group-hover:opacity-100 hover:bg-panel hover:text-ink focus-visible:opacity-100 sm:opacity-0"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {menu && (
        <div role="menu" className={clsx("panel absolute z-10 w-44 p-1", down ? "top-9" : "bottom-9", mine ? "right-0" : "left-0")}>
          <button type="button" role="menuitem" onClick={() => (setMenu(false), onReply())} className="flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-sm hover:bg-sunken">
            <Reply className="size-4" aria-hidden /> Ответить
          </button>
          {mine && (
            <button type="button" role="menuitem" onClick={() => (setMenu(false), onEdit())} className="flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-sm hover:bg-sunken">
              <Pencil className="size-4" aria-hidden /> Исправить
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              role="menuitem"
              onClick={() => (confirm ? (setMenu(false), setConfirm(false), onDelete()) : setConfirm(true))}
              className={clsx("flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-sm", confirm ? "bg-down text-white" : "text-down hover:bg-down-soft")}
            >
              <Trash2 className="size-4" aria-hidden /> {confirm ? "Точно удалить?" : "Удалить"}
            </button>
          )}
        </div>
      )}
    </div>
  );
  return (
    <div className={clsx("group flex items-end gap-2", mine && "flex-row-reverse", grouped && "-mt-0.5")}>
      {!mine && (
        <span className={clsx("display grid size-8 shrink-0 place-items-center rounded-full bg-deep text-[0.7rem] font-medium text-white", grouped && "invisible")} aria-hidden>
          {initials(m.author)}
        </span>
      )}
      <div className={clsx("max-w-[78%] rounded-[18px] px-3.5 py-2", mine ? "rounded-br-[6px] bg-brand text-white" : "rounded-bl-[6px] bg-panel text-ink shadow-[0_1px_2px_rgb(30_10_9/0.08)]", m.deleted && "opacity-70")}>
        {!mine && !grouped && (
          <div className="mb-0.5 text-xs">
            <span className="font-bold">{m.author}</span> <span className="text-ink-3">· {m.position}</span>
          </div>
        )}
        {m.reply_to && (
          <div className={clsx("mb-1 rounded-[10px] border-l-2 px-2 py-1 text-xs", mine ? "border-white/70 bg-white/15" : "border-brand bg-sunken")}>
            <div className="font-bold">{m.reply_to.author}</div>
            <div className={clsx("truncate", mine ? "text-white/80" : "text-ink-3")}>{m.reply_to.text}</div>
          </div>
        )}
        {m.deleted ? (
          <p className="text-[0.88rem] italic">Сообщение удалено</p>
        ) : (
          <>
            {photo && <Photo id={photo.id} w={photo.w} h={photo.h} onOpen={onPhoto} />}
            {m.text && <p className="text-[0.92rem] leading-snug break-words whitespace-pre-wrap">{m.text}</p>}
          </>
        )}
        <div className={clsx("num mt-0.5 flex items-center justify-end gap-1 text-[0.68rem]", mine ? "text-white/75" : "text-ink-3")}>
          {m.edited_at && !m.deleted && <span>изменено ·</span>}
          {hhmm(m.at)}
          {read !== undefined && (read ? <CheckCheck className="size-3.5" aria-label="Прочитано" /> : <Check className="size-3.5" aria-label="Доставлено" />)}
        </div>
      </div>
      {actionsBtn}
    </div>
  );
}
