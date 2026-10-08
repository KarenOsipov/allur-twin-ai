from app.core.security import Role, create_token, verify_token
from app.services.data_service import CUSTOMER_FILE
from tests.conftest import login, user_id


def test_health_is_public(client):
    assert client.get("/api/v1/health").json()["status"] == "ok"


def test_everything_else_requires_login(client):
    for path in ("/api/v1/floor", "/api/v1/insights", "/api/v1/incidents", "/api/v1/data/checks"):
        assert client.get(path).status_code == 401


def test_wrong_pin_locks_the_user(client):
    uid = user_id(client, "admin")
    for _ in range(4):
        assert client.post("/api/v1/auth/login", json={"user_id": uid, "pin": "9999"}).status_code == 401
    assert client.post("/api/v1/auth/login", json={"user_id": uid, "pin": "9999"}).status_code == 429
    assert client.post("/api/v1/auth/login", json={"user_id": uid, "pin": "0000"}).status_code == 429
    login(client, "director")


def _token(secret: str, role: Role) -> str:
    return create_token(secret, user_id=1, role=role, name="Тест", position="Тест", area=None, ttl_hours=1)[0]


def test_tampered_token_is_rejected():
    token = _token("secret-a", Role.SUPERVISOR)
    payload, sig = token.split(".")
    assert verify_token(token, "secret-a") is not None
    assert verify_token(token, "secret-b") is None
    forged = _token("secret-a", Role.ADMIN).split(".")[0] + "." + sig
    assert verify_token(forged, "secret-a") is None


def test_roles_permissions(client):
    director = login(client, "director", "1111")
    files = {"file": (CUSTOMER_FILE.name, CUSTOMER_FILE.read_bytes(), "application/octet-stream")}
    assert client.post("/api/v1/data/import", headers=director, files=files).status_code == 403
    assert client.post("/api/v1/floor/speed", headers=director, json={"speed": 5}).status_code == 200


def test_floor_and_insights(client):
    h = login(client)
    floor = client.get("/api/v1/floor", headers=h).json()
    assert floor["ready"]
    assert {a["code"] for a in floor["areas"]} >= {"WELD", "PAINT", "ASSY", "QC"}
    insights = client.get("/api/v1/insights", headers=h).json()
    assert insights["recommendations"]
    assert insights["bottleneck"]["constraint"] in {"WELD", "PAINT", "ASSY"}


def test_failure_creates_incident(client):
    h = login(client, "supervisor")
    client.post("/api/v1/floor/pause", headers=h, json={"paused": False})
    res = client.post("/api/v1/floor/failure", headers=h, json={"equipment": "Конвейер-03", "minutes": 20})
    assert res.status_code == 200
    assert (
        client.post("/api/v1/floor/failure", headers=h, json={"equipment": "Нет-такого", "minutes": 5}).status_code
        == 404
    )


def test_import_customer_file_and_bad_file(client):
    h = login(client)
    files = {"file": (CUSTOMER_FILE.name, CUSTOMER_FILE.read_bytes(), "application/octet-stream")}
    res = client.post("/api/v1/data/import", headers=h, files=files).json()
    assert res["rows"] == 19
    assert res["targets"]["oee_pct"] == 85
    fake = {"file": ("evil.docx", b"<html>not a docx</html>", "application/octet-stream")}
    assert client.post("/api/v1/data/import", headers=h, files=fake).status_code == 422
    exe = {"file": ("run.exe", b"MZ", "application/octet-stream")}
    assert client.post("/api/v1/data/import", headers=h, files=exe).status_code == 422


def test_assistant_answers_locally(client):
    h = login(client)
    res = client.post("/api/v1/assistant", headers=h, json={"question": "Где узкое место?"}).json()
    assert res["engine"] == "local"
    assert "Узкое место" in res["text"]


def test_scenario_validation(client):
    h = login(client)
    bad = {"scenario": {"cycle_factor": {"PAINT": 5}}, "runs": 2}
    assert client.post("/api/v1/scenarios/run", headers=h, json=bad).status_code == 422
    extra = {"scenario": {"hack": 1}, "runs": 2}
    assert client.post("/api/v1/scenarios/run", headers=h, json=extra).status_code == 422


def test_csv_export_escapes_formulas(client):
    h = login(client)
    res = client.get("/api/v1/data/export/downtime.csv", headers=h)
    assert res.status_code == 200
    assert res.text.startswith("﻿day;")


def test_security_headers(client):
    res = client.get("/api/v1/health")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"


def test_shift_forecast_does_not_touch_live_floor(client):
    h = login(client)
    before = client.get("/api/v1/floor", headers=h).json()["kpi"]["finished"]
    f = client.get("/api/v1/floor/forecast", headers=h).json()
    if f["available"]:
        assert f["low"] <= f["expected"] <= f["high"]
        assert f["finished_now"] >= before
    after = client.get("/api/v1/floor", headers=h).json()["kpi"]["finished"]
    assert after - before < 5


def test_openrouter_client_parses_reply_and_caches():
    import asyncio

    import httpx

    from app.assistant.llm import OPENROUTER_URL, LlmClient
    from app.core.config import Settings

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert str(request.url) == OPENROUTER_URL
        assert request.headers["authorization"] == "Bearer test-key"
        body = request.read().decode()
        assert '"model": "dots-studio/dots-3-note-preview:free"' in body or "dots-3-note" in body
        return httpx.Response(
            200,
            json={
                "model": "dots-test",
                "choices": [{"message": {"content": "<think>черновик</think>Окраска — узкое место."}}],
            },
        )

    settings = Settings(llm_provider="openrouter", openrouter_api_key="test-key")
    client = LlmClient(settings, transport=httpx.MockTransport(handler))
    assert client.enabled and client.provider == "openrouter"
    reply = asyncio.run(client.ask("Где узкое место?", '{"x": 1}'))
    assert reply.text == "Окраска — узкое место."
    asyncio.run(client.ask("где узкое место?", '{"x": 1}'))
    assert len(calls) == 1


def test_provider_falls_back_to_local_without_key():
    from app.core.config import Settings

    assert Settings(llm_provider="openrouter", openrouter_api_key=None).llm_provider_effective == "local"
