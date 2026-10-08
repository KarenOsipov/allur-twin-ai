from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from app.domain.plant import Plant
from app.sim.engine import LineSim, ScheduledStop, SimConfig


@dataclass
class Scenario:
    stops: list[ScheduledStop] = field(default_factory=list)
    cycle_factor: dict[str, float] = field(default_factory=dict)
    buffer_override: dict[str, int] = field(default_factory=dict)
    defect_pct: dict[str, float] = field(default_factory=dict)
    supply_delay: tuple[float, float] | None = None
    overtime_min: float = 0.0
    mtbf_h: dict[str, float] = field(default_factory=dict)
    mttr_factor: dict[str, float] = field(default_factory=dict)


PRESETS: list[dict] = [
    {
        "id": "conveyor_break",
        "title": "Обрыв цепи Конвейера-03",
        "text": "Цепь рвётся в 10:30 и линия сборки стоит 55 минут — как 02.10.",
        "scenario": {"stops": [{"equipment": "Конвейер-03", "at_min": 150, "minutes": 55, "shift": 1}]},
    },
    {
        "id": "paint_fix",
        "title": "Наладить окраску: брак 2%",
        "text": "Устранили причину брака Камеры-02 — брак окраски опускается до нормы 2%.",
        "scenario": {"defect_pct": {"PAINT": 2.0}},
    },
    {
        "id": "paint_faster",
        "title": "Ускорить окраску на 4%",
        "text": "Сокращаем цикл окраски (узкое место) с 234 до 225 секунд.",
        "scenario": {"cycle_factor": {"PAINT": 0.96}},
    },
    {
        "id": "bigger_buffer",
        "title": "Буфер перед окраской 6 → 12",
        "text": "Больше места для кузовов между сваркой и окраской — сварка реже упирается в окраску.",
        "scenario": {"buffer_override": {"WELD": 12}},
    },
    {
        "id": "supply_delay",
        "title": "Задержка поставки комплектов на 90 мин",
        "text": "В 09:00 склад комплектующих пустеет, поставка приходит через полтора часа.",
        "scenario": {"supply_delay": [60, 90]},
    },
    {
        "id": "overtime",
        "title": "Сверхурочно +2 часа",
        "text": "Вторая смена продлевается до 02:00, чтобы догнать план.",
        "scenario": {"overtime_min": 120},
    },
]


def _config(plant: Plant, sc: Scenario, base_defect: dict[str, float], base=None) -> SimConfig:
    defects = {k: v / 100 for k, v in base_defect.items()}
    cycle: dict[str, float] = {}
    buffers: dict[str, int] = {}
    extra: dict = {}
    if base is not None:
        defects.update({k: v / 100 for k, v in base.defect_pct.items()})
        cycle.update(base.cycle_factor)
        buffers.update(base.buffer_override)
        extra = {
            "mtbf_h": dict(base.mtbf_h),
            "mttr_factor": dict(base.mttr_factor),
            "kit_delivery_every_min": base.kit_every_min,
            "kit_delivery_size": base.kit_size,
        }
    defects.update({k: v / 100 for k, v in sc.defect_pct.items()})
    for k, v in sc.cycle_factor.items():
        cycle[k] = cycle.get(k, 1.0) * v
    buffers.update(sc.buffer_override)
    cfg = SimConfig(
        hazard_scale=1.0,
        random_failures=True,
        cycle_factor=cycle,
        buffer_override=buffers,
        defect_rate=defects,
        stops=list(sc.stops),
        supply_delay=sc.supply_delay,
        overtime_min=sc.overtime_min,
        **extra,
    )
    for code, h in sc.mtbf_h.items():
        cfg.mtbf_h[code] = h
    for code, k in sc.mttr_factor.items():
        cfg.mttr_factor[code] = cfg.mttr_factor.get(code, 1.0) * k
    return cfg


