import asyncio
import json
import threading

from app.core.events import EventBus
from tests.conftest import login


def test_chat_channels_and_access(client):
    boss = login(client, "supervisor")
    worker = login(client, "worker")
    chans = {c["id"] for c in client.get("/api/v1/chat", headers=boss).json()}
    assert {"all", "staff", "PAINT", "WELD"} <= chans
    mine = {c["id"] for c in client.get("/api/v1/chat", headers=worker).json()}
    assert mine == {"all", "PAINT"}, "рабочий видит общий канал и свой участок"
    assert client.get("/api/v1/chat/WELD", headers=worker).status_code == 403
    assert client.post("/api/v1/chat/staff", headers=worker, json={"text": "привет"}).status_code == 403
    assert client.get("/api/v1/chat/nope", headers=boss).status_code == 404


def test_chat_post_read_unread(client):
    boss = login(client, "supervisor")
    worker = login(client, "worker")
    sent = client.post("/api/v1/chat/PAINT", headers=worker, json={"text": "  Камера-02 шумит  "})
    assert sent.status_code == 200, sent.text
    msg = sent.json()
    assert msg["text"] == "Камера-02 шумит" and msg["author"] == "Данияр Оспанов"
    hist = client.get("/api/v1/chat/PAINT", headers=boss).json()
    assert hist[-1]["id"] == msg["id"]
    paint = next(c for c in client.get("/api/v1/chat", headers=boss).json() if c["id"] == "PAINT")
    assert paint["unread"] >= 1 and paint["last"]["id"] == msg["id"]
    assert client.post("/api/v1/chat/PAINT/read", headers=boss, json={"last_id": msg["id"]}).json()["ok"]
    paint = next(c for c in client.get("/api/v1/chat", headers=boss).json() if c["id"] == "PAINT")
    assert paint["unread"] == 0
    mine = next(c for c in client.get("/api/v1/chat", headers=worker).json() if c["id"] == "PAINT")
    assert mine["unread"] == 0
    assert client.post("/api/v1/chat/PAINT", headers=worker, json={"text": "   "}).status_code == 422


def test_problem_report_goes_to_chat(client):
    worker = login(client, "worker")
    boss = login(client, "supervisor")
    res = client.post(
        "/api/v1/problems",
        headers=worker,
        json={"kind": "quality", "area": "PAINT", "text": "Подтёки на капоте", "line_stopped": False, "minutes": 10},
    )
    assert res.status_code == 200, res.text
    inc = res.json()["incident"]
    for ch in ("PAINT", "staff"):
        last = client.get(f"/api/v1/chat/{ch}", headers=boss).json()[-1]
        assert last["kind"] == "alert" and last["ref"] == {"incident": inc["id"]}
        assert "Подтёки на капоте" in last["text"]
    client.post(f"/api/v1/incidents/{inc['id']}/ack", headers=boss)
    client.post(f"/api/v1/incidents/{inc['id']}/resolve", headers=boss, json={"resolution": "Перенастроили пистолет"})
    texts = [m["text"] for m in client.get("/api/v1/chat/PAINT", headers=worker).json()]
    assert any("принял в работу" in t for t in texts)
    assert any("Перенастроили пистолет" in t for t in texts)


def test_event_bus_delivers_from_worker_threads():
    async def run() -> list[str]:
        bus = EventBus()
        everyone = bus.subscribe()
        welders = bus.subscribe(lambda ev, d: ev != "chat.message" or d["channel"] == "WELD")
        t = threading.Thread(target=lambda: bus.publish("chat.message", {"channel": "PAINT", "text": "x"}))
        t.start()
        t.join()
        got = await asyncio.wait_for(everyone.get(), timeout=1)
        assert welders.empty()
        return [got]

    got = asyncio.run(run())
    assert json.loads(got[0])["data"]["channel"] == "PAINT"


def test_shift_setup_and_accept(client):
    boss = login(client, "supervisor")
    director = login(client, "director")
    setup = client.get("/api/v1/shift/setup", headers=director).json()
    assert [s["number"] for s in setup["schedule"]] == [1, 2]
    assert setup["checklist"] and setup["supervisors"]
    one = setup["shifts"]["1"]
    assert sum(one["staff"].values()) == 58

    body = {
        "shifts": {
            k: {"plan": 110, "supervisor": "Ерлан Жумабеков", "staff": {**v["staff"], "PAINT": 16}}
            for k, v in setup["shifts"].items()
        },
        "checklist": ["Оборудование осмотрено", "  ", "Люди расставлены"],
    }
    assert client.put("/api/v1/shift/setup", headers=director, json=body).status_code == 403
    saved = client.put("/api/v1/shift/setup", headers=boss, json=body)
    assert saved.status_code == 200, saved.text
    saved = saved.json()
    assert saved["checklist"] == ["Оборудование осмотрено", "Люди расставлены"]
    assert saved["shifts"]["2"]["plan"] == 110 and saved["shifts"]["2"]["staff"]["PAINT"] == 16
    bad = {"shifts": {"9": body["shifts"]["1"]}, "checklist": []}
    assert client.put("/api/v1/shift/setup", headers=boss, json=bad).status_code == 422

    cur = client.get("/api/v1/shift", headers=boss).json()
    if not cur["working"]:
        return
    assert cur["plan"] == 110
    res = client.post(
        "/api/v1/shift/start",
        headers=boss,
        json={
            "plan": 105,
            "staff_by_area": {"WELD": 10, "PAINT": 15, "ASSY": 20},
            "checklist": ["Оборудование осмотрено"],
            "note": "Камера-02 после ремонта",
        },
    )
    if res.status_code == 422 and "уже принял" in res.text:
        return
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["plan"] == 105 and out["staff"] == 45
    assert out["summary"]["start"]["missing"] == ["Люди расставлены"]
    last = client.get("/api/v1/chat/all", headers=boss).json()[-1]
    assert "План — 105" in last["text"] and "люди расставлены" in last["text"]
    closed = client.post("/api/v1/shift/close", headers=boss, json={"note": "Всё штатно"}).json()
    assert closed["summary"]["plan"] == 105 and closed["summary"]["start"]["staff_by_area"]["PAINT"] == 15


