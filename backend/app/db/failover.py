from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime

from sqlalchemy import Engine, Integer, func, inspect, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session

from app.db.base import Database
from app.db.models import Base

log = logging.getLogger(__name__)

CHUNK = 1000


def _is_connection_error(e: Exception) -> bool:
    if isinstance(e, OperationalError):
        return True
    return isinstance(e, DBAPIError) and bool(getattr(e, "connection_invalidated", False))


def ping(db: Database) -> bool:
    try:
        with db.engine.connect() as c:
            c.execute(text("select 1"))
        return True
    except Exception:
        return False


def replicate(src: Database, dst: Database) -> dict[str, int]:
    tables = Base.metadata.sorted_tables
    counts: dict[str, int] = {}
    dst_names = set(inspect(dst.engine).get_table_names())
    with src.engine.connect() as sc, dst.engine.begin() as dc:
        if src.engine.dialect.name == "postgresql":
            sc.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        for t in reversed(tables):
            if t.name in dst_names:
                dc.execute(t.delete())
        for t in tables:
            if t.name not in dst_names:
                continue
            rows = [dict(r) for r in sc.execute(select(t)).mappings()]
            for i in range(0, len(rows), CHUNK):
                dc.execute(t.insert(), rows[i : i + CHUNK])
            counts[t.name] = len(rows)
        if dst.engine.dialect.name == "postgresql":
            for t in tables:
                pk = list(t.primary_key.columns)
                if t.name in dst_names and len(pk) == 1 and isinstance(pk[0].type, Integer) and pk[0].autoincrement:
                    sql = (
                        f"SELECT setval(pg_get_serial_sequence('{t.name}', '{pk[0].name}'), "
                        f"COALESCE((SELECT MAX({pk[0].name}) FROM {t.name}), 0) + 1, false)"
                    )
                    dc.execute(text(sql))
    return counts


class FailoverDatabase:
    def __init__(
        self,
        local: Database,
        primary: Database | None = None,
        *,
        primary_label: str = "Supabase",
        check_s: float = 20,
        mirror_min: float = 5,
    ) -> None:
        self.local = local
        self.primary = primary
        self.label = primary_label
        self.check_s = check_s
        self.mirror_s = mirror_min * 60
        self._active: Database = local
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._fails = 0
        self._announced: bool | None = None
        self.on_switch: list[Callable[[dict], None]] = []
        self.prepare: Callable[[Database], None] = lambda db: db.create_all()
        self.state: dict = {
            "configured": primary is not None,
            "mode": "local",
            "primary_ok": None,
            "since": datetime.now(),
            "last_mirror": None,
            "last_error": None,
            "outage": False,
            "needs_decision": False,
        }

    @property
    def engine(self) -> Engine:
        return self._active.engine

    @property
    def is_primary(self) -> bool:
        return self.primary is not None and self._active is self.primary

    def create_all(self) -> None:
        self._active.create_all()

    def drop_all(self) -> None:
        self._active.drop_all()

    @contextmanager
    def session(self) -> Iterator[Session]:
        db = self._active
        try:
            with db.session() as s:
                yield s
        except Exception as e:
            if db is self.primary and _is_connection_error(e) and not ping(db):
                self._failover(f"ошибка соединения: {type(e).__name__}")
            raise

    def connect(self) -> str:
        if self.primary is None:
            return "local"
        if ping(self.primary):
            self._active = self.primary
            self.state.update(mode="primary", primary_ok=True, since=datetime.now())
            log.info("База данных: %s", self.label)
        else:
            self.state.update(mode="local", primary_ok=False, needs_decision=True, last_error="нет связи при старте")
            log.warning("%s недоступен при старте — работаю на локальной базе", self.label)
        return self.state["mode"]

    def hold_local_for_decision(self) -> None:
        if self.primary is None or not self.state["primary_ok"]:
            raise RuntimeError(f"{self.label} должен быть доступен для выбора базы")
        with self._lock:
            self._active = self.local
            self.state.update(
                mode="local",
                since=datetime.now(),
                outage=False,
                needs_decision=True,
                last_error="локальная база содержит несинхронизированные данные",
            )

    def start(self) -> None:
        if self.primary is None or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._watch, name="db-watch", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _notify(self) -> None:
        for fn in self.on_switch:
            try:
                fn(self.status())
            except Exception:
                log.exception("Ошибка обработчика смены базы")

    def _failover(self, reason: str) -> None:
        with self._lock:
            if not self.is_primary:
                return
            self._active = self.local
            self.state.update(
                mode="local",
                primary_ok=False,
                since=datetime.now(),
                last_error=reason,
                outage=True,
                needs_decision=False,
            )
        log.error("%s недоступен (%s) — переключился на локальную базу", self.label, reason)
        self._notify()

    def mirror_now(self) -> dict[str, int]:
        if not self.is_primary or self.primary is None:
            raise RuntimeError("Зеркало делается, только пока основная база — " + self.label)
        counts = replicate(self.primary, self.local)
        self.state["last_mirror"] = datetime.now()
        return counts

    def use_primary(self, *, transfer: bool) -> dict:
        if self.primary is None:
            raise RuntimeError(f"{self.label} не настроен")
        with self._lock:
            if self.is_primary:
                return self.status()
            if not ping(self.primary):
                raise RuntimeError(f"{self.label} пока недоступен")
            if transfer:
                self.prepare(self.primary)
                replicate(self.local, self.primary)
            self._active = self.primary
            self.state.update(
                mode="primary",
                primary_ok=True,
                since=datetime.now(),
                outage=False,
                needs_decision=False,
                last_error=None,
            )
        log.info("Снова работаю на %s (перенос локальных данных: %s)", self.label, "да" if transfer else "нет")
        self._notify()
        return self.status()

    def _watch(self) -> None:
        last_mirror = 0.0
        while not self._stop.wait(self.check_s):
            assert self.primary is not None
            ok = ping(self.primary)
            self.state["primary_ok"] = ok
            if self.is_primary:
                if ok:
                    self._fails = 0
                    if time.monotonic() - last_mirror >= self.mirror_s:
                        try:
                            self.mirror_now()
                            last_mirror = time.monotonic()
                        except Exception as e:
                            log.warning("Зеркало не обновлено: %s", e)
                            if _is_connection_error(e):
                                self._failover("обрыв при копировании")
                else:
                    self._fails += 1
                    if self._fails >= 2:
                        self._failover("нет ответа на проверку связи")
            elif ok and self.state["outage"]:
                try:
                    self.use_primary(transfer=True)
                    last_mirror = time.monotonic()
                except Exception as e:
                    log.warning("Вернуться на %s не удалось: %s", self.label, e)
            elif self.state["needs_decision"] and ok != self._announced:
                self._announced = ok
                self._notify()

    def status(self) -> dict:
        s = dict(self.state)
        s["label"] = self.label
        s["active"] = self.label if self.is_primary else "локальная база"
        s["local_kind"] = self.local.engine.dialect.name
        return s

    def counts(self) -> dict[str, int]:
        from app.db.models import AuditEntry, ChatMessage, Incident, User

        with self.session() as s:
            return {
                "users": s.scalar(select(func.count(User.id))) or 0,
                "incidents": s.scalar(select(func.count(Incident.id))) or 0,
                "journal": s.scalar(select(func.count(AuditEntry.id))) or 0,
                "chat": s.scalar(select(func.count(ChatMessage.id))) or 0,
            }