def _run_day(plant: Plant, cfg: SimConfig, seed: int, day: date, dt: float) -> dict:
    start = datetime.combine(day, plant.shifts[0].start)
    end = start + timedelta(hours=16, minutes=cfg.overtime_min + 2)
    sim = LineSim(plant, start, cfg, seed=seed)
    shifts: list[dict] = []
    down_min = 0.0
    timeline: list[int] = []
    done = 0
    next_mark = start
    bottleneck_votes: dict[str, int] = {}
    while sim.clock < end:
        sim.step(dt)
        for e in sim.drain_events():
            if e.kind == "shift_end":
                shifts.append(e.data)
            elif e.kind == "equipment_up" and e.data["critical"]:
                down_min += e.data["minutes"]
            elif e.kind == "body_done":
                done += 1
        if sim.clock >= next_mark:
            timeline.append(done)
            next_mark += timedelta(minutes=30)
            b = sim.bottleneck()
            if b:
                bottleneck_votes[b] = bottleneck_votes.get(b, 0) + 1
    if sim.working:
        shifts.append(sim.shift_summary())
    finished = sum(s["finished"] for s in shifts)
    defects = sum(a["defects"] for s in shifts for a in s["areas"].values())
    areas = {code: sum(s["areas"][code]["output"] for s in shifts) for code in ("WELD", "PAINT", "ASSY", "QC")}
    return {
        "finished": finished,
        "defects": defects,
        "downtime_min": down_min,
        "areas": areas,
        "timeline": timeline,
        "bottleneck": max(bottleneck_votes, key=lambda k: bottleneck_votes[k]) if bottleneck_votes else None,
    }


def _summarise(runs: list[dict]) -> dict:
    fin = [r["finished"] for r in runs]
    bvotes: dict[str, int] = {}
    for r in runs:
        if r["bottleneck"]:
            bvotes[r["bottleneck"]] = bvotes.get(r["bottleneck"], 0) + 1
    n = max(len(r["timeline"]) for r in runs)
    timeline = [round(statistics.mean(r["timeline"][i] for r in runs if i < len(r["timeline"])), 1) for i in range(n)]
    return {
        "finished": round(statistics.mean(fin), 1),
        "finished_min": min(fin),
        "finished_max": max(fin),
        "defects": round(statistics.mean(r["defects"] for r in runs), 1),
        "downtime_min": round(statistics.mean(r["downtime_min"] for r in runs), 1),
        "areas": {k: round(statistics.mean(r["areas"][k] for r in runs), 1) for k in runs[0]["areas"]},
        "bottleneck": max(bvotes, key=lambda k: bvotes[k]) if bvotes else None,
        "timeline": timeline,
    }


def run_whatif(
    plant: Plant,
    scenario: Scenario,
    base_defect_pct: dict[str, float],
    margin_per_car: int,
    rework_cost: int,
    runs: int = 6,
    day: date | None = None,
    dt: float = 10.0,
    base=None,
) -> dict:
    day = day or date(2026, 10, 7)
    while day.weekday() not in plant.workdays:
        day += timedelta(days=1)
    base_cfg = _config(plant, Scenario(), base_defect_pct, base)
    scen_cfg = _config(plant, scenario, base_defect_pct, base)
    seeds = [1000 + i * 17 for i in range(runs)]
    base = _summarise([_run_day(plant, base_cfg, s, day, dt) for s in seeds])
    scen = _summarise([_run_day(plant, scen_cfg, s, day, dt) for s in seeds])
    d_cars = scen["finished"] - base["finished"]
    d_def = scen["defects"] - base["defects"]
    workdays_month = 26
    effect_day = d_cars * margin_per_car - d_def * rework_cost
    return {
        "baseline": base,
        "scenario": scen,
        "delta": {
            "cars": round(d_cars, 1),
            "defects": round(d_def, 1),
            "downtime_min": round(scen["downtime_min"] - base["downtime_min"], 1),
            "effect_kzt_day": round(effect_day),
            "effect_kzt_month": round(effect_day * workdays_month),
        },
        "runs": runs,
        "assumptions": {
            "margin_per_car_kzt": margin_per_car,
            "rework_cost_kzt": rework_cost,
            "workdays_month": workdays_month,
        },
    }
