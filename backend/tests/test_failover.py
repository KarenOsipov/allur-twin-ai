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


def test_hold_local_for_decision_preserves_pending_data(tmp_path):
    primary, local = _db(tmp_path, "primary.db"), _db(tmp_path, "local.db")
    db = FailoverDatabase(local, primary)
    assert db.connect() == "primary"
    _add_user(local, "offline-user")
    db.hold_local_for_decision()
    assert not db.is_primary
    assert db.status()["needs_decision"]
    assert _users(local) == 1 and _users(primary) == 0

    db.use_primary(transfer=True)
    assert db.is_primary and _users(primary) == 1


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
            from app.container import _local_changes_pending

            assert _local_changes_pending(c.app.state.container.db.local)
            assert "u:p@" not in str(st), "строка подключения не уходит наружу"
            with c.app.state.container.db.session() as s:
                assert (s.scalar(select(func.count(ChatMessage.id))) or 0) > 0
    finally:
        del os.environ["SUPABASE_DB_URL"]
        get_settings.cache_clear()


def test_supabase_access_token_cannot_be_used_as_app_token():
    import base64
    import json
    import time

    from app.core.security import verify_token

    header = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').rstrip(b"=").decode()
    payload_data = {
        "sub": "user-uuid-123",
        "email": "director@allur.local",
        "exp": int(time.time()) + 3600,
        "user_metadata": {
            "name": "Айгерим Касымова",
            "role": "director",
            "position": "Директор по производству",
            "user_id": 2,
        },
    }
    payload = base64.urlsafe_b64encode(json.dumps(payload_data).encode()).rstrip(b"=").decode()
    token = f"{header}.{payload}.dummy_signature"

    assert verify_token(token, "local-secret") is None


def test_supabase_access_token_is_verified_by_auth_api(monkeypatch):
    from app.services.supabase_sync import SupabaseSyncService

    service = SupabaseSyncService(
        Settings(supabase_url="https://project.supabase.co", supabase_anon_key="public-key")
    )

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "email": "director@allur.local",
                "app_metadata": {"user_id": 2, "role": "director", "area": None},
            }

    def fake_get(url, *, headers, timeout):
        assert url == "https://project.supabase.co/auth/v1/user"
        assert headers == {"apikey": "public-key", "Authorization": "Bearer verified-token"}
        assert timeout == 8.0
        return Response()

    monkeypatch.setattr("app.services.supabase_sync.httpx.get", fake_get)
    assert service.verify_access_token("verified-token") == {
        "email": "director@allur.local",
        "app_metadata": {"user_id": 2, "role": "director", "area": None},
    }


def test_supabase_session_uses_local_user_role(client, monkeypatch):
    container = client.app.state.container
    monkeypatch.setattr(
        container.supabase,
        "verify_access_token",
        lambda _: {
            "email": "director@allur.local",
            "app_metadata": {"user_id": 2, "role": "director", "area": None},
        },
    )

    response = client.post("/api/v1/auth/supabase-session", json={"access_token": "verified-by-auth"})
    assert response.status_code == 200
    result = response.json()
    assert result["role"] == "director"
    assert result["id"] == 2
    assert result["token"].count(".") == 1
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {result['token']}"})
    assert me.status_code == 200
    assert me.json()["role"] == "director"


def test_supabase_session_rejects_inactive_local_user(client, monkeypatch):
    container = client.app.state.container
    monkeypatch.setattr(
        container.supabase,
        "verify_access_token",
        lambda _: {
            "email": "director@allur.local",
            "app_metadata": {"user_id": 2, "role": "director", "area": None},
        },
    )
    from app.db.models import User

    with container.db.session() as s:
        user = s.get(User, 2)
        user.active = False

    response = client.post("/api/v1/auth/supabase-session", json={"access_token": "verified-by-auth"})
    assert response.status_code == 403


def test_supabase_session_rejects_untrusted_app_metadata(client, monkeypatch):
    container = client.app.state.container
    monkeypatch.setattr(
        container.supabase,
        "verify_access_token",
        lambda _: {
            "email": "director@allur.local",
            "app_metadata": {"user_id": 2, "role": "admin", "area": None},
        },
    )

    response = client.post("/api/v1/auth/supabase-session", json={"access_token": "verified-by-auth"})
    assert response.status_code == 403


def test_demo_auth_sync_is_disabled_outside_demo_mode(client, monkeypatch):
    container = client.app.state.container
    from tests.conftest import login

    headers = login(client)
    monkeypatch.setattr(container.settings, "demo_mode", False)
    response = client.post(
        "/api/v1/system/supabase/seed-users",
        headers=headers,
    )
    assert response.status_code == 422


def test_local_login_syncs_supabase_auth_account(client, monkeypatch):
    container = client.app.state.container
    calls = []
    monkeypatch.setattr(type(container.supabase), "is_configured", property(lambda _: True))
    monkeypatch.setattr(
        container.supabase,
        "sync_local_login",
        lambda user, password: calls.append((user["login"], password)) or True,
    )

    response = client.post("/api/v1/auth/login", json={"pin": "0000"})
    assert response.status_code == 200
    assert response.json()["supabase_auth_synced"] is True
    assert calls == [("admin", "0000")]


def test_supabase_config_endpoint(client):
    res = client.get("/api/v1/system/config")
    assert res.status_code == 200
    data = res.json()
    assert "supabase" in data
    assert "mode" in data["supabase"]
