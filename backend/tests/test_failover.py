import os

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import OperationalError

from app.core.config import Settings
from app.db import failover
from app.db.base import Database
from app.db.failover import FailoverDatabase, replicate
from app.db.models import ChatMessage, User
from app.db.schema import prepare_database
from app.domain.plant import ALLUR


def _db(tmp_path, name: str) -> Database:
    d = Database(f"sqlite:///{tmp_path / name}")
    prepare_database(d, ALLUR)
    return d


def _users(d) -> int:
    with d.session() as s:
        return s.scalar(select(func.count(User.id))) or 0


def _add_user(d, login: str) -> None:
    from datetime import datetime

    with d.session() as s:
        s.add(
            User(
                name=login,
                position="x",
                role="worker",
                area="PAINT",
                login=login,
                pin_hash="h",
                active=True,
                created_at=datetime.now(),
            )
        )


def test_supabase_url_is_normalized():
    s = Settings(supabase_db_url="postgresql://postgres.abc:pw@aws-0-eu.pooler.supabase.com:6543/postgres")
    assert s.primary_db_url.startswith("postgresql+psycopg://") and s.primary_db_url.endswith("?sslmode=require")
    s = Settings(supabase_db_url="postgres://u:p@db.x.supabase.co:5432/postgres?sslmode=verify-full")
    assert s.primary_db_url.count("sslmode") == 1
    assert Settings(supabase_db_url="").primary_db_url is None
    assert Settings().primary_db_url is None


def test_replicate_copies_everything(tmp_path):
    a, b = _db(tmp_path, "a.db"), _db(tmp_path, "b.db")
    _add_user(a, "ivan")
    _add_user(a, "olga")
    _add_user(b, "stale")
    counts = replicate(a, b)
    assert counts["users"] == 2 and _users(b) == 2
    with b.session() as s:
        assert {u.login for u in s.scalars(select(User))} == {"ivan", "olga"}


def test_startup_without_primary_uses_local(tmp_path):
    local = _db(tmp_path, "local.db")
    dead = Database("postgresql+psycopg://u:p@127.0.0.1:1/x", remote=True)
    db = FailoverDatabase(local, dead)
    assert db.connect() == "local"
    st = db.status()
    assert st["mode"] == "local" and st["needs_decision"] and not db.is_primary
    _add_user(db, "worker1")
    assert _users(local) == 1
    with pytest.raises(RuntimeError):
        db.use_primary(transfer=True)


def test_runtime_outage_and_return(tmp_path, monkeypatch):
    primary, local = _db(tmp_path, "supabase.db"), _db(tmp_path, "local.db")
    db = FailoverDatabase(local, primary)
    db.prepare = lambda d: prepare_database(d, ALLUR)
    switched = []
    db.on_switch.append(lambda s: switched.append(s["mode"]))
    assert db.connect() == "primary"
    _add_user(db, "before")
    db.mirror_now()
    assert _users(local) == 1

    monkeypatch.setattr(failover, "ping", lambda d: False)
    with pytest.raises(OperationalError), db.session() as s:
        s.execute(text("select * from no_such_table"))
    assert not db.is_primary and db.state["outage"] and switched == ["local"]
    _add_user(db, "during")
    assert _users(primary) == 1 and _users(local) == 2

    monkeypatch.setattr(failover, "ping", lambda d: True)
    db.use_primary(transfer=True)
    assert db.is_primary and switched == ["local", "primary"]
    assert _users(primary) == 2
    _add_user(db, "after")
    assert _users(primary) == 3


def test_query_error_with_live_primary_does_not_switch(tmp_path, monkeypatch):
    primary, local = _db(tmp_path, "p.db"), _db(tmp_path, "l.db")
    db = FailoverDatabase(local, primary)
    db.connect()
    with pytest.raises(OperationalError), db.session() as s:
        s.execute(text("select * from no_such_table"))
    assert db.is_primary, "ошибка в запросе при живой базе — не повод уходить на локальную"


def test_app_starts_on_local_when_supabase_down(tmp_path, monkeypatch):
    os.environ["DATA_DIR"] = str(tmp_path)
    os.environ["SIM_SPEED"] = "1"
    os.environ["HISTORY_DAYS"] = "30"
    os.environ["ADVICE_AUTOSTART"] = "false"
    os.environ["OPENROUTER_API_KEY"] = ""
    os.environ["SUPABASE_DB_URL"] = "postgresql://u:p@127.0.0.1:1/postgres"
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as c:
            h = c.get("/api/v1/health").json()
            assert h["status"] == "ok" and h["database"] == "local" and h["database_fallback"] is True
            tok = c.post("/api/v1/auth/login", json={"login": "admin", "pin": "0000"}).json()["token"]
            st = c.get("/api/v1/system/db", headers={"Authorization": f"Bearer {tok}"}).json()
            assert st["mode"] == "local" and st["needs_decision"] and st["counts"]["users"] >= 9
            assert "u:p@" not in str(st), "строка подключения не уходит наружу"
            with c.app.state.container.db.session() as s:
                assert (s.scalar(select(func.count(ChatMessage.id))) or 0) > 0
    finally:
        del os.environ["SUPABASE_DB_URL"]
        get_settings.cache_clear()
