from __future__ import annotations

import copy
import statistics
from dataclasses import dataclass
from datetime import timedelta

from app.domain.plant import AreaKind, Plant
from app.sim.engine import EqStatus, LineSim

STEP_S = 10.0
MARK_MIN = 15


@dataclass
class Problem:
    kind: str
    area: str | None
    equipment: str | None
    minutes: float
    line_stopped: bool
    defect_pct: float | None = None


@dataclass
class Economics:
    margin: int
    rework: int
    overtime_rate: int
    line_staff: int


def _variant(twin: LineSim, end, seed: int, change) -> dict:
    sim = copy.deepcopy(twin)
    sim.cfg = copy.deepcopy(twin.cfg)
    sim.cfg.hazard_scale = 1.0
    sim.events = []
    sim.reseed(seed)
    change(sim)
    start_done = len(sim.finished)
    defects0 = sum(a.defects for a in sim.areas.values())
    marks, nxt = [], sim.clock
    while sim.clock < end - timedelta(seconds=1):
        sim.step(min(STEP_S, (end - sim.clock).total_seconds()))
        sim.events.clear()
        if sim.clock >= nxt:
            marks.append(len(sim.finished))
            nxt += timedelta(minutes=MARK_MIN)
    marks.append(len(sim.finished))
    return {
        "finished": len(sim.finished),
        "gained": len(sim.finished) - start_done,
        "defects": sum(a.defects for a in sim.areas.values()) - defects0,
        "marks": marks,
    }


def _run(twin: LineSim, end, change, runs: int) -> dict:
    res = [_variant(twin, end, 4_001 + 97 * i, change) for i in range(runs)]
    n = min(len(r["marks"]) for r in res)
    return {
        "finished": statistics.mean(r["finished"] for r in res),
        "low": min(r["finished"] for r in res),
        "high": max(r["finished"] for r in res),
        "defects": statistics.mean(r["defects"] for r in res),
        "series": [round(statistics.mean(r["marks"][k] for r in res), 1) for k in range(n)],
        "all": [r["finished"] for r in res],
    }


def _stop_for(code: str, minutes: float, reason: str):
    def change(sim: LineSim) -> None:
        eq = sim.equipment[code]
        if eq.status in (EqStatus.DOWN, EqStatus.MAINT):
            eq.until = sim.clock + timedelta(minutes=minutes)
        else:
            sim.fail(code, minutes, reason)

    return change


def _repair_now(code: str):
    def change(sim: LineSim) -> None:
        if sim.equipment[code].status in (EqStatus.DOWN, EqStatus.MAINT):
            sim.repair(code)

    return change


def _supply(minutes: float | None):
    def change(sim: LineSim) -> None:
        if minutes is None:
            if sim.kits_delayed_until is not None:
                sim.kits_delayed_until = sim.clock
        else:
            sim.kits = min(sim.kits, 3)
            sim.delay_supply(minutes)

    return change


def _defects(area: str, pct: float, stop_min: float = 0.0):
    def change(sim: LineSim) -> None:
        sim.cfg.defect_rate[area] = pct / 100
        if stop_min:
            crit = next((e for e in sim.equipment.values() if e.spec.area == area and e.spec.critical), None)
            if crit is not None:
                sim.fail(crit.spec.code, stop_min, "Перенастройка режимов")

    return change


def _noop(sim: LineSim) -> None:
    return None


def runway(twin: LineSim, plant: Plant, area: str | None) -> dict:
    if area is None or area not in twin.areas:
        return {}
    order = [a.code for a in plant.areas if a.kind != AreaKind.STORE]
    i = order.index(area)
    out: dict = {}
    if i + 1 < len(order):
        nxt = order[i + 1]
        k = len(twin.buffers[area])
        cyc = twin.areas[nxt].cycle_s
        out["downstream"] = {
            "area": nxt,
            "name": plant.area(nxt).name,
            "bodies": k,
            "minutes": round(
                k * cyc / 60
                + (1 - twin.areas[nxt].progress_s / max(twin.areas[nxt].target_s, 1))
                * cyc
                / 60
                * (1 if twin.areas[nxt].current else 0),
                1,
            ),
        }
    if i > 0:
        prev = order[i - 1]
        free = twin.buffer_cap[prev] - len(twin.buffers[prev])
        cyc = twin.areas[prev].cycle_s
        out["upstream"] = {
            "area": prev,
            "name": plant.area(prev).name,
            "free": free,
            "minutes": round(max(free, 0) * cyc / 60, 1),
        }
    elif area == order[0]:
        out["upstream"] = {"area": "WH_IN", "name": "Склад комплектующих", "free": None, "minutes": None}
    return out


