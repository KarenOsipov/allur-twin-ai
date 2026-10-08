from __future__ import annotations

import json

from app.assistant.llm import clean
from tests.conftest import login, user_id
from tests.test_sandbox import _fork

API = "/api/v1"


def _working(client):
    client.app.state.container.live.sim = _fork(11)


def test_login_screen_lists_staff_with_demo_pins(client):
    users = client.get(f"{API}/auth/users").json()
    roles = {u["role"] for u in users["users"]}
    assert roles == {"admin", "director", "supervisor", "worker"}
    assert all(u["demo_pin"] for u in users["users"])
    assert all("pin_hash" not in u for u in users["users"])


def test_role_permissions_matrix(client):
    worker, sup, director, admin = (login(client, r) for r in ("worker", "supervisor", "director", "admin"))
    for path in ("/kpi/overview", "/insights", "/journal", "/incidents", "/economics/plant", "/shift/setup"):
        assert client.get(API + path, headers=worker).status_code == 200, path
    writes = [
        ("post", "/shift/start", {}),
        ("post", "/shift/close", {}),
        ("put", "/params", {}),
        ("post", "/floor/speed", {"speed": 5}),
        ("post", "/floor/pause", {"paused": True}),
        ("post", "/incidents/1/ack", None),
        ("post", "/incidents/1/resolve", {}),
        ("post", "/incidents/1/comment", {"text": "x"}),
        ("put", "/settings/economics", {}),
        ("post", "/floor/failure", {"equipment": "Камера-02", "minutes": 10}),
        ("post", "/data/reset", None),
        ("get", "/users", None),
        ("post", "/users", {}),
    ]
    for method, path, body in writes:
        res = client.request(method.upper(), API + path, headers=worker, json=body)
        assert res.status_code == 403, (path, res.status_code)
    assert client.get(f"{API}/worker/overview", headers=worker).status_code == 200
    assert client.get(f"{API}/floor", headers=worker).status_code == 200
    assert client.post(f"{API}/shift/start", headers=director, json={}).status_code == 403
    assert client.put(f"{API}/params", headers=sup, json={}).status_code == 403
    assert client.get(f"{API}/users", headers=director).status_code == 403
    assert client.get(f"{API}/users", headers=admin).status_code == 200


def test_admin_manages_staff_and_disabled_user_loses_access(client):
    admin = login(client, "admin")
    new = client.post(
        f"{API}/users",
        headers=admin,
        json={"name": "Ольга Петрова", "position": "Оператор сварки", "role": "worker", "area": "WELD", "pin": "8642"},
    )
    assert new.status_code == 200, new.text
    uid = new.json()["id"]
    dup = client.post(
        f"{API}/users",
        headers=admin,
        json={"name": "Двойник", "position": "Оператор", "role": "worker", "area": "WELD", "pin": "3333"},
    )
    assert dup.status_code == 422
    bad = client.post(
        f"{API}/users",
        headers=admin,
        json={"name": "Без участка", "position": "Оператор", "role": "worker", "pin": "9753"},
    )
    assert bad.status_code == 422
    tok = client.post(f"{API}/auth/login", json={"user_id": uid, "pin": "8642"}).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert client.get(f"{API}/worker/overview", headers=h).json()["area"]["code"] == "WELD"
    assert client.patch(f"{API}/users/{uid}", headers=admin, json={"active": False}).status_code == 200
    assert client.get(f"{API}/worker/overview", headers=h).status_code == 401
    me = user_id(client, "admin")
    assert client.patch(f"{API}/users/{me}", headers=admin, json={"active": False}).status_code == 403


