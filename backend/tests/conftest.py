from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest

from app.db.base import Database
from app.db.schema import prepare_database
from app.domain.plant import ALLUR
from app.services.data_service import DataService


@pytest.fixture(scope="session")
def seeded(tmp_path_factory) -> DataService:
    path = tmp_path_factory.mktemp("db") / "t.db"
    db = Database(f"sqlite:///{path}")
    prepare_database(db, ALLUR)
    svc = DataService(db, ALLUR, 300)
    svc._write_history(date(2026, 10, 5), 97, seed=7)
    from app.services.data_service import CUSTOMER_FILE

    svc.import_file(CUSTOMER_FILE.name, CUSTOMER_FILE.read_bytes(), role="system", source="customer")
    return svc


@pytest.fixture()
def client(tmp_path: Path) -> Iterator:
    os.environ["DATA_DIR"] = str(tmp_path)
    os.environ["SIM_SPEED"] = "1"
    os.environ["HISTORY_DAYS"] = "60"
    os.environ["ADVICE_AUTOSTART"] = "false"
    os.environ["OPENROUTER_API_KEY"] = ""
    from app.core.config import get_settings

    get_settings.cache_clear()
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app()) as c:
        yield c
    get_settings.cache_clear()


DEMO = {"admin": "0000", "director": "1111", "supervisor": "2222", "worker": "3333"}


def user_id(client, role: str) -> int:
    users = client.get("/api/v1/auth/users").json()["users"]
    return next(u["id"] for u in users if u["role"] == role)


def login(client, role: str = "admin", pin: str | None = None) -> dict:
    res = client.post("/api/v1/auth/login", json={"user_id": user_id(client, role), "pin": pin or DEMO[role]})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}
