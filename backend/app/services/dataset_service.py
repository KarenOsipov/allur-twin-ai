from __future__ import annotations

import logging
from datetime import date, datetime
from pathlib import Path

from sqlalchemy import delete, select

from app.core.errors import ValidationFailed
from app.db.base import Database
from app.db.models import (
    AuditEntry,
    BuilderLayout,
    ChatMessage,
    ChatRead,
    DowntimeRecord,
    Incident,
    ModelPlan,
    ProductionRecord,
    QualityRecord,
    SettingValue,
    ShiftReady,
    ShiftSession,
    User,
)
from app.db.schema import ensure_equipment, ensure_model

log = logging.getLogger(__name__)

FORMAT = "allur-dataset"
VERSION = 1
FLOOR_KEY = "floor_layout"
KEEP_KEYS = (FLOOR_KEY, "pin_pepper")
SEED_FILE = Path(__file__).resolve().parents[1] / "seed" / "dataset.json"

TABLES = {
    "users": (
        User,
        ["name", "position", "role", "area", "login", "pin_hash", "active", "created_at", "status", "request_note"],
    ),
    "layouts": (BuilderLayout, ["name", "data", "nodes", "equipment", "author", "updated_at"]),
    "settings": (SettingValue, ["key", "value"]),
    "production": (
        ProductionRecord,
        ["day", "shift", "area", "line", "plan", "fact", "run_hours", "load_pct", "source"],
    ),
    "quality": (QualityRecord, ["day", "shift", "area", "produced", "defects", "source"]),
    "downtime": (
        DowntimeRecord,
        ["day", "shift", "area", "equipment", "reason", "minutes", "planned", "started_at", "source"],
    ),
    "model_plan": (ModelPlan, ["month", "model", "plan", "source"]),
    "shifts": (
        ShiftSession,
        ["day", "shift", "supervisor", "started_at", "closed_at", "plan", "staff", "note", "summary"],
    ),
    "incidents": (
        Incident,
        [
            "created_at",
            "kind",
            "severity",
            "area",
            "equipment",
            "title",
            "details",
            "status",
            "acked_by",
            "resolved_at",
            "downtime_min",
            "cost_kzt",
            "source",
            "reported_by",
            "line_stopped",
            "resolved_by",
            "resolution",
            "urgency",
            "reasons",
            "est_minutes",
            "acked_at",
            "comments",
        ],
    ),
    "journal": (AuditEntry, ["at", "plant_time", "category", "action", "severity", "actor", "title", "details"]),
    "chat": (ChatMessage, ["channel", "created_at", "author", "position", "role", "kind", "text", "ref", "deleted"]),
}
FACT_SOURCES = ("customer", "import")
DATE_FIELDS = {"day"}
DATETIME_FIELDS = {
    "created_at",
    "updated_at",
    "started_at",
    "closed_at",
    "resolved_at",
    "at",
    "plant_time",
    "acked_at",
}


def _ser(v):
    if isinstance(v, datetime):
        return v.isoformat(timespec="seconds")
    if isinstance(v, date):
        return v.isoformat()
    return v


def _de(field: str, v):
    if v is None:
        return None
    if field in DATETIME_FIELDS:
        return datetime.fromisoformat(v)
    if field in DATE_FIELDS:
        return date.fromisoformat(v)
    return v


def export(db: Database, journal_limit: int = 5000) -> dict:
    out: dict = {"format": FORMAT, "version": VERSION, "exported_at": datetime.now().isoformat(timespec="seconds")}
    with db.session() as s:
        for name, (model, fields) in TABLES.items():
            q = select(model)
            if name == "chat":
                q = q.where(ChatMessage.channel.not_like("dm:%")).order_by(ChatMessage.id)
            if name in ("production", "quality", "downtime", "model_plan"):
                q = q.where(model.source.in_(FACT_SOURCES))
            if name == "journal":
                q = q.order_by(AuditEntry.at.desc()).limit(journal_limit)
            out[name] = [{f: _ser(getattr(r, f)) for f in fields} for r in s.scalars(q)]
            if name == "settings":
                out[name] = [r for r in out[name] if r["key"] not in KEEP_KEYS]
        row = s.get(SettingValue, FLOOR_KEY)
        if row and row.value and row.value.get("id"):
            x = s.get(BuilderLayout, row.value["id"])
            out["floor_layout"] = x.name if x else None
    out["counts"] = {k: len(out[k]) for k in TABLES}
    return out


