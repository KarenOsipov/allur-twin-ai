from __future__ import annotations

from datetime import date, datetime

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.db.base import Database
from app.db.models import AreaRow, CarModelRow, DowntimeRecord, EquipmentRow, Meta, QualityRecord
from app.db.schema import SCHEMA_VERSION, VIEWS, ensure_model, prepare_database
from app.domain.plant import ALLUR
from app.services.data_service import DataService


@pytest.fixture()
def db(tmp_path) -> Database:
    d = Database(f"sqlite:///{tmp_path / 'db.sqlite'}")
    prepare_database(d, ALLUR)
    return d


def test_reference_tables_follow_plant_model(db):
    with db.session() as s:
        areas = list(s.scalars(select(AreaRow.code).order_by(AreaRow.position)))
        assert areas == [a.code for a in ALLUR.areas]
        codes = set(s.scalars(select(EquipmentRow.code)))
        assert {e.code for e in ALLUR.equipment} <= codes
        assert "Поставка" in codes
        assert s.get(Meta, "schema_version").value == SCHEMA_VERSION
        assert {m.name for m in s.scalars(select(CarModelRow))} == {m.name for m in ALLUR.models}


def test_foreign_keys_reject_unknown_area(db):
    with pytest.raises(IntegrityError), db.session() as s:
        s.add(QualityRecord(day=date(2026, 10, 1), shift=1, area="NOPE", produced=10, defects=1, source="import"))


def test_check_constraint_rejects_more_defects_than_output(db):
    with pytest.raises(IntegrityError), db.session() as s:
        s.add(QualityRecord(day=date(2026, 10, 1), shift=1, area="PAINT", produced=10, defects=11, source="import"))


def test_unknown_equipment_and_model_are_registered_not_lost(db):
    svc = DataService(db, ALLUR, 300)
    started = datetime(2026, 10, 1, 9, 30)
    payload = {"area": "WELD", "equipment": "Кран-07", "reason": "Обрыв троса", "minutes": 12.04, "started_at": started}
    svc.record_downtime(date(2026, 10, 1), 1, payload)
    svc.record_downtime(date(2026, 10, 1), 1, payload)
    with db.session() as s:
        rows = list(s.scalars(select(DowntimeRecord).where(DowntimeRecord.equipment == "Кран-07")))
        assert len(rows) == 1 and rows[0].minutes == 12.0
        eq = s.get(EquipmentRow, "Кран-07")
        assert eq is not None and eq.in_model is False and eq.area == "WELD"
        ensure_model(s, "Haval Jolion")
        assert s.scalar(select(CarModelRow.code).where(CarModelRow.name == "Haval Jolion")) == "HAVAL_JOLION"


def test_views_return_readable_rows(seeded):
    db = seeded.db
    with db.engine.connect() as conn:
        for name in VIEWS:
            assert conn.execute(text(f"SELECT COUNT(*) FROM {name}")).scalar() > 0, name
        sql = (
            "SELECT area, defect_pct FROM v_quality "
            "WHERE day = '2026-10-02' AND area = 'Окраска' AND source = 'customer'"
        )
        q = conn.execute(text(sql)).one()
        assert float(q.defect_pct) == pytest.approx(5.2, abs=0.05)
        plan = dict(conn.execute(text("SELECT model, plan FROM v_model_plan WHERE month = '2026-10'")).all())
        assert sum(plan.values()) == 4800


def test_outdated_schema_is_rebuilt(tmp_path):
    d = Database(f"sqlite:///{tmp_path / 'old.sqlite'}")
    with d.engine.begin() as conn:
        conn.execute(text("CREATE TABLE production (id INTEGER PRIMARY KEY, area VARCHAR(16))"))
        conn.execute(text("INSERT INTO production (area) VALUES ('WELD')"))
    prepare_database(d, ALLUR)
    with d.session() as s:
        assert s.get(Meta, "schema_version").value == SCHEMA_VERSION
        assert s.get(AreaRow, "WELD") is not None
