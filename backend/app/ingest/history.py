from __future__ import annotations

import math
import random
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from app.domain.plant import Plant

CUSTOMER_DAYS = (date(2026, 10, 1), date(2026, 10, 2))
SHIFT_MIN = 480


@dataclass
class GeneratedHistory:
    production: list[dict] = field(default_factory=list)
    quality: list[dict] = field(default_factory=list)
    downtime: list[dict] = field(default_factory=list)
    model_output: list[dict] = field(default_factory=list)


def _backward_dates(anchor: date, intervals: list[float], start: date) -> list[date]:
    out = [anchor]
    d = anchor
    for gap in intervals:
        d = d - timedelta(days=round(gap))
        if d < start:
            break
        out.append(d)
    return sorted(out)


def _workday(plant: Plant, d: date) -> bool:
    return d.weekday() in plant.workdays


def _nearest_workday(plant: Plant, d: date) -> date:
    while not _workday(plant, d):
        d -= timedelta(days=1)
    return d


def generate_history(plant: Plant, end_day: date, days: int, seed: int = 7) -> GeneratedHistory:
    rng = random.Random(seed)
    start = end_day - timedelta(days=days - 1)
    out = GeneratedHistory()
    period = max((end_day - start).days, 1)

    chain_breaks = {
        _nearest_workday(plant, d)
        for d in _backward_dates(date(2026, 10, 2), [6, 7, 9, 11, 13, 16, 21], start)
        if d not in CUSTOMER_DAYS
    }
    abb04_maintenance = {
        _nearest_workday(plant, d)
        for d in _backward_dates(date(2026, 10, 2), [14] * 8, start)
        if d not in CUSTOMER_DAYS
    }
    filter_changes = {
        _nearest_workday(plant, d)
        for d in _backward_dates(date(2026, 10, 1), [11] * 10, start)
        if d not in CUSTOMER_DAYS
    }
    supply_delays = {start + timedelta(days=k) for k in (17, 39, 58, 79) if start + timedelta(days=k) <= end_day}
    oven_failures: set[date] = set()

    buffers = {"WELD": 4, "PAINT": 5}
    plan = plant.targets.shift_plan
    lines = plant.lines
    models = plant.models
    mix_total = sum(m.month_plan for m in models)

    d = start
    while d <= end_day:
        if not _workday(plant, d):
            d += timedelta(days=1)
            continue
        progress = (d - start).days / period
        day_output = 0
        for shift in plant.shifts:
            sn = shift.number
            customer_shift = d in CUSTOMER_DAYS and sn == 1
            shift_start = datetime.combine(d, shift.start)
            down: dict[str, list[dict]] = defaultdict(list)

            def stop(
                area: str,
                eq: str,
                reason: str,
                minutes: float,
                planned: bool = False,
                at_min: float | None = None,
                _day: date = d,
                _sn: int = sn,
                _start: datetime = shift_start,
                _down: dict = down,
            ) -> None:
                at = at_min if at_min is not None else rng.uniform(20, SHIFT_MIN - minutes - 10)
                _down[area].append(
                    {
                        "day": _day,
                        "shift": _sn,
                        "area": area,
                        "equipment": eq,
                        "reason": reason,
                        "minutes": round(minutes),
                        "planned": planned,
                        "started_at": _start + timedelta(minutes=at),
                        "source": "history",
                    }
                )

            if not customer_shift:
                if d in chain_breaks and sn == 1:
                    stop("ASSY", "Конвейер-03", "Обрыв цепи", rng.uniform(45, 62))
                if d in abb04_maintenance and sn == 1:
                    stop("WELD", "ABB-04", "Плановое ТО", 30, planned=True, at_min=5)
                if d in filter_changes and sn == 1:
                    stop(
                        "PAINT",
                        "Камера-02",
                        "Замена фильтра",
                        40,
                        planned=True,
                        at_min=5,
                    )
                if rng.random() < (0.42 if sn == 2 else 0.08):
                    stop("WELD", "ABB-01", "Ошибка датчика", rng.uniform(14, 30))
                if d in supply_delays and sn == 1:
                    stop(
                        "WELD",
                        "Поставка",
                        "Задержка поставки комплектов JAC J7",
                        rng.uniform(35, 75),
                    )
                for eq in plant.equipment:
                    if eq.code in ("ABB-01",):
                        continue
                    unplanned = [m for m in eq.modes if not m.planned]
                    if eq.code == "Конвейер-03":
                        unplanned = [m for m in unplanned if m.reason != "Обрыв цепи"]
                    if not unplanned:
                        continue
                    p = 8.0 / eq.mtbf_h * 0.55
                    if rng.random() < p:
                        mode = rng.choices(unplanned, weights=[m.weight for m in unplanned])[0]
                        minutes = max(6.0, rng.lognormvariate(math.log(mode.mttr_min), 0.35))
                        if eq.critical:
                            stop(eq.area, eq.code, mode.reason, minutes)
                        else:
                            stop(eq.area, eq.code, mode.reason, minutes * 0.6)
                        if eq.code == "Печь-01":
                            oven_failures.add(d)

            for recs in down.values():
                out.downtime.extend(recs)

            monday_start = d.weekday() == 0 and sn == 1
            facts: dict[str, int] = {}
            runs: dict[str, float] = {}
            upstream_avail = 10_000
            for area in lines:
                stop_min = sum(r["minutes"] for r in down[area.code] if plant_eq_critical(plant, r["equipment"]))
                slow_min = sum(r["minutes"] for r in down[area.code] if not plant_eq_critical(plant, r["equipment"]))
                micro = rng.uniform(4, 14) + (14 if monday_start else 0)
                run_min = max(0.0, SHIFT_MIN - stop_min - micro)
                perf = rng.uniform(0.955, 1.0) * (0.965 if sn == 2 else 1.0) * (0.93 if monday_start else 1.0)
                capacity = run_min * 60 / area.cycle_s * perf - slow_min * 60 / area.cycle_s * 0.4
                fact = int(min(capacity, plan + 3))
                if area.code != lines[0].code:
                    fact = min(fact, upstream_avail)
                facts[area.code] = max(0, fact)
                runs[area.code] = run_min / 60
                buf = buffers.get(area.code, 0)
                upstream_avail = facts[area.code] + buf

            prev = None
            for area in lines:
                if prev is not None and prev.code in buffers:
                    cap = prev.buffer_after
                    buffers[prev.code] = max(
                        0,
                        min(
                            cap,
                            buffers[prev.code] + facts[prev.code] - facts[area.code],
                        ),
                    )
                prev = area

            for area in lines:
                out.production.append(
                    {
                        "day": d,
                        "shift": sn,
                        "area": area.code,
                        "line": area.line,
                        "plan": plan,
                        "fact": facts[area.code],
                        "run_hours": round(runs[area.code], 1),
                        "load_pct": round(runs[area.code] / 8 * 100),
                        "source": "history",
                    }
                )

            for area in lines:
                produced = facts[area.code]
                if area.code == "WELD":
                    sensor = any(r["equipment"] == "ABB-01" for r in down["WELD"])
                    rate = 1.5 + (1.1 if sensor else 0) + rng.gauss(0, 0.35)
                elif area.code == "PAINT":
                    rate = 1.3 + 3.3 * progress**1.7 + (0.7 if sn == 2 else 0)
                    if (d - timedelta(days=1)) in oven_failures or d in oven_failures:
                        rate += 1.6
                    rate += rng.gauss(0, 0.45)
                else:
                    rate = 1.0 + rng.gauss(0, 0.35)
                defects = max(0, round(produced * max(rate, 0.2) / 100))
                out.quality.append(
                    {
                        "day": d,
                        "shift": sn,
                        "area": area.code,
                        "produced": produced,
                        "defects": defects,
                        "source": "history",
                    }
                )
            day_output += facts[lines[-1].code]

        remaining = day_output
        for i, m in enumerate(models):
            if i == len(models) - 1:
                qty = remaining
            else:
                share = m.month_plan / mix_total
                qty = min(
                    remaining,
                    max(0, round(day_output * share * rng.uniform(0.94, 1.06))),
                )
            if m.code == "J7" and d in supply_delays:
                qty = max(0, qty - rng.randint(4, 9))
            remaining -= qty
            out.model_output.append({"day": d, "model": m.name, "qty": max(0, qty), "source": "history"})
        d += timedelta(days=1)

    return out


def plant_eq_critical(plant: Plant, code: str) -> bool:
    if code == "Поставка":
        return True
    try:
        return plant.eq(code).critical
    except StopIteration:
        return True


def shift_time(d: date, t: time) -> datetime:
    return datetime.combine(d, t)
