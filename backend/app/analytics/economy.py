from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from app.analytics import kpi
from app.domain.plant import Plant

DEFAULTS = {
    "overhead_kzt_min": 2_000,
    "downtime_line_share": 0.6,
}

LABELS = {
    "overhead_kzt_min": "Энергия и накладные расходы минуты работы линии, ₸",
    "downtime_line_share": "Доля простоя станка, которая теряет выпуск линии",
}

WORKDAYS = 26


def economy(ds, plant: Plant, today, econ: dict, days: int = 30) -> dict:
    a = {**DEFAULTS, **{k: v for k, v in (econ.get("economy") or {}).items() if k in DEFAULTS}}
    margin = float(econ.get("margin_per_car_kzt", 450_000))
    rework = float(econ.get("rework_cost_kzt", 60_000))
    labor = float(econ.get("labor_rate_kzt_h", 3_500))
    overtime = float(econ.get("overtime_rate_kzt_h", 5_250))
    staff = int(econ.get("line_staff", 60))
    share = float(a["downtime_line_share"])

    end = min(ds.last_day or today, today)
    first = min((r.day for r in ds.production), default=end)
    start = max(end - timedelta(days=days - 1), first)
    p = kpi.period_kpis(ds, plant, start, end)
    work_days = max(p["days"], 1)
    k = WORKDAYS / work_days

    last_line = plant.lines[-1].code
    prod = [r for r in ds.production if start <= r.day <= end]
    shifts = len({(r.day, r.shift) for r in prod if r.area == last_line}) or 1
    shift_h = plant.shifts[0].hours
    hours = shifts * shift_h
    cars_per_min = 60 / plant.takt_s

    output = p["output"]
    plan = p["plan"]
    margin_income = output * margin
    payroll = staff * labor * hours
    overhead = a["overhead_kzt_min"] * hours * 60
    cost_per_car = (payroll + overhead) / output if output else 0.0

    qual = [r for r in ds.quality if start <= r.day <= end]
    defects = sum(r.defects for r in qual if r.area in {ln.code for ln in plant.lines})
    produced = sum(r.produced for r in qual if r.area in {ln.code for ln in plant.lines})
    norm = plant.targets.defect_pct / 100
    excess = max(0.0, defects - produced * norm)

    down = [r for r in ds.downtime if start <= r.day <= end]
    unplanned = [r for r in down if not r.planned]
    unplanned_min = sum(r.minutes for r in unplanned)
    planned_min = sum(r.minutes for r in down if r.planned)
    dt_cars = unplanned_min * share * cars_per_min
    shortfall = max(0.0, plan - output)

    losses = {
        "shortfall_cars": shortfall,
        "shortfall_kzt": shortfall * margin,
        "downtime_min": unplanned_min,
        "downtime_stops": len(unplanned),
        "downtime_cars": dt_cars,
        "downtime_kzt": dt_cars * margin,
        "planned_min": planned_min,
        "defects": defects,
        "defects_excess": excess,
        "rework_kzt": defects * rework,
        "rework_excess_kzt": excess * rework,
    }
    total_losses = losses["shortfall_kzt"] + losses["rework_kzt"]

    names = {ar.code: ar.name for ar in plant.areas}
    eq_names = {e.code: e.name for e in plant.equipment}
    by_area: dict[str, dict] = defaultdict(lambda: {"down_min": 0.0, "stops": 0, "defects": 0})
    for r in unplanned:
        by_area[r.area]["down_min"] += r.minutes
        by_area[r.area]["stops"] += 1
    for r in qual:
        by_area[r.area]["defects"] += r.defects
    areas = []
    for code, v in by_area.items():
        dt_kzt = v["down_min"] * share * cars_per_min * margin
        rw_kzt = v["defects"] * rework
        if dt_kzt + rw_kzt <= 0:
            continue
        areas.append(
            {
                "area": code,
                "name": names.get(code, code),
                "down_min": round(v["down_min"] * k),
                "stops": round(v["stops"] * k),
                "defects": round(v["defects"] * k),
                "downtime_kzt": round(dt_kzt * k),
                "rework_kzt": round(rw_kzt * k),
                "total_kzt": round((dt_kzt + rw_kzt) * k),
            }
        )
    areas.sort(key=lambda x: -x["total_kzt"])

    by_eq: dict[str, dict] = defaultdict(lambda: {"min": 0.0, "stops": 0, "reasons": defaultdict(float), "area": ""})
    for r in unplanned:
        e = by_eq[r.equipment]
        e["min"] += r.minutes
        e["stops"] += 1
        e["area"] = r.area
        e["reasons"][r.reason or "без причины"] += r.minutes
    equipment = sorted(
        (
            {
                "code": code,
                "name": eq_names.get(code, code),
                "area": names.get(v["area"], v["area"]),
                "down_min": round(v["min"] * k),
                "stops": round(v["stops"] * k),
                "reason": max(v["reasons"].items(), key=lambda x: x[1])[0] if v["reasons"] else "",
                "kzt_month": round(v["min"] * share * cars_per_min * margin * k),
            }
            for code, v in by_eq.items()
        ),
        key=lambda x: -x["kzt_month"],
    )[:8]

    by_reason: dict[str, list] = defaultdict(lambda: [0.0, 0])
    for r in unplanned:
        by_reason[r.reason or "без причины"][0] += r.minutes
        by_reason[r.reason or "без причины"][1] += 1
    reasons = sorted(
        (
            {
                "reason": key,
                "down_min": round(v[0] * k),
                "stops": round(v[1] * k),
                "kzt_month": round(v[0] * share * cars_per_min * margin * k),
            }
            for key, v in by_reason.items()
        ),
        key=lambda x: -x["kzt_month"],
    )[:6]

    out_by_day: dict = defaultdict(lambda: [0, 0])
    for r in prod:
        if r.area == last_line:
            out_by_day[r.day][0] += r.fact
            out_by_day[r.day][1] += r.plan
    def_by_day: dict = defaultdict(int)
    for r in qual:
        if r.area in {ln.code for ln in plant.lines}:
            def_by_day[r.day] += r.defects
    daily = [
        {
            "day": d,
            "output": v[0],
            "plan": v[1],
            "margin_kzt": round(v[0] * margin),
            "loss_kzt": round(max(0, v[1] - v[0]) * margin + def_by_day[d] * rework),
        }
        for d, v in sorted(out_by_day.items())
    ]

    recover_min = shortfall / cars_per_min if cars_per_min else 0.0
    overtime_cost = recover_min / 60 * staff * overtime + recover_min * a["overhead_kzt_min"]
    potential = [
        {
            "id": "defects",
            "title": "Брак до нормы",
            "text": f"{round(excess * k)} дефектов в месяц сверх нормы {plant.targets.defect_pct:g}% — "
            f"каждый стоит {_m(rework)} переделки",
            "kzt_month": round(excess * rework * k),
        },
        {
            "id": "downtime",
            "title": "Внеплановые простои на треть меньше",
            "text": f"{round(unplanned_min * k)} мин простоя в месяц, из них выпуск теряет {share:.0%} — "
            f"минута линии стоит {_m(cars_per_min * margin)} маржи",
            "kzt_month": round(dt_cars * margin * k / 3),
        },
        {
            "id": "plan",
            "title": "План выполнен полностью",
            "text": f"Недовыпуск {round(shortfall * k)} авто в месяц × {_m(margin)} маржи",
            "kzt_month": round(shortfall * margin * k),
        },
        {
            "id": "overtime",
            "title": "Догнать план сверхурочными",
            "text": f"{str(round(recover_min * k / 60, 1)).replace('.', ',')} ч работы линии в месяц: "
            f"{staff} чел. × {_m(overtime)} в час "
            f"+ накладные. Возвращает {_m(shortfall * margin * k)} маржи",
            "kzt_month": round((shortfall * margin - overtime_cost) * k),
            "cost_kzt_month": round(overtime_cost * k),
        },
    ]

    month = {
        "output": round(output * k),
        "plan": round(plan * k),
        "margin_income_kzt": round(margin_income * k),
        "payroll_kzt": round(payroll * k),
        "overhead_kzt": round(overhead * k),
        "losses_kzt": round(total_losses * k),
        "result_kzt": round((margin_income - payroll - overhead - losses["rework_kzt"]) * k),
    }
    return {
        "period": {"start": start, "end": end, "days": p["days"], "shifts": shifts, "hours": round(hours)},
        "month": month,
        "plan_pct": p["plan_pct"],
        "cost_per_car_kzt": round(cost_per_car),
        "minute_kzt": round(cars_per_min * margin),
        "minute_cost_kzt": round(staff * labor / 60 + a["overhead_kzt_min"]),
        "losses": {
            key: round(v * k, 1) if key.endswith(("cars", "excess")) else round(v * k) for key, v in losses.items()
        },
        "losses_total_kzt": round(total_losses * k),
        "areas": areas,
        "equipment": equipment,
        "reasons": reasons,
        "daily": daily,
        "potential": potential,
        "assumptions": [
            {"key": key, "label": LABELS[key], "value": a[key], "default": DEFAULTS[key]} for key in DEFAULTS
        ],
        "basis": {
            "margin_per_car_kzt": margin,
            "rework_cost_kzt": rework,
            "labor_rate_kzt_h": labor,
            "overtime_rate_kzt_h": overtime,
            "line_staff": staff,
            "workdays_month": WORKDAYS,
            "shift_hours": shift_h,
            "takt_s": plant.takt_s,
        },
    }


def _m(v: float) -> str:
    a = abs(v)
    if a >= 1_000_000:
        return f"{a / 1e6:.1f} млн ₸".replace(".", ",")
    if a >= 10_000:
        return f"{round(a / 1000)} тыс ₸"
    return f"{round(a)} ₸"
