from __future__ import annotations

import re
import threading
from datetime import datetime, timedelta

from sqlalchemy import delete, func, or_, select

from app.core.errors import ForbiddenError, NotFoundError, ValidationFailed
from app.core.events import EventBus
from app.core.security import Role, Session
from app.db.base import Database
from app.db.models import ChatFile, ChatMessage, ChatRead, User
from app.domain.plant import Plant

ALL = "all"
STAFF = "staff"
PAGE = 60
EDIT_WINDOW = timedelta(hours=24)
DM_RE = re.compile(r"^dm:(\d+)-(\d+)$")


def dm_id(a: int, b: int) -> str:
    lo, hi = sorted((a, b))
    return f"dm:{lo}-{hi}"


def dm_pair(channel: str) -> tuple[int, int] | None:
    m = DM_RE.match(channel)
    return (int(m.group(1)), int(m.group(2))) if m else None


class Presence:
    def __init__(self) -> None:
        self._n: dict[int, int] = {}
        self._lock = threading.Lock()

    def join(self, uid: int) -> bool:
        with self._lock:
            self._n[uid] = self._n.get(uid, 0) + 1
            return self._n[uid] == 1

    def leave(self, uid: int) -> bool:
        with self._lock:
            n = self._n.get(uid, 0) - 1
            if n <= 0:
                self._n.pop(uid, None)
                return True
            self._n[uid] = n
            return False

    def online(self) -> set[int]:
        with self._lock:
            return set(self._n)


def _out(m: ChatMessage, reply: ChatMessage | None = None) -> dict:
    deleted = bool(m.deleted)
    return {
        "id": m.id,
        "channel": m.channel,
        "at": m.created_at,
        "author_id": m.author_id,
        "author": m.author,
        "position": m.position,
        "role": m.role,
        "kind": m.kind,
        "text": "" if deleted else m.text,
        "ref": None if deleted else m.ref,
        "reply_to": (
            {
                "id": reply.id,
                "author": reply.author,
                "text": "Сообщение удалено" if reply.deleted else (reply.text[:140] or "Фото"),
            }
            if reply is not None and not deleted
            else None
        ),
        "edited_at": m.edited_at,
        "deleted": deleted,
        "actor_id": m.actor_id,
    }


