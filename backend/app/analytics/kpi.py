from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from app.domain.plant import Plant
from app.services.data_service import Dataset

SHIFT_H = 8.0


@dataclass(frozen=True)
class Oee:
    availability: float
    performance: float
    quality: float

    @property
    def value(self) -> float:
        return self.availability * self.performance * self.quality

    def as_dict(self) -> dict:
        return {
            "oee": round(self.value * 100, 1),
            "availability": round(self.availability * 100, 1),
            "performance": round(self.performance * 100, 1),
            "quality": round(self.quality * 100, 1),
        }


def oee_of(fact: int, defects: int, run_h: float, planned_h: float, cycle_s: float) -> Oee:
    a = min(1.0, run_h / planned_h) if planned_h else 0.0
    p = min(1.0, fact * cycle_s / (run_h * 3600)) if run_h > 0 else 0.0
    q = (fact - defects) / fact if fact else 1.0
    return Oee(a, p, q)


def _in(d: date, start: date, end: date) -> bool:
    return start <= d <= end


def period_kpis(ds: Dataset, plant: Plant, start: date, end: date) -> dict:
    prod = [r for r in ds.production if _in(r.day, start, end)]
    qual = [r for r in ds.quality if _in(r.day, start, end)]
    down = [r for r in ds.downtime if _in(r.day, start, end)]
    last_line = plant.lines[-1].code
    defects_by = defaultdict(int)
    for q in qual:
        defects_by[(q.day, q.shift, q.area)] += q.defects

    lines = []
    for area in plant.lines:
        rows = [r for r in prod if r.area == area.code]
        fact = sum(r.fact for r in rows)
        defects = sum(defects_by[(r.day, r.shift, r.area)] for r in rows)
        run_h = sum(r.run_hours for r in rows)
        oee = oee_of(fact, defects, run_h, SHIFT_H * len(rows), area.cycle_s)
        lines.append(
            {
                "area": area.code,
                "line": area.line,
                "name": area.name,
                "plan": sum(r.plan for r in rows),
                "fact": fact,
                "defects": defects,
                "defect_pct": round(defects / fact * 100, 2) if fact else 0.0,
                "run_hours": round(run_h, 1),
                "shifts": len(rows),
                **oee.as_dict(),
            }
        )
    output_rows = [r for r in prod if r.area == last_line]
    output = sum(r.fact for r in output_rows)
    plan = sum(r.plan for r in output_rows)
    all_fact = sum(line["fact"] for line in lines)
    all_def = sum(line["defects"] for line in lines)
    plant_oee = sum(line["oee"] for line in lines) / len(lines) if lines else 0.0

    unplanned = sum(r.minutes for r in down if not r.planned)
    planned = sum(r.minutes for r in down if r.planned)
    days = sorted({r.day for r in prod})
    crit = critical_downtime(ds, plant, start, end)
    t = plant.targets
    return {
        "start": start,
        "end": end,
        "days": len(days),
        "output": output,
        "plan": plan,
        "plan_pct": round(output / plan * 100, 1) if plan else 0.0,
        "oee": round(plant_oee, 1),
        "defect_pct": round(all_def / all_fact * 100, 2) if all_fact else 0.0,
        "downtime_unplanned_min": round(unplanned),
        "downtime_planned_min": round(planned),
        "critical_downtime_breaches": crit["breaches"],
        "worst_equipment_day": crit["worst"],
        "lines": lines,
        "checks": [
            _check("oee", "OEE", plant_oee, t.oee_pct, "≥", "%"),
            _check(
                "defect",
                "Брак",
                all_def / all_fact * 100 if all_fact else 0,
                t.defect_pct,
                "≤",
                "%",
            ),
            _check(
                "downtime",
                "Простой критичного оборудования",
                crit["worst"]["minutes"] if crit["worst"] else 0,
                t.critical_downtime_min_per_day,
                "≤",
                " мин/сут",
            ),
            _check(
                "plan",
                "Выполнение плана",
                output / plan * 100 if plan else 0,
                100.0,
                "≥",
                "%",
            ),
        ],
    }


def _check(key: str, label: str, value: float, target: float, op: str, unit: str) -> dict:
    ok = value >= target if op == "≥" else value <= target
    near = abs(value - target) <= max(target * 0.08, 0.3)
    return {
        "key": key,
        "label": label,
        "value": round(value, 2),
        "target": target,
        "op": op,
        "unit": unit,
        "status": "ok" if ok and not near else ("warning" if ok or near else "critical"),
    }


