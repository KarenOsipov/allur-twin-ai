from __future__ import annotations

from datetime import datetime

from sqlalchemy import delete, func, select

from app.core.errors import NotFoundError, ValidationFailed
from app.core.events import EventBus
from app.db.base import Database
from app.db.models import Incident


def to_dict(i: Incident) -> dict:
    return {
        "id": i.id,
        "created_at": i.created_at,
        "kind": i.kind,
        "severity": i.severity,
        "area": i.area,
        "equipment": i.equipment,
        "title": i.title,
        "details": i.details,
        "status": i.status,
        "acked_by": i.acked_by,
        "resolved_at": i.resolved_at,
        "downtime_min": i.downtime_min,
        "cost_kzt": i.cost_kzt,
        "source": i.source,
        "reported_by": i.reported_by,
        "line_stopped": i.line_stopped,
        "resolved_by": i.resolved_by,
        "resolution": i.resolution,
        "reporter_id": i.reporter_id,
        "urgency": i.urgency,
        "reasons": i.reasons or [],
        "photo_id": i.photo_id,
        "est_minutes": i.est_minutes,
        "acked_at": i.acked_at,
        "comments": i.comments or [],
    }


URGENCY_SEVERITY = {"high": "critical", "normal": "warning", "low": "info"}

PROBLEM_KIND = {
    "equipment": ("equipment", "Поломка"),
    "supply": ("supply", "Нет комплектующих"),
    "quality": ("quality", "Брак"),
    "safety": ("safety", "Опасная ситуация"),
    "other": ("other", "Проблема"),
}


