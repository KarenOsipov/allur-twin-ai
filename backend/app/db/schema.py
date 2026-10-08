from __future__ import annotations

import logging
import re

from sqlalchemy import MetaData, inspect, select, text
from sqlalchemy.orm import Session

from app.db.base import Database
from app.db.models import AreaRow, Base, CarModelRow, EquipmentRow, Meta, ShiftRow
from app.domain.plant import Plant

log = logging.getLogger(__name__)

SCHEMA_VERSION = "3"

SUPPLY_CODE = "Поставка"

VIEWS: dict[str, str] = {
    "v_shift_output": """
        SELECT p.day, p.shift, a.name AS area, p.line, p.plan, p.fact,
               p.fact - p.plan AS deviation,
               ROUND(CAST(100.0 * p.fact / NULLIF(p.plan, 0) AS NUMERIC), 2) AS plan_pct,
               p.run_hours, p.load_pct, p.source
        FROM production p JOIN areas a ON a.code = p.area
    """,
    "v_quality": """
        SELECT q.day, q.shift, a.name AS area, q.produced, q.defects,
               ROUND(CAST(100.0 * q.defects / NULLIF(q.produced, 0) AS NUMERIC), 2) AS defect_pct, q.source
        FROM quality q JOIN areas a ON a.code = q.area
    """,
    "v_downtime": """
        SELECT d.day, d.shift, a.name AS area, d.equipment, e.name AS equipment_name,
               e.critical, d.reason, d.minutes, d.planned, d.source
        FROM downtime d
        JOIN areas a ON a.code = d.area
        JOIN equipment e ON e.code = d.equipment
    """,
    "v_daily_summary": """
        SELECT p.day,
               SUM(p.plan) AS plan,
               SUM(p.fact) AS cars,
               (SELECT ROUND(CAST(100.0 * SUM(q.defects) / NULLIF(SUM(q.produced), 0) AS NUMERIC), 2)
                  FROM quality q WHERE q.day = p.day) AS defect_pct,
               (SELECT ROUND(CAST(COALESCE(SUM(d.minutes), 0) AS NUMERIC), 1)
                  FROM downtime d WHERE d.day = p.day AND NOT d.planned) AS unplanned_downtime_min
        FROM production p
        WHERE p.area = 'ASSY'
        GROUP BY p.day
    """,
    "v_equipment_downtime": """
        SELECT e.code, e.name, a.name AS area, e.critical,
               COUNT(d.id) AS stops,
               ROUND(CAST(COALESCE(SUM(d.minutes), 0) AS NUMERIC), 1) AS minutes,
               MAX(d.day) AS last_stop
        FROM equipment e
        JOIN areas a ON a.code = e.area
        LEFT JOIN downtime d ON d.equipment = e.code AND NOT d.planned
        GROUP BY e.code, e.name, a.name, e.critical
    """,
    "v_model_plan": """
        SELECT mp.month, mp.model, mp.plan,
               COALESCE((SELECT SUM(mo.qty) FROM model_output mo
                          WHERE mo.model = mp.model
                            AND SUBSTR(CAST(mo.day AS TEXT), 1, 7) = mp.month), 0) AS fact
        FROM model_plan mp
    """,
}


def prepare_database(db: Database, plant: Plant) -> None:
    if _outdated(db):
        log.warning("Схема базы устарела — пересоздаю таблицы (данные заказчика загрузятся заново)")
        drop_views(db)
        old = MetaData()
        old.reflect(db.engine)
        if "app_failover_state" in old.tables:
            old.remove(old.tables["app_failover_state"])
        old.drop_all(db.engine)
    db.create_all()
    _add_columns(db)
    with db.session() as s:
        sync_reference(s, plant)
        s.merge(Meta(key="schema_version", value=SCHEMA_VERSION))
    create_views(db)
    lock_down_rest_api(db)