def critical_downtime(ds: Dataset, plant: Plant, start: date, end: date) -> dict:
    per = defaultdict(float)
    for r in ds.downtime:
        if r.planned or not _in(r.day, start, end):
            continue
        try:
            critical = plant.eq(r.equipment).critical
        except StopIteration:
            critical = r.equipment == "Поставка"
        if critical:
            per[(r.day, r.equipment)] += r.minutes
    limit = plant.targets.critical_downtime_min_per_day
    breaches = [{"day": d, "equipment": eq, "minutes": round(m)} for (d, eq), m in sorted(per.items()) if m > limit]
    worst = max(per.items(), key=lambda kv: kv[1], default=None)
    return {
        "breaches": breaches,
        "worst": {
            "day": worst[0][0],
            "equipment": worst[0][1],
            "minutes": round(worst[1]),
        }
        if worst
        else None,
    }


def daily_series(ds: Dataset, plant: Plant, start: date, end: date) -> list[dict]:
    last_line = plant.lines[-1].code
    cycle = {a.code: a.cycle_s for a in plant.lines}
    by_day: dict[date, dict] = {}
    defects = defaultdict(int)
    produced = defaultdict(int)
    for q in ds.quality:
        if _in(q.day, start, end):
            defects[(q.day, q.area)] += q.defects
            produced[(q.day, q.area)] += q.produced
    agg = defaultdict(lambda: {"fact": 0, "plan": 0, "run": 0.0, "n": 0})
    for r in ds.production:
        if not _in(r.day, start, end):
            continue
        a = agg[(r.day, r.area)]
        a["fact"] += r.fact
        a["plan"] += r.plan
        a["run"] += r.run_hours
        a["n"] += 1
    downtime = defaultdict(float)
    for r in ds.downtime:
        if _in(r.day, start, end) and not r.planned:
            downtime[r.day] += r.minutes
    days = sorted({d for d, _ in agg})
    for d in days:
        oees = []
        quality = {}
        for area in plant.lines:
            a = agg.get((d, area.code))
            if not a or not a["n"]:
                continue
            oees.append(
                oee_of(
                    a["fact"],
                    defects[(d, area.code)],
                    a["run"],
                    SHIFT_H * a["n"],
                    cycle[area.code],
                ).value
            )
            p = produced[(d, area.code)]
            quality[area.code] = round(defects[(d, area.code)] / p * 100, 2) if p else 0.0
        out = agg[(d, last_line)]
        by_day[d] = {
            "day": d,
            "output": out["fact"],
            "plan": out["plan"],
            "oee": round(sum(oees) / len(oees) * 100, 1) if oees else None,
            "defect_pct": quality,
            "downtime_min": round(downtime[d]),
        }
    return list(by_day.values())


def downtime_pareto(ds: Dataset, plant: Plant, start: date, end: date, by: str = "reason") -> list[dict]:
    acc: dict[str, dict] = {}
    for r in ds.downtime:
        if not _in(r.day, start, end):
            continue
        key = r.reason if by == "reason" else r.equipment
        item = acc.setdefault(
            key,
            {
                "key": key,
                "minutes": 0.0,
                "count": 0,
                "planned": r.planned,
                "equipment": set(),
            },
        )
        item["minutes"] += r.minutes
        item["count"] += 1
        item["equipment"].add(r.equipment)
    rows = sorted(acc.values(), key=lambda x: -x["minutes"])
    total = sum(x["minutes"] for x in rows) or 1
    running = 0.0
    out = []
    for x in rows:
        running += x["minutes"]
        out.append(
            {
                "key": x["key"],
                "minutes": round(x["minutes"]),
                "count": x["count"],
                "planned": x["planned"],
                "share": round(x["minutes"] / total * 100, 1),
                "cumulative": round(running / total * 100, 1),
                "equipment": sorted(x["equipment"]),
            }
        )
    return out


def month_progress(ds: Dataset, plant: Plant, month: str) -> dict:
    plans = {p.model: p.plan for p in ds.model_plan if p.month == month}
    if not plans:
        months = sorted({p.month for p in ds.model_plan})
        if months:
            plans = {p.model: p.plan for p in ds.model_plan if p.month == months[-1]}
    if not plans:
        plans = {m.name: m.month_plan for m in plant.models}
    facts = defaultdict(int)
    for r in ds.model_output:
        if r.day.strftime("%Y-%m") == month:
            facts[r.model] += r.qty
    models = [{"model": m, "plan": p, "fact": facts.get(m, 0)} for m, p in plans.items()]
    return {
        "month": month,
        "models": models,
        "models_plan_total": sum(plans.values()),
        "target": plant.targets.month_output,
        "fact": sum(facts.values()),
    }