class IncidentService:
    def __init__(self, db: Database, events: EventBus, margin_per_car) -> None:
        self.db = db
        self.events = events
        self._margin = margin_per_car

    def purge_auto_since(self, since: datetime) -> None:
        with self.db.session() as s:
            s.execute(delete(Incident).where(Incident.created_at >= since, Incident.acked_by.is_(None)))

    def create(
        self,
        *,
        at: datetime,
        kind: str,
        severity: str,
        area: str | None,
        equipment: str | None,
        title: str,
        details: str = "",
    ) -> dict:
        with self.db.session() as s:
            existing = s.scalar(
                select(Incident).where(
                    Incident.created_at == at,
                    Incident.kind == kind,
                    Incident.title == title[:200],
                )
            )
            if existing is not None:
                return to_dict(existing)
            inc = Incident(
                created_at=at,
                kind=kind,
                severity=severity,
                area=area,
                equipment=equipment,
                title=title[:200],
                details=details,
                status="open",
            )
            s.add(inc)
            s.flush()
            data = to_dict(inc)
        self.events.publish("incident.created", data)
        return data

    def report(
        self,
        *,
        at: datetime,
        kind: str,
        area: str | None,
        equipment: str | None,
        text: str,
        line_stopped: bool,
        reporter: str,
        area_name: str,
        reporter_id: int | None = None,
        urgency: str | None = None,
        reasons: list[str] | None = None,
        photo_id: int | None = None,
        est_minutes: float | None = None,
    ) -> dict:
        k, label = PROBLEM_KIND[kind]
        what = f"{label}: {equipment}" if equipment else f"{label} — {area_name.lower()}"
        severity = URGENCY_SEVERITY.get(urgency or "normal", "warning")
        if line_stopped or kind == "safety":
            severity = "critical"
        reasons = [r.strip()[:60] for r in (reasons or []) if r and r.strip()][:6]
        details = text or ("; ".join(reasons) if reasons else "Без комментария")
        with self.db.session() as s:
            inc = Incident(
                created_at=at,
                kind=k,
                severity=severity,
                area=area,
                equipment=equipment,
                title=(what + (" · линия стоит" if line_stopped else ""))[:200],
                details=details,
                status="open",
                source="worker",
                reported_by=reporter[:80],
                line_stopped=line_stopped,
                reporter_id=reporter_id,
                urgency=urgency,
                reasons=reasons or None,
                photo_id=photo_id,
                est_minutes=est_minutes,
            )
            s.add(inc)
            s.flush()
            data = to_dict(inc)
        self.events.publish("incident.created", data)
        self.events.publish("problem.reported", data)
        return data

    def get(self, incident_id: int) -> dict:
        with self.db.session() as s:
            inc = s.get(Incident, incident_id)
            if inc is None:
                raise NotFoundError("Инцидент не найден")
            return to_dict(inc)

    def mine(self, reporter: str, limit: int = 20, reporter_id: int | None = None) -> list[dict]:
        with self.db.session() as s:
            who = Incident.reported_by == reporter
            if reporter_id is not None:
                who = (Incident.reporter_id == reporter_id) | (Incident.reporter_id.is_(None) & who)
            rows = s.scalars(
                select(Incident)
                .where(Incident.source == "worker", who)
                .order_by(Incident.created_at.desc(), Incident.id.desc())
                .limit(limit)
            )
            return [to_dict(i) for i in rows]

    def resolve_auto(
        self,
        incident_id: int,
        at: datetime,
        minutes: float | None,
        lost_cars: float | None,
    ) -> None:
        with self.db.session() as s:
            inc = s.get(Incident, incident_id)
            if inc is None:
                return
            if inc.status == "resolved" and inc.downtime_min is not None:
                return
            changed = inc.status != "resolved"
            if changed:
                inc.status = "resolved"
                inc.resolved_at = at
            if minutes is not None:
                inc.downtime_min = round(minutes, 1)
            if lost_cars is not None:
                inc.cost_kzt = int(lost_cars * self._margin())
            data = to_dict(inc)
        self.events.publish("incident.updated", data)
        if changed:
            self._notify(data, "resolve", "модель цеха", None, "Оборудование снова работает")

    def resolve_kind(self, kind: str, at: datetime) -> None:
        with self.db.session() as s:
            rows = list(s.scalars(select(Incident).where(Incident.kind == kind, Incident.status != "resolved")))
            for inc in rows:
                inc.status = "resolved"
                inc.resolved_at = at
            data = [to_dict(i) for i in rows]
        for d in data:
            self.events.publish("incident.updated", d)

    def _notify(self, data: dict, action: str, by: str | None, by_id: int | None, text: str | None = None) -> None:
        if data.get("source") != "worker":
            return
        self.events.publish(
            "problem.update",
            {
                "action": action,
                "by": by,
                "by_id": by_id,
                "text": text,
                "reporter_id": data.get("reporter_id"),
                "reported_by": data.get("reported_by"),
                "incident": data,
            },
        )

    def ack(self, incident_id: int, by: str, at: datetime | None = None, by_id: int | None = None) -> dict:
        with self.db.session() as s:
            inc = s.get(Incident, incident_id)
            if inc is None:
                raise NotFoundError("Инцидент не найден")
            if inc.status == "resolved":
                raise ValidationFailed("Инцидент уже закрыт")
            inc.status = "ack"
            inc.acked_by = by
            inc.acked_at = at
            data = to_dict(inc)
        self.events.publish("incident.updated", data)
        self._notify(data, "ack", by, by_id)
        return data

    def resolve(
        self,
        incident_id: int,
        at: datetime,
        by: str | None = None,
        resolution: str | None = None,
        by_id: int | None = None,
    ) -> dict:
        with self.db.session() as s:
            inc = s.get(Incident, incident_id)
            if inc is None:
                raise NotFoundError("Инцидент не найден")
            inc.status = "resolved"
            inc.resolved_at = inc.resolved_at or at
            inc.resolved_by = by
            if resolution:
                inc.resolution = resolution
            if inc.acked_by is None:
                inc.acked_by = by
                inc.acked_at = inc.acked_at or at
            data = to_dict(inc)
        self.events.publish("incident.updated", {**data, "resolved_by": by})
        self._notify(data, "resolve", by, by_id, data.get("resolution"))
        return data

    def comment(self, incident_id: int, text: str, at: datetime, by: str, by_id: int | None = None) -> dict:
        text = text.strip()[:500]
        if not text:
            raise ValidationFailed("Пустой комментарий")
        with self.db.session() as s:
            inc = s.get(Incident, incident_id)
            if inc is None:
                raise NotFoundError("Инцидент не найден")
            items = list(inc.comments or [])
            items.append({"at": at.isoformat(timespec="seconds"), "by": by, "by_id": by_id, "text": text})
            inc.comments = items[-30:]
            data = to_dict(inc)
        self.events.publish("incident.updated", data)
        self._notify(data, "comment", by, by_id, text)
        return data

    def list(
        self,
        status: str | None = None,
        severity: str | None = None,
        limit: int = 100,
        offset: int = 0,
        source: str | None = None,
    ) -> dict:
        with self.db.session() as s:
            q = select(Incident)
            if source == "worker":
                q = q.where(Incident.source == "worker")
            elif source == "auto":
                q = q.where(Incident.source != "worker")
            if status == "active":
                q = q.where(Incident.status != "resolved")
            elif status:
                q = q.where(Incident.status == status)
            if severity:
                q = q.where(Incident.severity == severity)
            total = s.scalar(select(func.count()).select_from(q.subquery())) or 0
            rows = s.scalars(q.order_by(Incident.created_at.desc(), Incident.id.desc()).limit(limit).offset(offset))
            items = [to_dict(i) for i in rows]
            open_count = s.scalar(select(func.count(Incident.id)).where(Incident.status != "resolved")) or 0
            cost = s.scalar(select(func.coalesce(func.sum(Incident.cost_kzt), 0))) or 0
        return {
            "items": items,
            "total": total,
            "active": open_count,
            "cost_kzt": int(cost),
        }