class ChatService:
    def __init__(self, db: Database, plant: Plant, events: EventBus, clock) -> None:
        self.db = db
        self.plant = plant
        self.events = events
        self.clock = clock
        self.presence = Presence()

    def channels(self) -> list[dict]:
        out = [
            {"id": ALL, "kind": "channel", "name": "Весь цех", "hint": "Объявления и вопросы для всех"},
            {"id": STAFF, "kind": "channel", "name": "Штаб смены", "hint": "Начальники смены и руководство"},
        ]
        out += [
            {"id": a.code, "kind": "channel", "name": a.name, "hint": "Канал участка", "area": a.code}
            for a in self.plant.areas
        ]
        return out

    def _codes(self) -> set[str]:
        return {c["id"] for c in self.channels()}

    @staticmethod
    def can_read(session: Session, channel: str) -> bool:
        pair = dm_pair(channel)
        if pair is not None:
            return session.user_id in pair
        if channel == ALL:
            return True
        if session.role == Role.WORKER:
            return channel == session.area
        return True

    def _check(self, session: Session, channel: str) -> None:
        pair = dm_pair(channel)
        if pair is not None:
            if pair[0] == pair[1] or channel != dm_id(*pair):
                raise NotFoundError("Такой переписки нет")
            if session.user_id not in pair:
                raise ForbiddenError("Это чужая переписка")
            with self.db.session() as s:
                other = s.get(User, pair[1] if pair[0] == session.user_id else pair[0])
                if other is None or not other.active:
                    raise NotFoundError("Сотрудник не найден или отключён")
            return
        if channel not in self._codes():
            raise NotFoundError("Такого канала нет")
        if not self.can_read(session, channel):
            raise ForbiddenError("Этот канал вам недоступен")

    def people(self, session: Session) -> list[dict]:
        online = self.presence.online()
        with self.db.session() as s:
            rows = s.scalars(select(User).where(User.active.is_(True), User.id != session.user_id).order_by(User.name))
            return [
                {
                    "id": u.id,
                    "name": u.name,
                    "position": u.position,
                    "role": u.role,
                    "area": u.area,
                    "online": u.id in online,
                }
                for u in rows
            ]

    def visible(self, session: Session) -> list[dict]:
        chans = [c for c in self.channels() if self.can_read(session, c["id"])]
        online = self.presence.online()
        me = session.user_id
        with self.db.session() as s:
            dm_like = or_(ChatMessage.channel.like(f"dm:{me}-%"), ChatMessage.channel.like(f"dm:%-{me}"))
            dms = [
                ch
                for ch in s.scalars(select(ChatMessage.channel).where(dm_like).distinct())
                if self.can_read(session, ch)
            ]
            peers_ids = {p for ch in dms for p in dm_pair(ch) or () if p != me}
            peers = {u.id: u for u in s.scalars(select(User).where(User.id.in_(peers_ids)))} if peers_ids else {}
            for ch in dms:
                a, b = dm_pair(ch)
                u = peers.get(b if a == me else a)
                if u is None:
                    continue
                chans.append(
                    {
                        "id": ch,
                        "kind": "dm",
                        "name": u.name,
                        "hint": u.position,
                        "peer": {
                            "id": u.id,
                            "name": u.name,
                            "position": u.position,
                            "role": u.role,
                            "area": u.area,
                            "online": u.id in online,
                        },
                    }
                )
            ids = [c["id"] for c in chans]
            reads = {r.channel: r.last_id for r in s.scalars(select(ChatRead).where(ChatRead.user_id == me))}
            peer_reads = {
                r.channel: r.last_id
                for r in s.scalars(select(ChatRead).where(ChatRead.channel.in_(dms), ChatRead.user_id != me))
            }
            last_ids = dict(
                s.execute(
                    select(ChatMessage.channel, func.max(ChatMessage.id))
                    .where(ChatMessage.channel.in_(ids))
                    .group_by(ChatMessage.channel)
                ).all()
            )
            last = {
                m.channel: _out(m) for m in s.scalars(select(ChatMessage).where(ChatMessage.id.in_(last_ids.values())))
            }
            unread = dict(
                s.execute(
                    select(ChatMessage.channel, func.count(ChatMessage.id))
                    .where(
                        ChatMessage.channel.in_(ids),
                        (ChatMessage.author_id.is_(None)) | (ChatMessage.author_id != me),
                        (ChatMessage.actor_id.is_(None)) | (ChatMessage.actor_id != me),
                        ChatMessage.id
                        > func.coalesce(
                            select(ChatRead.last_id)
                            .where(ChatRead.user_id == me, ChatRead.channel == ChatMessage.channel)
                            .scalar_subquery(),
                            0,
                        ),
                    )
                    .group_by(ChatMessage.channel)
                ).all()
            )
        out = []
        for c in chans:
            row = {
                **c,
                "last": last.get(c["id"]),
                "unread": int(unread.get(c["id"], 0)),
                "read_id": reads.get(c["id"], 0),
            }
            if c["kind"] == "dm":
                row["peer_read_id"] = peer_reads.get(c["id"], 0)
            out.append(row)
        chan_part = [r for r in out if r["kind"] == "channel"]
        dm_part = sorted((r for r in out if r["kind"] == "dm"), key=lambda r: -(r["last"]["id"] if r["last"] else 0))
        return chan_part + dm_part

    def _with_replies(self, s, rows: list[ChatMessage]) -> list[dict]:
        ids = {m.reply_to_id for m in rows if m.reply_to_id}
        replies = {r.id: r for r in s.scalars(select(ChatMessage).where(ChatMessage.id.in_(ids)))} if ids else {}
        return [_out(m, replies.get(m.reply_to_id) if m.reply_to_id else None) for m in rows]

    def history(self, session: Session, channel: str, before: int | None = None, limit: int = PAGE) -> list[dict]:
        self._check(session, channel)
        with self.db.session() as s:
            q = select(ChatMessage).where(ChatMessage.channel == channel)
            if before:
                q = q.where(ChatMessage.id < before)
            rows = list(s.scalars(q.order_by(ChatMessage.id.desc()).limit(max(1, min(limit, 200)))))
            return self._with_replies(s, list(reversed(rows)))

    def post(
        self,
        session: Session,
        channel: str,
        text: str,
        reply_to: int | None = None,
        photo: dict | None = None,
    ) -> dict:
        self._check(session, channel)
        text = text.strip()
        if not text and photo is None:
            raise ValidationFailed("Пустое сообщение")
        with self.db.session() as s:
            ref = None
            if photo is not None:
                f = ChatFile(
                    channel=channel,
                    author_id=session.user_id,
                    created_at=self.clock(),
                    mime=photo["mime"],
                    size=len(photo["data"]),
                    width=photo.get("width"),
                    height=photo.get("height"),
                    data=photo["data"],
                )
                s.add(f)
                s.flush()
                ref = {"photo": {"id": f.id, "w": f.width, "h": f.height}}
            reply = None
            if reply_to:
                reply = s.get(ChatMessage, reply_to)
                if reply is None or reply.channel != channel:
                    raise ValidationFailed("Сообщение для ответа не найдено в этом канале")
            m = ChatMessage(
                channel=channel,
                created_at=self.clock(),
                author_id=session.user_id,
                author=session.name,
                position=session.position,
                role=session.role.value,
                kind="text",
                text=text[:1000],
                reply_to_id=reply.id if reply else None,
                ref=ref,
            )
            s.add(m)
            s.flush()
            out = _out(m, reply)
            self._mark(s, session.user_id, channel, m.id)
        self.events.publish("chat.message", out)
        return out

    def photo(self, session: Session, file_id: int) -> tuple[bytes, str]:
        with self.db.session() as s:
            f = s.get(ChatFile, file_id)
            if f is None or not self.can_read(session, f.channel):
                raise NotFoundError("Фото не найдено")
            return f.data, f.mime

    def _own(self, s, session: Session, msg_id: int) -> ChatMessage:
        m = s.get(ChatMessage, msg_id)
        if m is None or not self.can_read(session, m.channel):
            raise NotFoundError("Сообщение не найдено")
        return m

    def edit(self, session: Session, msg_id: int, text: str) -> dict:
        text = text.strip()
        with self.db.session() as s:
            m = self._own(s, session, msg_id)
            if m.author_id != session.user_id:
                raise ForbiddenError("Изменить можно только своё сообщение")
            if m.deleted:
                raise ValidationFailed("Сообщение удалено")
            if self.clock() - m.created_at > EDIT_WINDOW:
                raise ValidationFailed("Изменить можно в течение суток после отправки")
            if not text and not (m.ref or {}).get("photo"):
                raise ValidationFailed("Пустое сообщение")
            m.text = text[:1000]
            m.edited_at = self.clock()
            s.flush()
            reply = s.get(ChatMessage, m.reply_to_id) if m.reply_to_id else None
            out = _out(m, reply)
        self.events.publish("chat.updated", out)
        return out

    def remove(self, session: Session, msg_id: int) -> dict:
        with self.db.session() as s:
            m = self._own(s, session, msg_id)
            admin = session.role == Role.ADMIN and not dm_pair(m.channel)
            if m.author_id != session.user_id and not admin:
                raise ForbiddenError("Удалить можно только своё сообщение")
            m.deleted = True
            m.edited_at = self.clock()
            photo = (m.ref or {}).get("photo") if isinstance(m.ref, dict) else None
            if photo:
                s.execute(delete(ChatFile).where(ChatFile.id == photo["id"]))
            s.flush()
            out = _out(m)
        self.events.publish("chat.updated", out)
        return out

    def system(
        self,
        channel: str,
        text: str,
        *,
        kind: str = "system",
        ref: dict | None = None,
        actor_id: int | None = None,
    ) -> dict | None:
        if channel not in self._codes():
            return None
        try:
            with self.db.session() as s:
                m = ChatMessage(
                    channel=channel,
                    created_at=self.clock(),
                    author_id=None,
                    author="Система",
                    position="",
                    role="system",
                    kind=kind,
                    text=text[:1000],
                    ref=ref,
                    actor_id=actor_id,
                )
                s.add(m)
                s.flush()
                out = _out(m)
        except Exception:
            return None
        self.events.publish("chat.message", out)
        return out

    def read(self, session: Session, channel: str, last_id: int) -> dict:
        self._check(session, channel)
        with self.db.session() as s:
            self._mark(s, session.user_id, channel, last_id)
        if dm_pair(channel):
            self.events.publish("chat.read", {"channel": channel, "user_id": session.user_id, "last_id": last_id})
        return {"ok": True}

    def typing(self, session: Session, channel: str) -> None:
        if not isinstance(channel, str) or len(channel) > 40 or not self.can_read(session, channel):
            return
        if dm_pair(channel) is None and channel not in self._codes():
            return
        self.events.publish("chat.typing", {"channel": channel, "user_id": session.user_id, "name": session.name})

    @staticmethod
    def _mark(s, user_id: int, channel: str, last_id: int) -> None:
        row = s.get(ChatRead, (user_id, channel))
        if row is None:
            s.add(ChatRead(user_id=user_id, channel=channel, last_id=last_id))
        elif last_id > row.last_id:
            row.last_id = last_id

    def purge_older(self, days: int) -> int:
        with self.db.session() as s:
            return (
                s.execute(
                    delete(ChatMessage).where(ChatMessage.created_at < self.clock() - timedelta(days=days))
                ).rowcount
                or 0
            )

    def seed_demo(self, rows: list[tuple[str, datetime, str, str]]) -> None:
        with self.db.session() as s:
            if (s.scalar(select(func.count(ChatMessage.id))) or 0) > 0:
                return
            people = {u.name: u for u in s.scalars(select(User))}
            for ch, at, who, text in rows:
                u = people.get(who)
                s.add(
                    ChatMessage(
                        channel=ch,
                        created_at=at,
                        author_id=u.id if u else None,
                        author=u.name if u else "Система",
                        position=u.position if u else "",
                        role=u.role if u else "system",
                        kind="text" if u else "system",
                        text=text,
                    )
                )