def validate(data: dict) -> None:
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise ValidationFailed("Это не файл набора данных Allur (нет признака format = allur-dataset)")
    if int(data.get("version", 0)) > VERSION:
        raise ValidationFailed("Файл из более новой версии системы")
    for name in TABLES:
        if name in data and not isinstance(data[name], list):
            raise ValidationFailed(f"Раздел «{name}» должен быть списком")
    users = data.get("users") or []
    if users and not any(u.get("role") == "admin" and u.get("active", True) for u in users):
        raise ValidationFailed("В наборе нет активного администратора — после загрузки никто не сможет войти")


def load(db: Database, data: dict) -> dict:
    validate(data)
    counts: dict[str, int] = {}
    with db.session() as s:
        for name, (model, fields) in TABLES.items():
            if name not in data:
                continue
            rows = data[name]
            if name == "chat":
                s.execute(delete(ChatRead))
                s.execute(delete(model))
                s.flush()
                ids = {u.name: u.id for u in s.scalars(select(User))}
                rows = [r for r in rows if not str(r.get("channel", "")).startswith("dm:")]
                for r in rows:
                    values = {f: _de(f, r.get(f)) for f in fields if f in r}
                    ref = values.get("ref")
                    if isinstance(ref, dict) and "photo" in ref:
                        values["ref"] = {k: v for k, v in ref.items() if k != "photo"} or None
                    values["author_id"] = ids.get(values.get("author", "")) if values.get("role") != "system" else None
                    s.add(model(**values))
                counts[name] = len(rows)
                continue
            if name in ("production", "quality", "downtime", "model_plan"):
                s.execute(delete(model).where(model.source.in_(FACT_SOURCES)))
            elif name == "settings":
                s.execute(delete(model).where(model.key.not_in(KEEP_KEYS)))
                rows = [r for r in rows if r.get("key") not in KEEP_KEYS]
            else:
                if name == "shifts":
                    s.execute(delete(ShiftReady))
                s.execute(delete(model))
            s.flush()
            for r in rows:
                values = {f: _de(f, r.get(f)) for f in fields if f in r}
                if name == "downtime":
                    ensure_equipment(s, values["equipment"], values["area"])
                if name == "model_plan":
                    ensure_model(s, values["model"])
                if name in ("production", "quality"):
                    s.execute(
                        delete(model).where(
                            model.day == values["day"], model.shift == values["shift"], model.area == values["area"]
                        )
                    )
                s.add(model(**values))
            counts[name] = len(rows)
        if "layouts" in data:
            s.flush()
            s.execute(delete(SettingValue).where(SettingValue.key == FLOOR_KEY))
            wanted = data.get("floor_layout")
            x = s.scalars(select(BuilderLayout).where(BuilderLayout.name == wanted)).first() if wanted else None
            if x is not None:
                s.add(SettingValue(key=FLOOR_KEY, value={"id": x.id, "by": "набор данных"}))
    return counts


def load_seed_file(db: Database) -> dict | None:
    if not SEED_FILE.exists():
        return None
    import json

    try:
        data = json.loads(SEED_FILE.read_text(encoding="utf-8"))
        counts = load(db, data)
        log.info("Загружен набор данных %s: %s", SEED_FILE.name, counts)
        return counts
    except Exception:
        log.exception("Не удалось загрузить %s — продолжаю с демо-данными", SEED_FILE)
        return None