def lock_down_rest_api(db: Database) -> None:
    if db.engine.dialect.name != "postgresql":
        return
    tables = [t.name for t in Base.metadata.sorted_tables]
    with db.engine.begin() as conn:
        roles = {
            r for (r,) in conn.execute(text("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')"))
        }
        auth_schema_exists = conn.execute(text("SELECT 1 FROM pg_namespace WHERE nspname = 'auth'")).scalar()
        can_configure_realtime = (
            "authenticated" in roles and "chat_messages" in tables and bool(auth_schema_exists)
        )
        if "authenticated" in roles and "chat_messages" in tables and not auth_schema_exists:
            log.warning("PostgreSQL auth schema is missing; chat will use the WebSocket fallback")
        views = [v for (v,) in conn.execute(text("SELECT viewname FROM pg_views WHERE schemaname = current_schema()"))]
        for role in sorted(roles):
            conn.execute(text(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM {role}"))
            conn.execute(text(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM {role}"))
        for t in tables:
            conn.execute(text(f'ALTER TABLE "{t}" ENABLE ROW LEVEL SECURITY'))
        for r in sorted(roles):
            for name in tables + [v for v in views if v.startswith("v_")]:
                conn.execute(text(f'REVOKE ALL ON "{name}" FROM {r}'))
            conn.execute(text(f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {r}"))

        if can_configure_realtime:
            conn.execute(
                text(
                    """
                    CREATE OR REPLACE FUNCTION public.can_read_chat_message(target_channel text)
                    RETURNS boolean
                    LANGUAGE sql
                    STABLE
                    SECURITY DEFINER
                    SET search_path = ''
                    AS $function$
                        SELECT EXISTS (
                            SELECT 1
                            FROM public.users AS employee
                            WHERE employee.id = CASE
                                WHEN COALESCE(auth.jwt() -> 'app_metadata' ->> 'user_id', '') ~ '^[0-9]+$'
                                THEN (auth.jwt() -> 'app_metadata' ->> 'user_id')::integer
                                ELSE NULL
                            END
                            AND employee.active IS TRUE
                            AND (employee.status IS NULL OR employee.status = 'active')
                            AND (
                                target_channel = 'all'
                                OR target_channel ~ (
                                    '^dm:('
                                    || employee.id::text
                                    || '-[0-9]+|[0-9]+-'
                                    || employee.id::text
                                    || ')$'
                                )
                                OR (
                                    employee.role <> 'worker'
                                    AND target_channel !~ '^dm:'
                                )
                                OR (
                                    employee.role = 'worker'
                                    AND target_channel = employee.area
                                )
                            )
                        )
                    $function$
                    """
                )
            )
            conn.execute(text("REVOKE ALL ON FUNCTION public.can_read_chat_message(text) FROM PUBLIC"))
            for r in sorted(roles):
                conn.execute(text(f"REVOKE ALL ON FUNCTION public.can_read_chat_message(text) FROM {r}"))

        if "chat_messages" in tables:
            conn.execute(text('DROP POLICY IF EXISTS "chat_messages_select_all" ON "chat_messages"'))
            conn.execute(text('DROP POLICY IF EXISTS "chat_messages_insert_all" ON "chat_messages"'))
            conn.execute(text('DROP POLICY IF EXISTS "chat_messages_realtime_select" ON "chat_messages"'))
            if can_configure_realtime:
                conn.execute(text('GRANT SELECT ON "chat_messages" TO authenticated'))
                conn.execute(text("GRANT EXECUTE ON FUNCTION public.can_read_chat_message(text) TO authenticated"))
                conn.execute(
                    text(
                        """
                        CREATE POLICY "chat_messages_realtime_select" ON "chat_messages"
                        FOR SELECT TO authenticated
                        USING (public.can_read_chat_message(channel))
                        """
                    )
                )
                conn.execute(text('ALTER TABLE "chat_messages" REPLICA IDENTITY FULL'))
                published = conn.execute(
                    text(
                        "SELECT 1 FROM pg_publication_tables "
                        "WHERE pubname = 'supabase_realtime' "
                        "AND schemaname = current_schema() AND tablename = 'chat_messages'"
                    )
                ).scalar()
                if not published:
                    publication_exists = conn.execute(
                        text("SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'")
                    ).scalar()
                    if publication_exists:
                        conn.execute(text('ALTER PUBLICATION supabase_realtime ADD TABLE "chat_messages"'))
                    else:
                        log.warning("Supabase Realtime publication is missing; chat will use the WebSocket fallback")

    if roles:
        log.info("Supabase: права anon/authenticated на таблицы и последовательности отозваны")


_NEW_COLUMNS = {
    "users": [
        ("login", "VARCHAR(40)", True),
        ("pin_key", "VARCHAR(64)", True),
        ("status", "VARCHAR(12)", False),
        ("request_note", "TEXT", False),
    ],
    "chat_messages": [
        ("reply_to_id", "INTEGER", False),
        ("edited_at", "TIMESTAMP", False),
        ("deleted", "BOOLEAN", False),
        ("actor_id", "INTEGER", False),
    ],
    "incidents": [
        ("reporter_id", "INTEGER", False),
        ("urgency", "VARCHAR(12)", False),
        ("reasons", "JSON", False),
        ("photo_id", "INTEGER", False),
        ("est_minutes", "FLOAT", False),
        ("acked_at", "TIMESTAMP", False),
        ("comments", "JSON", False),
    ],
}


def _add_columns(db: Database) -> None:
    insp = inspect(db.engine)
    for table, cols in _NEW_COLUMNS.items():
        have = {c["name"] for c in insp.get_columns(table)}
        for name, sql_type, unique in cols:
            if name in have:
                continue
            log.warning("Добавляю колонку %s.%s", table, name)
            with db.engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))
                if unique:
                    conn.execute(text(f"CREATE UNIQUE INDEX IF NOT EXISTS ix_{table}_{name} ON {table} ({name})"))


def _outdated(db: Database) -> bool:
    tables = set(inspect(db.engine).get_table_names())
    if not tables:
        return False
    if "meta" not in tables:
        return True
    with db.session() as s:
        version = s.scalar(select(Meta.value).where(Meta.key == "schema_version"))
    return version != SCHEMA_VERSION


def sync_reference(s: Session, plant: Plant) -> None:
    for pos, a in enumerate(plant.areas):
        s.merge(
            AreaRow(
                code=a.code,
                name=a.name,
                kind=str(a.kind),
                line=a.line,
                position=pos,
                cycle_s=a.cycle_s,
                buffer_after=a.buffer_after,
            )
        )
    s.flush()
    for e in plant.equipment:
        s.merge(
            EquipmentRow(
                code=e.code, name=e.name, kind=e.kind, area=e.area, critical=e.critical, mtbf_h=e.mtbf_h, in_model=True
            )
        )
    s.merge(
        EquipmentRow(
            code=SUPPLY_CODE,
            name="Поставка комплектов",
            kind="поставка",
            area=plant.areas[0].code,
            critical=True,
            in_model=True,
        )
    )
    for m in plant.models:
        s.merge(CarModelRow(code=m.code, name=m.name, month_plan=m.month_plan))
    for sh in plant.shifts:
        s.merge(ShiftRow(number=sh.number, starts=f"{sh.start:%H:%M}", ends=f"{sh.end:%H:%M}", hours=sh.hours))


def ensure_equipment(s: Session, code: str, area: str) -> None:
    if s.get(EquipmentRow, code) is None:
        s.add(EquipmentRow(code=code, name=code, kind="из данных", area=area, critical=False, in_model=False))
        s.flush()


def ensure_model(s: Session, name: str) -> None:
    if s.scalar(select(CarModelRow.code).where(CarModelRow.name == name)) is None:
        base = re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")[:16] or "MODEL"
        code, n = base, 1
        while s.get(CarModelRow, code) is not None:
            n += 1
            code = f"{base[:13]}_{n}"
        s.add(CarModelRow(code=code, name=name))
        s.flush()


def create_views(db: Database) -> None:
    drop_views(db)
    with db.engine.begin() as conn:
        for name, sql in VIEWS.items():
            conn.execute(text(f"CREATE VIEW {name} AS {sql}"))


def drop_views(db: Database) -> None:
    with db.engine.begin() as conn:
        for name in VIEWS:
            conn.execute(text(f"DROP VIEW IF EXISTS {name}"))


__all__ = ["SCHEMA_VERSION", "Base", "create_views", "ensure_equipment", "ensure_model", "prepare_database"]