def analyze(twin: LineSim | None, plant: Plant, p: Problem, econ: Economics, runs: int = 6) -> dict:
    takt_min = plant.takt_s / 60
    cost_per_min = round(econ.margin / takt_min)
    plan = plant.targets.shift_plan
    base = {
        "available": False,
        "cost_per_min_kzt": cost_per_min,
        "takt_min": round(takt_min, 1),
        "plan": plan,
    }
    if twin is None or not twin.working or twin.shift_end is None:
        base["note"] = "Смена не идёт — линия стоит по графику, прямых потерь выпуска нет."
        return base
    end = twin.shift_end
    left_min = (end - twin.clock).total_seconds() / 60
    minutes = max(1.0, min(p.minutes, left_min))
    eq = plant.eq(p.equipment) if p.equipment and p.equipment in twin.equipment else None
    stops_line = p.line_stopped and (eq is None or eq.critical)

    variants: dict[str, tuple[str, object]] = {}
    if p.kind == "supply":
        as_is = _supply(minutes)
        variants["none"] = ("Поставка пришла сразу", _noop)
        variants["express"] = ("Экстренная поставка", _supply(max(minutes * 0.4, 5)))
    elif p.kind == "quality" and p.area:
        level = p.defect_pct or 8.0
        as_is = _defects(p.area, level)
        normal = min(twin.cfg.defect_rate.get(p.area, 0.02) * 100, plant.targets.defect_pct)
        variants["none"] = ("Брак в норме", _defects(p.area, normal))
        variants["fix"] = ("Остановить на 15 мин и перенастроить", _defects(p.area, normal, stop_min=15))
    elif eq is not None and (p.line_stopped or twin.equipment[eq.code].status in (EqStatus.DOWN, EqStatus.MAINT)):
        as_is = _stop_for(eq.code, minutes, "Сообщение с участка")
        variants["none"] = ("Без поломки", _repair_now(eq.code))
        variants["fast"] = ("Срочный ремонт второй бригадой", _stop_for(eq.code, max(minutes * 0.5, 5), "Ремонт"))
    else:
        as_is = _noop
        variants["none"] = ("Без проблемы", _noop)

    r_as_is = _run(twin, end, as_is, runs)
    results = {k: (title, _run(twin, end, fn, runs)) for k, (title, fn) in variants.items()}
    r_none = results["none"][1]
    lost = max(0.0, r_none["finished"] - r_as_is["finished"])
    extra_def = max(0.0, r_as_is["defects"] - r_none["defects"])
    money = lost * econ.margin + extra_def * econ.rework

    options = []
    for k, (title, r) in results.items():
        if k == "none":
            continue
        saved = r["finished"] - r_as_is["finished"]
        saved_def = r_as_is["defects"] - r["defects"]
        effect = saved * econ.margin + saved_def * econ.rework
        options.append(
            {
                "id": k,
                "title": title,
                "action": _action_text(k, p, eq, minutes),
                "cars": round(saved, 1),
                "defects": round(saved_def, 1),
                "effect_kzt": round(effect),
                "cost_kzt": 0,
                "net_kzt": round(effect),
            }
        )
    options.sort(key=lambda o: -o["net_kzt"])
    best_prevent = max((o["cars"] for o in options if o["net_kzt"] > 0), default=0.0)
    rest = lost - best_prevent
    if rest >= 1:
        ot_min = round(rest * plant.takt_s / 60 * 1.1)
        ot_cost = round(ot_min / 60 * econ.line_staff * econ.overtime_rate)
        after = " после срочных мер" if best_prevent > 0 else ""
        options.append(
            {
                "id": "overtime",
                "title": f"Догнать план сверхурочно: +{ot_min} мин",
                "action": f"Продлить смену на {ot_min} мин, чтобы выпустить недостающие{after} ~{round(rest)} авто. "
                f"Оплата сверхурочных {econ.line_staff} рабочих — около {_money(ot_cost)}.",
                "cars": round(rest, 1),
                "defects": 0,
                "effect_kzt": round(rest * econ.margin),
                "cost_kzt": ot_cost,
                "net_kzt": round(rest * econ.margin - ot_cost),
            }
        )

    rw = runway(twin, plant, p.area if stops_line or p.kind == "equipment" else None)
    expected_as_is = round(r_as_is["finished"])
    expected_none = round(r_none["finished"])
    prob = round(sum(1 for x in r_as_is["all"] if x >= plan) / len(r_as_is["all"]) * 100)
    marks = [(twin.clock + timedelta(minutes=MARK_MIN * i)).strftime("%H:%M") for i in range(len(r_as_is["series"]))]
    if marks:
        marks[-1] = end.strftime("%H:%M")
    return {
        **base,
        "available": True,
        "now": twin.clock,
        "end": end,
        "minutes_left": round(left_min),
        "minutes": round(minutes),
        "line_stops": bool(stops_line),
        "lost_cars": round(lost, 1),
        "extra_defects": round(extra_def, 1),
        "lost_kzt": round(money),
        "per_min_kzt": round(money / minutes) if minutes else 0,
        "plan_expected": expected_as_is,
        "plan_expected_range": [r_as_is["low"], r_as_is["high"]],
        "plan_without": expected_none,
        "plan_probability": prob,
        "runway": rw,
        "options": options,
        "timeline": {"labels": marks, "as_is": r_as_is["series"], "without": r_none["series"][: len(marks)]},
        "runs": runs,
        "summary": _summary(
            p, eq, plant, minutes, lost, money, expected_as_is, plan, rw, options, cost_per_min, stops_line
        ),
    }


