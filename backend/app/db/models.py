from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


SOURCES = "('customer', 'history', 'live', 'import')"


def _area_fk(nullable: bool = False) -> Mapped:
    return mapped_column(String(16), ForeignKey("areas.code", onupdate="CASCADE"), nullable=nullable, index=True)


def _equipment_fk(nullable: bool = False) -> Mapped:
    return mapped_column(String(40), ForeignKey("equipment.code", onupdate="CASCADE"), nullable=nullable, index=True)


def _model_fk() -> Mapped:
    return mapped_column(String(60), ForeignKey("car_models.name", onupdate="CASCADE"), index=True)


def _shift_fk() -> Mapped:
    return mapped_column(Integer, ForeignKey("shifts.number"), default=1)


class AreaRow(Base):
    __tablename__ = "areas"

    code: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[str] = mapped_column(String(60), unique=True)
    kind: Mapped[str] = mapped_column(String(16))
    line: Mapped[str | None] = mapped_column(String(40), nullable=True)
    position: Mapped[int] = mapped_column(Integer)
    cycle_s: Mapped[float] = mapped_column(Float)
    buffer_after: Mapped[int] = mapped_column(Integer)


class EquipmentRow(Base):
    __tablename__ = "equipment"

    code: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(40))
    area: Mapped[str] = _area_fk()
    critical: Mapped[bool] = mapped_column(Boolean, default=False)
    mtbf_h: Mapped[float | None] = mapped_column(Float, nullable=True)
    in_model: Mapped[bool] = mapped_column(Boolean, default=True)


class CarModelRow(Base):
    __tablename__ = "car_models"

    code: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(60), unique=True)
    month_plan: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ShiftRow(Base):
    __tablename__ = "shifts"

    number: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    starts: Mapped[str] = mapped_column(String(5))
    ends: Mapped[str] = mapped_column(String(5))
    hours: Mapped[float] = mapped_column(Float)


class Meta(Base):
    __tablename__ = "meta"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[str] = mapped_column(String(200))