def test_shift_report_and_express_analysis(client):
    _working(client)
    sup, worker = login(client, "supervisor"), login(client, "worker")
    started = client.post(f"{API}/shift/start", headers=sup, json={"staff": 58, "note": "без замечаний"})
    assert started.status_code == 200, started.text
    assert client.post(f"{API}/shift/start", headers=sup, json={}).status_code == 422
    assert client.get(f"{API}/shift", headers=worker).json()["session"]["supervisor"] == "Ерлан Жумабеков"

    r = client.post(
        f"{API}/problems",
        headers=worker,
        json={
            "kind": "equipment",
            "equipment": "Камера-02",
            "text": "Нет давления краски",
            "line_stopped": True,
            "minutes": 30,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    inc = body["incident"]
    assert inc["source"] == "worker" and inc["reported_by"] == "Данияр Оспанов" and inc["severity"] == "critical"
    assert body["supervisor"] == "Ерлан Жумабеков"
    live = client.app.state.container.live
    assert live.is_down("Камера-02")
    live._handle_events()
    same = [
        i
        for i in client.get(f"{API}/incidents?status=active", headers=sup).json()["items"]
        if i["equipment"] == "Камера-02" and i["created_at"] >= inc["created_at"]
    ]
    assert len(same) == 1

    im = client.get(f"{API}/incidents/{inc['id']}/impact", headers=sup).json()
    assert im["available"] and im["line_stops"]
    assert im["lost_cars"] > 0 and im["lost_kzt"] > 0
    assert im["cost_per_min_kzt"] == round(450_000 / 4)
    assert im["options"] and "₸" in im["summary"]
    assert im["plan_without"] >= im["plan_expected"]

    act = client.get(f"{API}/documents/incident/{inc['id']}.pdf", headers=sup)
    assert act.status_code == 200 and act.content[:4] == b"%PDF"

    done = client.post(f"{API}/incidents/{inc['id']}/resolve", headers=sup, json={"resolution": "Заменён фильтр"})
    assert done.json()["status"] == "resolved" and done.json()["resolution"] == "Заменён фильтр"
    assert not live.is_down("Камера-02")
    mine = client.get(f"{API}/problems/mine", headers=worker).json()
    assert mine[0]["status"] == "resolved"

    closed = client.post(f"{API}/shift/close", headers=sup, json={"note": "сдал"}).json()
    assert closed["closed_at"] and closed["summary"]["reports"] >= 1
    j = client.get(f"{API}/journal?category=incident", headers=sup).json()["items"]
    assert any(e["action"] == "reported" and e["actor"] == "Данияр Оспанов" for e in j)
    assert any(e["action"] == "impact" for e in j)


def test_supply_problem_delays_kits_in_the_twin(client):
    _working(client)
    worker = login(client, "worker")
    r = client.post(f"{API}/problems", headers=worker, json={"kind": "supply", "area": "WH_IN", "minutes": 40})
    assert r.status_code == 200, r.text
    live = client.app.state.container.live
    assert live.sim.kits_delayed_until is not None
    live._handle_events()
    sup = login(client, "supervisor")
    supply = [
        i
        for i in client.get(f"{API}/incidents?status=active", headers=sup).json()["items"]
        if i["kind"] == "supply" and i["created_at"] >= r.json()["incident"]["created_at"]
    ]
    assert len(supply) == 1


def test_problem_validation(client):
    worker = login(client, "worker")
    assert client.post(f"{API}/problems", headers=worker, json={"kind": "equipment"}).status_code == 422
    assert (
        client.post(
            f"{API}/problems", headers=worker, json={"kind": "equipment", "equipment": "Нет-такого"}
        ).status_code
        == 422
    )
    assert client.post(f"{API}/problems", headers=worker, json={"kind": "laser"}).status_code == 422


def test_params_change_live_line_and_are_journaled(client):
    _working(client)
    admin = login(client, "admin")
    r = client.put(
        f"{API}/params",
        headers=admin,
        json={
            "areas": {"PAINT": {"cycle_s": 220, "buffer": 12}},
            "equipment": {"Конвейер-03": {"mtbf_h": 400}},
            "supply": {"every_min": 45},
        },
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["changes"]) == 4
    sim = client.app.state.container.live.sim
    assert sim.areas["PAINT"].cycle_s == 220
    assert sim.buffer_cap["PAINT"] == 12
    assert sim.mtbf("Конвейер-03") == 400
    assert sim.cfg.kit_delivery_every_min == 45
    bad = client.put(f"{API}/params", headers=admin, json={"areas": {"PAINT": {"cycle_s": 5}}})
    assert bad.status_code == 422 and "допустимо" in bad.json()["error"]["message"]
    assert client.put(f"{API}/params", headers=admin, json={"areas": {"XXX": {"cycle_s": 200}}}).status_code == 422
    client.put(f"{API}/params", headers=admin, json={"areas": {"PAINT": {"cycle_s": None}}})
    assert sim.areas["PAINT"].cycle_s == 234
    j = client.get(f"{API}/journal?category=data", headers=admin).json()["items"]
    assert any(e["action"] == "params" and "Окраска: время цикла, с" in e["details"] for e in j)
    client.post(f"{API}/params/reset", headers=admin)
    assert sim.buffer_cap["PAINT"] == 8


def test_every_document_is_a_branded_pdf(client):
    _working(client)
    director = login(client, "director")
    for page in ("floor", "kpi", "quality", "forecast", "incidents", "journal", "ai", "roi", "data", "sim"):
        r = client.get(f"{API}/documents/{page}.pdf", headers=director)
        assert r.status_code == 200, (page, r.text[:200])
        assert r.content[:4] == b"%PDF" and len(r.content) > 20_000, page
        assert r.headers["x-document-number"]
    r = client.post(
        f"{API}/documents/builder.pdf",
        headers=director,
        json={
            "name": "Тест",
            "nodes": [{"name": "Сварка", "kind": "Участок", "cycle_s": 200, "equipment": 3}],
            "stats": {"per_hour": 14.2, "bottleneck": "Сварка"},
        },
    )
    assert r.status_code == 200 and r.content[:4] == b"%PDF"
    j = client.get(f"{API}/journal?category=export", headers=director).json()
    assert j["total"] >= 11


def test_plant_economy_adds_up(client):
    director = login(client, "director")
    r = client.get(f"{API}/economics/plant", headers=director).json()
    m, lo, b = r["month"], r["losses"], r["basis"]
    assert (
        m["margin_income_kzt"] == round(m["output"] * b["margin_per_car_kzt"], -0)
        or abs(m["margin_income_kzt"] - m["output"] * b["margin_per_car_kzt"]) <= b["margin_per_car_kzt"]
    )
    assert r["losses_total_kzt"] == lo["shortfall_kzt"] + lo["rework_kzt"]
    assert lo["downtime_kzt"] <= lo["shortfall_kzt"] + b["margin_per_car_kzt"] * 50
    assert lo["rework_excess_kzt"] <= lo["rework_kzt"]
    assert r["minute_kzt"] == round(60 / b["takt_s"] * b["margin_per_car_kzt"])
    assert r["areas"] == sorted(r["areas"], key=lambda x: -x["total_kzt"])
    assert {x["id"] for x in r["potential"]} == {"defects", "downtime", "plan", "overtime"}
    assert all("₸" in x["text"] for x in r["potential"][:3])
    admin = login(client, "admin")
    client.put(f"{API}/settings/economics", headers=admin, json={"margin_per_car_kzt": 900_000})
    r2 = client.get(f"{API}/economics/plant", headers=director).json()
    assert r2["minute_kzt"] == 2 * r["minute_kzt"]
    client.put(f"{API}/settings/economics", headers=admin, json={"economy": {"overhead_kzt_min": 0}})
    r3 = client.get(f"{API}/economics/plant", headers=director).json()
    assert r3["month"]["overhead_kzt"] == 0


def test_prescriptive_advice_is_simulated(client):
    director = login(client, "director")
    r = client.get(f"{API}/advice?wait=true", headers=director).json()
    assert r["status"] == "ready" and r["items"]
    first = r["items"][0]
    assert {"title", "why", "result", "cars_day", "net_kzt_month", "cost_kzt_month", "valuation"} <= set(first)
    assert "₸" in first["result"]
    assert [x["worth_it"] for x in r["items"]] == sorted((x["worth_it"] for x in r["items"]), reverse=True)


def test_import_pasted_table_reviews_suspicious_values(client):
    admin = login(client, "admin")
    text = "Качество за смену\nДата\tУчасток\tВыпущено\tБрак\n06.10.2026\tОкраска\t118\t30\n"
    r = client.post(f"{API}/data/import-text", headers=admin, json={"text": text, "name": "из письма"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["rows"] == 1 and d["tables"][0]["kind"] == "quality"
    assert any("брак" in x["text"].lower() for x in d["review"])
    assert d["changes"]


def test_import_json_and_english_headers(client):
    admin = login(client, "admin")
    data = json.dumps(
        [{"date": "02.10.2026", "area": "Сварка", "machine": "ABB-01", "reason": "Ошибка датчика", "minutes": 25}]
    )
    files = {"file": ("downtime.json", data.encode(), "application/json")}
    r = client.post(f"{API}/data/import", headers=admin, files=files)
    assert r.status_code == 200, r.text
    assert r.json()["tables"][0]["kind"] == "downtime"


def test_bad_inputs_never_crash_the_server(client):
    admin = login(client, "admin")
    for name, payload in (
        ("broken.docx", b"PK\x03\x04garbage"),
        ("x.json", b"{not json"),
        ("t.txt", "просто текст без таблицы".encode()),
        ("old.xls", b"\xd0\xcf\x11\xe0"),
        ("virus.exe", b"MZ"),
    ):
        r = client.post(f"{API}/data/import", headers=admin, files={"file": (name, payload, "x/y")})
        assert r.status_code == 422, (name, r.status_code)
        assert r.json()["error"]["message"]
    assert client.post(f"{API}/data/import-text", headers=admin, json={"text": "a"}).status_code == 422
    assert (
        client.post(
            f"{API}/data/dataset", headers=admin, files={"file": ("d.json", b'{"format": "other"}', "application/json")}
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"{API}/problems", headers=login(client, "worker"), json={"kind": "other", "admin": True}
        ).status_code
        == 422
    )


def test_dataset_roundtrip(client):
    admin = login(client, "admin")
    client.put(f"{API}/params", headers=admin, json={"areas": {"WELD": {"buffer": 9}}})
    exported = client.get(f"{API}/data/dataset.json", headers=admin)
    assert exported.status_code == 200
    data = exported.json()
    assert data["format"] == "allur-dataset" and data["users"] and data["layouts"]
    assert all("pin_hash" in u for u in data["users"])
    client.put(f"{API}/params", headers=admin, json={"areas": {"WELD": {"buffer": None}}})
    r = client.post(
        f"{API}/data/dataset",
        headers=admin,
        files={"file": ("dataset.json", json.dumps(data).encode(), "application/json")},
    )
    assert r.status_code == 200, r.text
    assert client.app.state.container.live.sim.buffer_cap["WELD"] == 9
    director = login(client, "director")
    assert data["chat"] and not any(m["channel"].startswith("dm:") for m in data["chat"])
    chats = client.get(f"{API}/chat/all", headers=director).json()
    assert len(chats) == len([m for m in data["chat"] if m["channel"] == "all"])
    assert all(m["author_id"] for m in chats if m["role"] != "system")


def test_demo_seed_gives_a_lived_in_plant(client):
    director = login(client, "director")
    history = client.get(f"{API}/shift/history", headers=director).json()
    assert len(history) >= 10 and all(h["supervisor"] for h in history)
    incidents = client.get(f"{API}/incidents?source=worker&limit=200", headers=director).json()
    assert incidents["total"] >= 5
    layouts = client.get(f"{API}/layouts", headers=director).json()
    assert len(layouts) >= 4


def test_currency_is_always_tenge():
    assert clean("Потери 2,5 млн рублей, ремонт 300 руб.") == "Потери 2,5 млн ₸, ремонт 300 ₸"
