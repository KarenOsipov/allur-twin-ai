from datetime import date, datetime

from app.analytics import bottleneck, checks, forecast, kpi, quality, risk
from app.analytics.whatif import Scenario, run_whatif
from app.domain.plant import ALLUR
from app.sim.engine import LineSim, ScheduledStop, SimConfig

TODAY = date(2026, 10, 6)


def test_oee_matches_manual_calculation():
    oee = kpi.oee_of(118, 2, 7.8, 8, 228)
    assert round(oee.availability, 4) == 0.975
    assert round(oee.performance, 3) == round(118 * 228 / (7.8 * 3600), 3)
    assert round(oee.quality, 4) == round(116 / 118, 4)


def test_customer_rows_override_history(seeded):
    ds = seeded.dataset()
    rows = [r for r in ds.production if r.day == date(2026, 10, 1) and r.shift == 1]
    assert {r.source for r in rows} == {"customer"}
    assert {r.area: r.fact for r in rows} == {"WELD": 118, "PAINT": 115, "ASSY": 121}


def test_data_checks_find_plan_gap_and_paint_defects(seeded):
    found = checks.data_checks(seeded.dataset(), ALLUR, TODAY)
    titles = " | ".join(c["title"] for c in found)
    assert "4 800 вместо 5 500" in titles
    assert "брак 5,2%" in titles
    assert "Конвейер-03: 55 мин" in titles


def test_risk_model_flags_conveyor_chain(seeded):
    model = risk.RiskModel(ALLUR)
    risks = {r.code: r for r in model.predict(seeded.dataset(), TODAY, 450_000)}
    conveyor = risks["Конвейер-03"]
    assert conveyor.level == "high"
    assert conveyor.intervals[-1] < conveyor.intervals[0] / 2
    assert any("сокращаются" in f for f in conveyor.factors)
    assert model.info["trained_on"] > 500


def test_quality_finds_paint_trend_and_filter_does_not_help(seeded):
    paint = next(q for q in quality.quality_analysis(seeded.dataset(), ALLUR, TODAY) if q["area"] == "PAINT")
    assert paint["status"] == "critical"
    kinds = {c["kind"] for c in paint["causes"]}
    assert "trend" in kinds
    filt = next(c for c in paint["causes"] if c["kind"] == "maintenance")
    assert "не влияет" in filt["text"]


def test_bottleneck_is_paint(seeded):
    assert bottleneck.bottleneck_history(seeded.dataset(), ALLUR)["constraint"] == "PAINT"


def test_month_forecast_has_corridor(seeded):
    f = forecast.month_forecast(seeded.dataset(), ALLUR, TODAY)
    assert f["available"]
    assert f["p10"] <= f["expected"] <= f["p90"]
    assert f["fact_to_date"] > 0


def test_line_sim_respects_buffers_and_stops():
    cfg = SimConfig(random_failures=False, stops=[ScheduledStop("Конвейер-03", 60, 30)])
    sim = LineSim(ALLUR, datetime(2026, 10, 7, 8, 0), cfg, seed=1)
    while sim.clock < datetime(2026, 10, 7, 16, 1):
        sim.step(5)
        for code, buf in sim.buffers.items():
            assert len(buf) <= sim.buffer_cap[code]
    events = [e.kind for e in sim.drain_events()]
    assert "equipment_down" in events and "equipment_up" in events and "shift_end" in events


def test_whatif_breakdown_loses_cars():
    sc = Scenario(stops=[ScheduledStop("Конвейер-03", 150, 55)])
    res = run_whatif(ALLUR, sc, {"PAINT": 4.5}, 450_000, 60_000, runs=2, day=date(2026, 10, 7), dt=10)
    assert res["delta"]["cars"] < -5
    assert res["delta"]["effect_kzt_day"] < 0
