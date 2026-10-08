from __future__ import annotations

import io
import json
import struct
import zlib

from tests.conftest import login
from tests.test_sandbox import _fork

API = "/api/v1"


def _working(client):
    client.app.state.container.live.sim = _fork(11)


def _png() -> bytes:
    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
        + chunk(b"IEND", b"")
    )


def _login(client, login_name: str, pin: str) -> dict:
    tok = client.post(f"{API}/auth/login", json={"login": login_name, "pin": pin}).json()["token"]
    return {"Authorization": f"Bearer {tok}"}


def test_shift_readiness_flow(client):
    _working(client)
    sup, worker = login(client, "supervisor"), login(client, "worker")
    welder = _login(client, "svarka", "4444")
    before = client.get(f"{API}/shift/ready", headers=worker).json()
    assert before["shift_id"] is None
    assert client.post(f"{API}/shift/ready", headers=worker, json={"status": "ready"}).status_code == 422

    assert client.post(f"{API}/shift/start", headers=sup, json={"staff": 40}).status_code == 200
    r = client.get(f"{API}/shift/ready", headers=sup).json()
    assert r["total"] >= 2 and r["ready"] == 0 and r["pending"] == r["total"]

    ok = client.post(f"{API}/shift/ready", headers=worker, json={"status": "ready"})
    assert ok.status_code == 200, ok.text
    mine = ok.json()
    assert mine["mine"]["status"] == "ready" and mine["ready"] == 1
    assert all(p["user_id"] == mine["mine"]["user_id"] for p in mine["people"])

    assert client.post(f"{API}/shift/ready", headers=welder, json={"status": "absent"}).status_code == 422
    no = client.post(f"{API}/shift/ready", headers=welder, json={"status": "absent", "note": "Заболел"})
    assert no.status_code == 200
    full = client.get(f"{API}/shift/ready", headers=sup).json()
    assert full["ready"] == 1 and full["absent"] == 1 and full["pending"] == full["total"] - 2
    absent = next(p for p in full["people"] if p["status"] == "absent")
    assert absent["name"] == "Асель Нурланова" and absent["note"] == "Заболел"
    staff_chat = client.get(f"{API}/chat/staff", headers=sup).json()
    assert any("Заболел" in m["text"] for m in staff_chat)

    pdf = client.get(f"{API}/documents/floor.pdf", headers=sup)
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"

    closed = client.post(f"{API}/shift/close", headers=sup, json={}).json()
    ready = closed["summary"]["readiness"]
    assert ready["ready"] == 1 and ready["absent"] == 1
    assert ready["absent_people"] == [{"name": "Асель Нурланова", "note": "Заболел"}]


def test_detailed_problem_and_reporter_notifications(client):
    _working(client)
    sup, worker = login(client, "supervisor"), login(client, "worker")
    wid = client.get(f"{API}/auth/me", headers=worker).json()["id"]
    over = client.get(f"{API}/worker/overview", headers=worker).json()
    assert over["reasons"]["quality"] and over["urgency"]["high"]

    photo = client.post(
        f"{API}/problems/photo",
        headers=worker,
        files={"file": ("p.png", io.BytesIO(_png()), "image/png")},
        data={"width": "1", "height": "1"},
    )
    assert photo.status_code == 200, photo.text
    pid = photo.json()["id"]
    bad = client.post(
        f"{API}/problems/photo",
        headers=worker,
        files={"file": ("x.png", io.BytesIO(b"<svg></svg>"), "image/png")},
    )
    assert bad.status_code == 422

    res = client.post(
        f"{API}/problems",
        headers=worker,
        json={
            "kind": "quality",
            "text": "",
            "reasons": ["Подтёки краски", "Царапины"],
            "urgency": "low",
            "line_stopped": False,
            "photo_id": pid,
        },
    )
    assert res.status_code == 200, res.text
    inc = res.json()["incident"]
    assert inc["reporter_id"] == wid and inc["urgency"] == "low" and inc["severity"] == "info"
    assert inc["reasons"] == ["Подтёки краски", "Царапины"] and inc["photo_id"] == pid
    assert inc["details"] == "Подтёки краски; Царапины" and inc["est_minutes"] is None
    assert client.get(f"{API}/chat/files/{pid}", headers=sup).status_code == 200

    stop = client.post(
        f"{API}/problems",
        headers=worker,
        json={"kind": "other", "text": "Нет людей", "line_stopped": True, "minutes": 45, "urgency": "normal"},
    ).json()["incident"]
    assert stop["severity"] == "critical" and stop["est_minutes"] == 45

    paint = next(c for c in client.get(f"{API}/chat", headers=worker).json() if c["id"] == "PAINT")
    assert paint["unread"] == 0, "свои сообщения не считаются непрочитанными"
    staff = next(c for c in client.get(f"{API}/chat", headers=sup).json() if c["id"] == "staff")
    assert staff["unread"] >= 2

    events: list[dict] = []
    bus = client.app.state.container.events
    bus.on("problem.update", events.append)
    acked = client.post(f"{API}/incidents/{inc['id']}/ack", headers=sup).json()
    assert acked["acked_at"] and acked["acked_by"] == "Ерлан Жумабеков"
    c = client.post(f"{API}/incidents/{inc['id']}/comment", headers=sup, json={"text": "Иду к вам"})
    assert c.status_code == 200 and c.json()["comments"][-1]["text"] == "Иду к вам"
    client.post(f"{API}/incidents/{inc['id']}/resolve", headers=sup, json={"resolution": "Перекрасили"})
    assert [e["action"] for e in events] == ["ack", "comment", "resolve"]
    assert all(e["reporter_id"] == wid for e in events)
    paint = next(c for c in client.get(f"{API}/chat", headers=sup).json() if c["id"] == "PAINT")
    sup_paint_unread = paint["unread"]
    assert all(m["actor_id"] != wid for m in client.get(f"{API}/chat/PAINT", headers=sup).json()[-2:])
    assert sup_paint_unread >= 2

    mine = client.get(f"{API}/problems/mine", headers=worker).json()
    got = next(i for i in mine if i["id"] == inc["id"])
    assert got["status"] == "resolved" and got["resolution"] == "Перекрасили" and got["comments"]


def test_ws_problem_update_reaches_only_reporter_and_staff(client):
    sup, worker = login(client, "supervisor"), login(client, "worker")
    welder = _login(client, "svarka", "4444")
    inc = client.post(f"{API}/problems", headers=worker, json={"kind": "other", "text": "Вопрос"}).json()["incident"]

    def until(ws, event, n=60):
        for _ in range(n):
            m = json.loads(ws.receive_text())
            if m["event"] == event:
                return m["data"]
        raise AssertionError(f"нет события {event}")

    with client.websocket_connect(f"{API}/ws") as w, client.websocket_connect(f"{API}/ws") as other:
        w.send_text(json.dumps({"token": worker["Authorization"].split()[1]}))
        other.send_text(json.dumps({"token": welder["Authorization"].split()[1]}))
        until(w, "hello")
        until(other, "hello")
        client.post(f"{API}/incidents/{inc['id']}/ack", headers=sup)
        client.post(f"{API}/incidents/{inc['id']}/comment", headers=sup, json={"text": "проверка"})
        got = until(w, "problem.update")
        assert got["action"] == "ack" and got["by"] == "Ерлан Жумабеков"
        client.app.state.container.events.publish("ping.test", {})
        for _ in range(60):
            m = json.loads(other.receive_text())
            assert m["event"] != "problem.update"
            if m["event"] == "ping.test":
                break
