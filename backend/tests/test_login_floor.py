import copy

from tests.conftest import login

LOGIN = "/api/v1/auth/login"


def test_login_by_login_and_password(client):
    res = client.post(LOGIN, json={"login": "Admin", "pin": "0000"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["role"] == "admin" and body["login"] == "admin" and body["token"]
    bad = client.post(LOGIN, json={"login": "admin", "pin": "1234"})
    assert bad.status_code == 401
    assert "Осталось попыток" in bad.json()["error"]["message"]
    assert client.post(LOGIN, json={"login": "nobody", "pin": "0000"}).status_code == 401


def test_login_by_pin_only(client):
    res = client.post(LOGIN, json={"pin": "3333"})
    assert res.status_code == 200
    assert res.json()["role"] == "worker"
    assert client.post(LOGIN, json={"pin": "9090"}).status_code == 401
    assert client.post(LOGIN, json={"pin": "abc"}).status_code == 422


def test_demo_hints_have_logins(client):
    users = client.get("/api/v1/auth/users").json()["users"]
    assert all(u["login"] for u in users)
    assert {u["login"] for u in users} >= {"admin", "director", "smena1", "okraska"}


def test_admin_sets_password_and_login(client):
    h = login(client)
    res = client.post(
        "/api/v1/users",
        headers=h,
        json={
            "name": "Ольга Петрова",
            "position": "Оператор сварки",
            "role": "worker",
            "area": "WELD",
            "pin": "Svarka-2026",
        },
    )
    assert res.status_code == 200, res.text
    u = res.json()
    assert u["login"]
    ok = client.post(LOGIN, json={"login": u["login"], "pin": "Svarka-2026"})
    assert ok.status_code == 200
    assert client.patch(f"/api/v1/users/{u['id']}", headers=h, json={"pin": "abc12"}).status_code == 422
    assert client.patch(f"/api/v1/users/{u['id']}", headers=h, json={"login": "admin"}).status_code == 422
    assert client.patch(f"/api/v1/users/{u['id']}", headers=h, json={"login": "olga.p"}).status_code == 200
    assert client.post(LOGIN, json={"login": "olga.p", "pin": "Svarka-2026"}).status_code == 200
    dup = client.post(
        "/api/v1/users",
        headers=h,
        json={"name": "Дубль", "position": "Тест", "role": "director", "pin": "Svarka-2026"},
    )
    assert dup.status_code == 422


def test_floor_scheme_follows_builder(client):
    h = login(client)
    floor = client.get("/api/v1/layouts/floor", headers=h).json()
    layouts = client.get("/api/v1/layouts", headers=h).json()
    assert floor["id"] is not None, "при первом запуске схемой цеха становится проект «Аллюр»"
    assert [x["id"] for x in layouts if x["floor"]] == [floor["id"]]

    base_nodes = len(floor["data"]["nodes"])
    data = copy.deepcopy(floor["data"])
    data["nodes"].append(
        {
            "id": "qc2",
            "type": "inspection",
            "position": {"x": 0, "y": 600},
            "data": {"kind": "inspection", "name": "Контроль 2", "cycle": 120, "defect": 1},
        }
    )
    draft = client.post("/api/v1/layouts", headers=h, json={"name": "Макет с контролем", "data": data})
    assert draft.status_code == 200, draft.text
    did = draft.json()["id"]
    assert client.get("/api/v1/layouts/floor", headers=h).json()["id"] == floor["id"]

    res = client.put("/api/v1/layouts/floor", headers=h, json={"id": did})
    assert res.status_code == 200, res.text
    now = client.get("/api/v1/layouts/floor", headers=h).json()
    assert now["id"] == did and len(now["data"]["nodes"]) == base_nodes + 1
    assert "qc2" not in now["map"]

    wk = login(client, "worker")
    assert client.put(f"/api/v1/layouts/{did}", headers=wk, json={"name": "x", "data": data}).status_code == 403
    assert client.delete(f"/api/v1/layouts/{did}", headers=wk).status_code == 403
    assert client.put("/api/v1/layouts/floor", headers=wk, json={"id": floor["id"]}).status_code == 403
    assert client.post("/api/v1/layouts", headers=wk, json={"name": "x", "data": data}).status_code == 403

    sup = login(client, "supervisor")
    assert client.put("/api/v1/layouts/floor", headers=sup, json={"id": did}).status_code == 200

    data["nodes"] = [n for n in data["nodes"] if n["id"] != "qc2"]
    upd = client.put(f"/api/v1/layouts/{did}", headers=h, json={"name": "Макет с контролем", "data": data})
    assert upd.status_code == 200 and upd.json()["floor"] is True
    assert len(client.get("/api/v1/layouts/floor", headers=h).json()["data"]["nodes"]) == len(data["nodes"])