def test_direct_messages_reply_edit_delete(client):
    boss = login(client, "supervisor")
    worker = login(client, "worker")
    director = login(client, "director")
    me_w = client.get("/api/v1/auth/me", headers=worker).json()["id"]
    people = client.get("/api/v1/chat/people", headers=boss).json()
    assert any(p["id"] == me_w for p in people)
    ch = client.get(f"/api/v1/chat/dm/{me_w}", headers=boss).json()["channel"]
    assert ch.startswith("dm:")
    first = client.post(f"/api/v1/chat/{ch}", headers=boss, json={"text": "Данияр, зайди к камере 2"}).json()
    assert client.get(f"/api/v1/chat/{ch}", headers=director).status_code == 403
    assert client.post(f"/api/v1/chat/{ch}", headers=director, json={"text": "x"}).status_code == 403
    dm = next(c for c in client.get("/api/v1/chat", headers=worker).json() if c["id"] == ch)
    assert dm["kind"] == "dm" and dm["unread"] == 1 and dm["peer"]["name"]
    ans = client.post(f"/api/v1/chat/{ch}", headers=worker, json={"text": "Иду", "reply_to": first["id"]}).json()
    assert ans["reply_to"]["id"] == first["id"] and "камере" in ans["reply_to"]["text"]
    client.post(f"/api/v1/chat/{ch}/read", headers=worker, json={"last_id": ans["id"]})
    mine = next(c for c in client.get("/api/v1/chat", headers=boss).json() if c["id"] == ch)
    assert mine["peer_read_id"] >= first["id"]
    assert client.patch(f"/api/v1/chat/messages/{first['id']}", headers=worker, json={"text": "x"}).status_code == 403
    ed = client.patch(
        f"/api/v1/chat/messages/{first['id']}", headers=boss, json={"text": "Данияр, зайди к Камере-02"}
    ).json()
    assert ed["edited_at"] and ed["text"].endswith("Камере-02")
    assert client.delete(f"/api/v1/chat/messages/{ans['id']}", headers=boss).status_code == 403
    gone = client.delete(f"/api/v1/chat/messages/{ans['id']}", headers=worker).json()
    assert gone["deleted"] and gone["text"] == ""
    assert client.get(f"/api/v1/chat/dm/{me_w}", headers=worker).status_code == 422


def test_chat_photo(client):
    import io
    import struct
    import zlib

    def png() -> bytes:
        raw = b"\x00\xff\x00\x00"
        chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b"")
        )

    worker = login(client, "worker")
    boss = login(client, "supervisor")
    tok = client.post("/api/v1/auth/login", json={"login": "svarka", "pin": "4444"}).json()["token"]
    welder = {"Authorization": f"Bearer {tok}"}
    res = client.post(
        "/api/v1/chat/PAINT/photo",
        headers=worker,
        files={"file": ("p.png", io.BytesIO(png()), "image/png")},
        data={"text": "Подтёк на капоте", "width": "1", "height": "1"},
    )
    assert res.status_code == 200, res.text
    msg = res.json()
    pid = msg["ref"]["photo"]["id"]
    got = client.get(f"/api/v1/chat/files/{pid}", headers=boss)
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    assert client.get(f"/api/v1/chat/files/{pid}", headers=welder).status_code == 404
    bad = client.post(
        "/api/v1/chat/PAINT/photo",
        headers=worker,
        files={"file": ("x.png", io.BytesIO(b"<script>alert(1)</script>"), "image/png")},
    )
    assert bad.status_code == 422
    client.delete(f"/api/v1/chat/messages/{msg['id']}", headers=worker)
    assert client.get(f"/api/v1/chat/files/{pid}", headers=boss).status_code == 404


def test_full_analysis_pdf(client):
    h = login(client, "director")
    res = client.get("/api/v1/documents/full.pdf?days=30", headers=h)
    assert res.status_code == 200, res.text
    assert res.content[:4] == b"%PDF" and len(res.content) > 50_000
    assert "obshchii_analiz" in res.headers["content-disposition"]


def test_ws_typing_and_presence(client):
    boss = login(client, "supervisor")
    worker = login(client, "worker")
    btok = boss["Authorization"].split()[1]
    wtok = worker["Authorization"].split()[1]
    wid = client.get("/api/v1/auth/me", headers=worker).json()["id"]

    def until(ws, event, n=40, who=None):
        for _ in range(n):
            m = json.loads(ws.receive_text())
            if m["event"] == event and (who is None or m["data"].get("user_id") == who):
                return m["data"]
        raise AssertionError(f"нет события {event}")

    with client.websocket_connect("/api/v1/ws") as b:
        b.send_text(json.dumps({"token": btok}))
        until(b, "hello")
        with client.websocket_connect("/api/v1/ws") as w:
            w.send_text(json.dumps({"token": wtok}))
            until(w, "hello")
            assert until(b, "presence", who=wid) == {"user_id": wid, "online": True}
            assert any(p["id"] == wid and p["online"] for p in client.get("/api/v1/chat/people", headers=boss).json())
            w.send_text(json.dumps({"type": "typing", "channel": "PAINT"}))
            t = until(b, "chat.typing")
            assert t["channel"] == "PAINT" and t["user_id"] == wid
        assert until(b, "presence", who=wid) == {"user_id": wid, "online": False}