def _action_text(k: str, p: Problem, eq, minutes: float) -> str:
    if k == "fast":
        return (
            f"Вызвать вторую ремонтную бригаду на {eq.code if eq else 'участок'}: "
            f"ремонт ~{round(max(minutes * 0.5, 5))} мин вместо {round(minutes)}."
        )
    if k == "express":
        late = round(max(minutes * 0.4, 5))
        return f"Заказать экстренную доставку комплектов: задержка ~{late} мин вместо {round(minutes)}."
    if k == "fix":
        return "Остановить участок на 15 минут, найти причину брака и перенастроить режим — дальше брак в норме."
    return ""


def _money(v: float) -> str:
    a = abs(v)
    if a >= 1_000_000:
        return f"{a / 1e6:.1f} млн ₸".replace(".", ",")
    if a >= 10_000:
        return f"{round(a / 1000)} тыс ₸"
    return f"{round(a)} ₸"


def _summary(p, eq, plant, minutes, lost, money, expected, plan, rw, options, cost_per_min, stops_line) -> str:
    where = plant.area(p.area).name if p.area else "Линия"
    parts = []
    if p.kind == "supply":
        parts.append(
            f"Комплекты задерживаются. Когда склад опустеет, встанет вся линия — минута стоит ~{_money(cost_per_min)}."
        )
    elif stops_line:
        parts.append(f"{where} стоит. Минута остановки линии стоит около {_money(cost_per_min)}.")
    if lost >= 0.5:
        parts.append(
            f"Если проблема займёт ~{round(minutes)} мин, смена недоберёт ~{round(lost)} авто — около {_money(money)}."
        )
    elif money > 0:
        parts.append(f"Выпуск почти не пострадает, но брак обойдётся примерно в {_money(money)}.")
    else:
        parts.append("Выпуск почти не пострадает: буферы успеют закрыть простой.")
    down = rw.get("downstream")
    if stops_line and down and down["minutes"] is not None:
        parts.append(f"{down['name']} встанет через ~{round(down['minutes'])} мин (в буфере {down['bodies']} куз.).")
    parts.append(f"Прогноз смены: {expected} из {plan}.")
    best = next((o for o in options if o["net_kzt"] > 0), None)
    if best:
        parts.append(f"Лучшее действие — {best['title'].lower()}: сохранит около {_money(best['net_kzt'])}.")
    return " ".join(parts)
