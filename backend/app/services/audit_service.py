from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime

from sqlalchemy import func, or_, select

from app.core.clock import plant_now
from app.core.events import EventBus
from app.db.base import Database
from app.db.models import AuditEntry

log = logging.getLogger(__name__)

CATEGORIES = {
    "auth": "Вход",
    "control": "Управление цехом",
    "incident": "Инциденты",
    "shift": "Смены",
    "simulation": "Симуляция",
    "scenario": "Сценарии",
    "data": "Данные",
    "assistant": "ИИ-анализ",
    "export": "Выгрузки",
    "builder": "Конструктор",
    "users": "Сотрудники",
    "system": "Система",
}
SEVERITY = {"info": "Информация", "warning": "Внимание", "critical": "Важно"}
SYSTEM = "Система"


def entry_dict(e: AuditEntry, *, show_private: bool = True) -> dict:
    details = dict(e.details or {})
    if not show_private:
        details.pop("ip", None)
    return {
        "id": e.id,
        "at": e.at,
        "plant_time": e.plant_time,
        "category": e.category,
        "category_name": CATEGORIES.get(e.category, e.category),
        "action": e.action,
        "severity": e.severity,
        "actor": e.actor,
        "title": e.title,
        "details": details,
    }


class AuditService:
    def __init__(self, db: Database, tz_offset_min: int, events: EventBus | None = None) -> None:
        self.db = db
        self.tz = tz_offset_min
        self.plant_clock: Callable[[], datetime | None] = lambda: None
        self.events = events

    def log(
        self,
        category: str,
        action: str,
        title: str,
        *,
        actor: str = SYSTEM,
        severity: str = "info",
        details: dict | None = None,
        plant_time: datetime | None = None,
    ) -> None:
        try:
            with self.db.session() as s:
                e = AuditEntry(
                    at=plant_now(self.tz),
                    plant_time=plant_time or self.plant_clock(),
                    category=category,
                    action=action[:40],
                    severity=severity if severity in SEVERITY else "info",
                    actor=actor[:60],
                    title=title[:240],
                    details=_jsonable(details or {}),
                )
                s.add(e)
                s.flush()
                data = entry_dict(e, show_private=False)
            if self.events:
                self.events.publish("journal", data)
        except Exception:
            log.exception("Не удалось записать событие в журнал")

    def purge_older(self, days: int) -> int:
        from datetime import timedelta

        from sqlalchemy import delete

        edge = plant_now(self.tz) - timedelta(days=days)
        with self.db.session() as s:
            return s.execute(delete(AuditEntry).where(AuditEntry.at < edge)).rowcount or 0

    def attach(self, events: EventBus) -> None:
        events.on("incident.created", self._incident_created)
        events.on("incident.updated", self._incident_updated)
        events.on("shift.closed", self._shift_closed)

    def _incident_created(self, d: dict) -> None:
        sev = {"critical": "critical", "warning": "warning"}.get(d.get("severity"), "info")
        if d.get("source") == "worker":
            self.log(
                "incident",
                "reported",
                f"Сообщение с участка: {d['title']}",
                actor=d.get("reported_by") or SYSTEM,
                severity=sev,
                details={
                    "Инцидент": d["id"],
                    "Участок": d.get("area"),
                    "Оборудование": d.get("equipment"),
                    "Комментарий": d.get("details"),
                },
                plant_time=d.get("created_at"),
            )
            return
        self.log(
            "incident",
            "created",
            d["title"],
            severity=sev,
            details={
                "Инцидент": d["id"],
                "Участок": d.get("area"),
                "Оборудование": d.get("equipment"),
                "Описание": d.get("details"),
            },
            plant_time=d.get("created_at"),
        )

    def _incident_updated(self, d: dict) -> None:
        if d.get("status") == "ack":
            self.log(
                "incident",
                "ack",
                f"Принят в работу: {d['title']}",
                actor=d.get("acked_by") or SYSTEM,
                details={"Инцидент": d["id"]},
            )
        elif d.get("status") == "resolved":
            extra = {"Инцидент": d["id"]}
            if d.get("downtime_min") is not None:
                extra["Простой, мин"] = d["downtime_min"]
            if d.get("cost_kzt"):
                extra["Потери, ₸"] = d["cost_kzt"]
            if d.get("resolution"):
                extra["Что сделано"] = d["resolution"]
            self.log(
                "incident",
                "resolved",
                f"Закрыт: {d['title']}",
                actor=d.get("resolved_by") or SYSTEM,
                details=extra,
                plant_time=d.get("resolved_at"),
            )

    def _shift_closed(self, d: dict) -> None:
        self.log(
            "shift", "closed", f"Смена {d['shift']} закрыта: выпущено {d['finished']} авто", details={"День": d["day"]}
        )

    def query(
        self,
        *,
        category: str | None = None,
        severity: str | None = None,
        actor: str | None = None,
        q: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int = 100,
        offset: int = 0,
        show_private: bool = False,
    ) -> dict:
        with self.db.session() as s:
            stmt = select(AuditEntry)
            if category:
                stmt = stmt.where(AuditEntry.category == category)
            if severity:
                stmt = stmt.where(AuditEntry.severity == severity)
            if actor:
                stmt = stmt.where(AuditEntry.actor == actor)
            if since:
                stmt = stmt.where(AuditEntry.at >= since)
            if until:
                stmt = stmt.where(AuditEntry.at <= until)
            if q:
                like = f"%{q.strip()[:80]}%"
                stmt = stmt.where(or_(AuditEntry.title.ilike(like), AuditEntry.actor.ilike(like)))
            total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
            rows = s.scalars(stmt.order_by(AuditEntry.at.desc(), AuditEntry.id.desc()).limit(limit).offset(offset))
            items = [entry_dict(r, show_private=show_private) for r in rows]
            counts = dict(s.execute(select(AuditEntry.category, func.count()).group_by(AuditEntry.category)).all())
            actors = sorted(a for (a,) in s.execute(select(AuditEntry.actor).distinct()).all())
            today = plant_now(self.tz).replace(hour=0, minute=0, second=0, microsecond=0)
            today_n = s.scalar(select(func.count(AuditEntry.id)).where(AuditEntry.at >= today)) or 0
            important = (
                s.scalar(select(func.count(AuditEntry.id)).where(AuditEntry.at >= today, AuditEntry.severity != "info"))
                or 0
            )
        return {
            "items": items,
            "total": total,
            "counts": counts,
            "actors": actors,
            "today": today_n,
            "today_important": important,
            "categories": CATEGORIES,
        }


def _jsonable(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if v is None:
            continue
        if isinstance(v, datetime):
            v = v.isoformat(timespec="seconds")
        elif hasattr(v, "isoformat"):
            v = v.isoformat()
        elif isinstance(v, (list, tuple)):
            v = [str(x) if not isinstance(x, (int, float, str)) else x for x in v]
        elif not isinstance(v, (int, float, str, bool)):
            v = str(v)
        out[str(k)] = v
    return out
