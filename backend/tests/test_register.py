from tests.conftest import login

REQ = {
    "name": "Ольга Петрова",
    "position": "Оператор сварки",
    "role": "worker",
    "area": "WELD",
    "login": "olga.p",
    "password": "Svarka-2026",
    "note": "Перевели со склада",
}


def test_register_then_approve(client):
    res = client.post("/api/v1/auth/register", json=REQ)
    assert res.status_code == 200, res.text
    early = client.post("/api/v1/auth/login", json={"login": "olga.p", "pin": "Svarka-2026"})
    assert early.status_code == 403 and "ждёт подтверждения" in early.json()["error"]["message"]
    assert client.post("/api/v1/auth/login", json={"login": "olga.p", "pin": "wrong-pass"}).status_code == 401
    assert "Ольга Петрова" not in [u["name"] for u in client.get("/api/v1/auth/users").json()["users"]]

    h = login(client)
    users = client.get("/api/v1/users", headers=h).json()
    req = next(u for u in users if u["login"] == "olga.p")
    assert req["status"] == "pending" and not req["active"] and req["request_note"] == "Перевели со склада"
    assert client.post(f"/api/v1/users/{req['id']}/approve", headers=login(client, "supervisor")).status_code == 403
    ok = client.post(f"/api/v1/users/{req['id']}/approve", headers=h, json={"area": "PAINT"})
    assert ok.status_code == 200 and ok.json()["status"] == "active" and ok.json()["area"] == "PAINT"
    assert client.post(f"/api/v1/users/{req['id']}/approve", headers=h).status_code == 422
    done = client.post("/api/v1/auth/login", json={"login": "olga.p", "pin": "Svarka-2026"})
    assert done.status_code == 200 and done.json()["role"] == "worker"


def test_register_reject_and_rules(client):
    assert client.post("/api/v1/auth/register", json={**REQ, "role": "admin"}).status_code == 422
    assert client.post("/api/v1/auth/register", json={**REQ, "area": None}).status_code == 422
    assert client.post("/api/v1/auth/register", json={**REQ, "login": "admin"}).status_code == 422
    assert client.post("/api/v1/auth/register", json={**REQ, "password": "0000"}).status_code == 422
    res = client.post("/api/v1/auth/register", json={**REQ, "login": "ivan.k", "password": "Ivan-2026"})
    assert res.status_code == 200
    h = login(client)
    uid = next(u["id"] for u in client.get("/api/v1/users", headers=h).json() if u["login"] == "ivan.k")
    assert client.post(f"/api/v1/users/{uid}/reject", headers=h).json()["status"] == "rejected"
    no = client.post("/api/v1/auth/login", json={"login": "ivan.k", "pin": "Ivan-2026"})
    assert no.status_code == 403 and "отклонена" in no.json()["error"]["message"]
    assert all(u["login"] != "ivan.k" for u in client.get("/api/v1/users", headers=h).json())


def test_register_rate_limit(client):
    codes = [
        client.post(
            "/api/v1/auth/register", json={**REQ, "login": f"user{i}x", "password": f"Pass-{i}-2026"}
        ).status_code
        for i in range(7)
    ]
    assert codes[:5] == [200] * 5 and codes[5] == 429
