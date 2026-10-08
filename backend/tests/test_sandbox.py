from __future__ import annotations

from datetime import datetime

from app.domain.plant import ALLUR
from app.sim.engine import LineSim, SimConfig
from app.sim.sandbox import SimAction, run_sandbox
from tests.conftest import login

T0 = datetime(2026, 10, 7, 8, 0)


def _fork(hour: int = 11) -> LineSim:
    sim = LineSim(ALLUR, T0, SimConfig(), seed=3)
    while sim.clock < datetime(2026, 10, 7, hour, 0):
        sim.step(5)
    sim.drain_events()
    return sim


def test_critical_failure_costs_cars_and_money():
    fork = _fork()
    before = fork.clock
    action = SimAction(kind="failure", equipment="Конвейер-03", minutes=60)
    r = run_sandbox(fork, ALLUR, [action], fork.shift_end, margin_per_car=450_000, rework_cost=60_000, runs=4)
    s = r["summary"]
    assert fork.clock == before
    assert s["mean"]["lost"] >= 8
    assert s["mean"]["lost_low"] <= s["mean"]["lost"] <= s["mean"]["lost_high"]
    assert s["money_kzt"] > 3_000_000
    assert s["downtime_min"]["scenario"] >= s["downtime_min"]["baseline"] + 55
    assert "авто" in s["verdict"]
    assert r["frames"] and r["frames"][0]["ready"]
    assert any(e["kind"] == "down" and e["user"] for e in r["log"])
    assert len(r["shifts"]) == 1 and r["shifts"][0]["shift"] == 1
    assert r["series"]["scenario"][-1]["cars"] == s["cars"]["scenario"]


def test_no_event_effect_is_near_zero_and_temporary_effects_restore():
    fork = _fork()
    small = SimAction(kind="slowdown", area="QC", value=5, minutes=20)
    r = run_sandbox(fork, ALLUR, [small], fork.shift_end, margin_per_car=1, rework_cost=1, runs=3)
    assert abs(r["summary"]["mean"]["lost"]) <= 3
    defects = SimAction(kind="defects", area="PAINT", value=30, minutes=120)
    r2 = run_sandbox(fork, ALLUR, [defects], fork.shift_end, margin_per_car=1, rework_cost=1, runs=3)
    assert r2["summary"]["defects"]["extra"] >= 4
    assert any(e["kind"] == "defects_end" for e in r2["log"])


def test_sandbox_api_scopes_all_sections(client):
    h = login(client, "supervisor")
    c = client.app.state.container
    c.live.sim = _fork()
    res = client.post(
        "/api/v1/sandbox",
        headers=h,
        json={"events": [{"kind": "failure", "equipment": "ABB-01", "minutes": 45, "at_min": 10}], "horizon": "day"},
    )
    assert res.status_code == 200, res.text
    sb = res.json()
    assert sb["frames"] and sb["summary"]["plan"]["shifts"] == 2
    hs = {**h, "X-Sandbox": sb["id"]}
    live_kpi = client.get("/api/v1/kpi/overview?days=1", headers=h).json()
    sim_kpi = client.get("/api/v1/kpi/overview?days=1", headers=hs).json()
    assert sim_kpi["period"]["output"] != live_kpi["period"]["output"]
    inc = client.get("/api/v1/incidents", headers=hs).json()
    assert inc["simulated"] and any("ABB-01" in i["title"] for i in inc["items"])
    ans = client.post("/api/v1/assistant", headers=hs, json={"question": "Что будет из-за этой поломки?"}).json()
    assert ans["topic"] == "simulation"
    assert client.post("/api/v1/assistant/report", headers=hs).json()["text"]
    assert client.get("/api/v1/insights", headers=hs).status_code == 200
    other = login(client, "director", "1111")
    assert client.get(f"/api/v1/sandbox/{sb['id']}", headers=other).status_code == 404
    assert client.delete(f"/api/v1/sandbox/{sb['id']}", headers=h).status_code == 200
    assert client.get("/api/v1/kpi/overview?days=1", headers=hs).status_code == 404


def test_sandbox_rejects_unknown_equipment(client):
    h = login(client, "supervisor")
    client.app.state.container.live.sim = _fork()
    res = client.post("/api/v1/sandbox", headers=h, json={"events": [{"kind": "failure", "equipment": "X-1"}]})
    assert res.status_code == 422