class ProductionRecord(Base):
    __tablename__ = "production"
    __table_args__ = (
        UniqueConstraint("day", "shift", "area"),
        CheckConstraint("plan >= 0 AND fact >= 0", name="ck_production_nonneg"),
        CheckConstraint("run_hours >= 0 AND run_hours <= 24", name="ck_production_hours"),
        CheckConstraint(f"source IN {SOURCES}", name="ck_production_source"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    shift: Mapped[int] = _shift_fk()
    area: Mapped[str] = _area_fk()
    line: Mapped[str] = mapped_column(String(40))
    plan: Mapped[int] = mapped_column(Integer)
    fact: Mapped[int] = mapped_column(Integer)
    run_hours: Mapped[float] = mapped_column(Float)
    load_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="history")


class DowntimeRecord(Base):
    __tablename__ = "downtime"
    __table_args__ = (
        Index("ix_downtime_equipment_day", "equipment", "day"),
        CheckConstraint("minutes >= 0", name="ck_downtime_minutes"),
        CheckConstraint(f"source IN {SOURCES}", name="ck_downtime_source"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    shift: Mapped[int] = _shift_fk()
    area: Mapped[str] = _area_fk()
    equipment: Mapped[str] = _equipment_fk()
    reason: Mapped[str] = mapped_column(String(120))
    minutes: Mapped[float] = mapped_column(Float)
    planned: Mapped[bool] = mapped_column(Boolean, default=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="history")


class ModelPlan(Base):
    __tablename__ = "model_plan"
    __table_args__ = (
        UniqueConstraint("month", "model"),
        CheckConstraint("plan >= 0", name="ck_model_plan_nonneg"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    month: Mapped[str] = mapped_column(String(7))
    model: Mapped[str] = _model_fk()
    plan: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(16), default="customer")


class ModelOutput(Base):
    __tablename__ = "model_output"
    __table_args__ = (
        UniqueConstraint("day", "model"),
        CheckConstraint("qty >= 0", name="ck_model_output_nonneg"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    model: Mapped[str] = _model_fk()
    qty: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(16), default="history")


class QualityRecord(Base):
    __tablename__ = "quality"
    __table_args__ = (
        UniqueConstraint("day", "shift", "area"),
        CheckConstraint("produced >= 0 AND defects >= 0 AND defects <= produced", name="ck_quality_defects"),
        CheckConstraint(f"source IN {SOURCES}", name="ck_quality_source"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    shift: Mapped[int] = _shift_fk()
    area: Mapped[str] = _area_fk()
    produced: Mapped[int] = mapped_column(Integer)
    defects: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(16), default="history")


class Incident(Base):
    __tablename__ = "incidents"
    __table_args__ = (
        CheckConstraint("severity IN ('critical', 'warning', 'info')", name="ck_incident_severity"),
        CheckConstraint("status IN ('open', 'ack', 'resolved')", name="ck_incident_status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    kind: Mapped[str] = mapped_column(String(24))
    severity: Mapped[str] = mapped_column(String(12))
    area: Mapped[str | None] = _area_fk(nullable=True)
    equipment: Mapped[str | None] = _equipment_fk(nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    details: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(12), default="open", index=True)
    acked_by: Mapped[str | None] = mapped_column(String(60), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    downtime_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    cost_kzt: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(12), default="auto")
    reported_by: Mapped[str | None] = mapped_column(String(80), nullable=True)
    line_stopped: Mapped[bool] = mapped_column(Boolean, default=False)
    resolved_by: Mapped[str | None] = mapped_column(String(80), nullable=True)
    resolution: Mapped[str | None] = mapped_column(Text, nullable=True)
    reporter_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    urgency: Mapped[str | None] = mapped_column(String(12), nullable=True)
    reasons: Mapped[list | None] = mapped_column(JSON, nullable=True)
    photo_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    est_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)
    acked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    comments: Mapped[list | None] = mapped_column(JSON, nullable=True)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint("role IN ('admin', 'director', 'supervisor', 'worker')", name="ck_user_role"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    position: Mapped[str] = mapped_column(String(80))
    role: Mapped[str] = mapped_column(String(16), index=True)
    area: Mapped[str | None] = _area_fk(nullable=True)
    login: Mapped[str | None] = mapped_column(String(40), unique=True, index=True, nullable=True)
    pin_hash: Mapped[str] = mapped_column(String(200))
    pin_key: Mapped[str | None] = mapped_column(String(64), unique=True, index=True, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_login: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    status: Mapped[str | None] = mapped_column(String(12), nullable=True, default="active")
    request_note: Mapped[str | None] = mapped_column(Text, nullable=True)


class ShiftSession(Base):
    __tablename__ = "shift_sessions"
    __table_args__ = (UniqueConstraint("day", "shift"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    shift: Mapped[int] = _shift_fk()
    supervisor: Mapped[str] = mapped_column(String(80))
    started_at: Mapped[datetime] = mapped_column(DateTime)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    plan: Mapped[int] = mapped_column(Integer)
    staff: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    summary: Mapped[dict] = mapped_column(JSON, default=dict)


class ShiftReady(Base):
    __tablename__ = "shift_ready"
    __table_args__ = (
        UniqueConstraint("shift_id", "user_id"),
        CheckConstraint("status IN ('ready', 'absent')", name="ck_shift_ready_status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    shift_id: Mapped[int] = mapped_column(Integer, index=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    name: Mapped[str] = mapped_column(String(80))
    area: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(String(12))
    note: Mapped[str] = mapped_column(Text, default="")
    at: Mapped[datetime] = mapped_column(DateTime)


class ImportLog(Base):
    __tablename__ = "imports"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    filename: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20))
    summary: Mapped[dict] = mapped_column(JSON, default=dict)


class SettingValue(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)


class AuditEntry(Base):
    __tablename__ = "audit_log"
    __table_args__ = (
        CheckConstraint("severity IN ('info', 'warning', 'critical')", name="ck_audit_severity"),
        Index("ix_audit_category_at", "category", "at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime, index=True)
    plant_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    category: Mapped[str] = mapped_column(String(16))
    action: Mapped[str] = mapped_column(String(40))
    severity: Mapped[str] = mapped_column(String(10), default="info")
    actor: Mapped[str] = mapped_column(String(60))
    title: Mapped[str] = mapped_column(String(240))
    details: Mapped[dict] = mapped_column(JSON, default=dict)


class BuilderLayout(Base):
    __tablename__ = "builder_layouts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    data: Mapped[dict] = mapped_column(JSON)
    nodes: Mapped[int] = mapped_column(Integer, default=0)
    equipment: Mapped[int] = mapped_column(Integer, default=0)
    author: Mapped[str] = mapped_column(String(60))
    updated_at: Mapped[datetime] = mapped_column(DateTime, index=True)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (Index("ix_chat_channel_id", "channel", "id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    channel: Mapped[str] = mapped_column(String(24), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    author_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    author: Mapped[str] = mapped_column(String(80))
    position: Mapped[str] = mapped_column(String(80), default="")
    role: Mapped[str] = mapped_column(String(16), default="system")
    kind: Mapped[str] = mapped_column(String(10), default="text")
    text: Mapped[str] = mapped_column(Text)
    ref: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    reply_to_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deleted: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=False)
    actor_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ChatRead(Base):
    __tablename__ = "chat_reads"

    user_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel: Mapped[str] = mapped_column(String(24), primary_key=True)
    last_id: Mapped[int] = mapped_column(Integer, default=0)


class ChatFile(Base):
    __tablename__ = "chat_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    channel: Mapped[str] = mapped_column(String(24), index=True)
    author_id: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    mime: Mapped[str] = mapped_column(String(20))
    size: Mapped[int] = mapped_column(Integer)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    data: Mapped[bytes] = mapped_column(LargeBinary)
