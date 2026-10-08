from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import date

from app.analytics.economy import DEFAULTS as ECONOMY_DEFAULTS
from app.analytics.whatif import Scenario, _config, _run_day, _summarise
from app.domain.plant import AreaKind, Plant

WORKDAYS = 26
SHIFT_H = 8
ACC = {"Сварка": "сварку", "Окраска": "окраску", "Сборка": "сборку", "Контроль качества": "контроль качества"}
GEN = {"Сварка": "сварки", "Окраска": "окраски", "Сборка": "сборки", "Контроль качества": "контроля качества"}


@dataclass
class Candidate:
    id: str
    title: str
    why: str
    scenario: Scenario
    cost_month: int = 0
    capex: int = 0
    cost_note: str = ""
    area: str | None = None
    equipment: str | None = None
    scenario_json: dict = field(default_factory=dict)


def candidates(plant: Plant, insights: dict, econ: dict, live_buffers: dict[str, int]) -> list[Candidate]:
    out: list[Candidate] = []
    labor = econ.get("labor_rate_kzt_h", 3500)
    overtime = econ.get("overtime_rate_kzt_h", 5250)
    staff = econ.get("line_staff", 60)
    shifts = len(plant.shifts)
    operator_month = round(labor * SHIFT_H * shifts * WORKDAYS)

    b = insights.get("bottleneck") or {}
    constraint = b.get("constraint")
    if constraint:
        area = plant.area(constraint)
        out.append(
            Candidate(
                id="bn-cycle",
                title=f"Ускорить {ACC.get(area.name, area.name.lower())} на 5%: оператор-подготовщик в каждую смену",
                why=f"{area.name} — узкое место: каждая её минута — минута всего завода. "
                f"Цикл {area.cycle_s:.0f} → {area.cycle_s * 0.95:.0f} с за счёт подготовки кузова вне поста.",
                scenario=Scenario(cycle_factor={constraint: 0.95}),
                cost_month=operator_month,
                cost_note=f"+1 оператор в смену: {_m(operator_month)} в месяц",
                area=constraint,
                scenario_json={"cycle_factor": {constraint: 0.95}},
            )
        )
        order = [a.code for a in plant.areas if a.kind == AreaKind.PROCESS]
        if constraint in order and order.index(constraint) > 0:
            prev = order[order.index(constraint) - 1]
            cap = live_buffers.get(prev, plant.area(prev).buffer_after)
            out.append(
                Candidate(
                    id="bn-buffer",
                    title=f"Буфер перед узким местом {cap} → {cap + 6} кузовов",
                    why=f"Когда {plant.area(prev).name.lower()} простаивает, {area.name.lower()} остаётся без кузовов. "
                    "Больший буфер защищает узкое место от простоев соседей.",
                    scenario=Scenario(buffer_override={prev: cap + 6}),
                    capex=6 * 1_500_000,
                    cost_note="6 мест накопителя ≈ 9 млн ₸ разово",
                    area=prev,
                    scenario_json={"buffer_override": {prev: cap + 6}},
                )
            )

    worst = None
    for q in insights.get("quality") or []:
        if q.get("status") != "ok" and (worst is None or q["level"] > worst["level"]):
            worst = q
    if worst:
        target = plant.targets.defect_pct
        out.append(
            Candidate(
                id=f"quality-{worst['area']}",
                title=f"Вернуть брак {GEN.get(worst['name'], worst['name'].lower())} к норме {target:.0f}%",
                why=f"Сейчас {worst['level']:.1f}%. Каждый дефектный кузов — переделка "
                f"{_m(econ.get('rework_cost_kzt', 60000))}. Контроль режима и толщины покрытия каждого 10-го кузова.",
                scenario=Scenario(defect_pct={worst["area"]: target}),
                cost_month=round(operator_month * 0.5),
                cost_note=f"контролёр на полставки: {_m(round(operator_month * 0.5))} в месяц",
                area=worst["area"],
                scenario_json={"defect_pct": {worst["area"]: target}},
            )
        )

    risky = [r for r in insights.get("risks") or [] if r.get("critical") and r.get("level") == "high"]
    risky.sort(key=lambda r: -r.get("expected_loss_kzt", 0))
    for r in risky[:2]:
        eq = plant.eq(r["code"])
        out.append(
            Candidate(
                id=f"pm-{eq.code}",
                title=f"Профилактика {eq.code} в ночное окно",
                why=f"Риск отказа {round(r['probability'] * 100)}% за 7 дней, главная причина — "
                f"«{(r.get('main_reason') or 'отказ').lower()}». "
                "Плановая замена узла ночью вдвое снижает частоту отказов днём.",
                scenario=Scenario(mtbf_h={eq.code: eq.mtbf_h * 2}),
                cost_month=350_000,
                cost_note="запчасти и 2 ч работы слесаря ночью: ≈ 350 тыс ₸ в месяц",
                area=eq.area,
                equipment=eq.code,
                scenario_json={},
            )
        )

    crit = [e.code for e in plant.equipment if e.critical]
    fitters = round(labor * 1.3 * SHIFT_H * shifts * WORKDAYS)
    out.append(
        Candidate(
            id="crew",
            title="Дежурный слесарь у линии: ремонт на 30% быстрее",
            why="Сейчас половина простоя — ожидание ремонтника и запчастей. Дежурный слесарь с ЗИП у критичных станков "
            "начинает ремонт сразу.",
            scenario=Scenario(mttr_factor={c: 0.7 for c in crit}),
            cost_month=fitters,
            cost_note=f"+1 слесарь в смену: {_m(fitters)} в месяц",
            scenario_json={},
        )
    )
    ot_cost = round(overtime * staff * 1 * WORKDAYS)
    out.append(
        Candidate(
            id="overtime",
            title="Сверхурочный час во вторую смену",
            why="Самый быстрый способ добрать план, но самый дорогой — оплата всей линии по ставке ×1,5.",
            scenario=Scenario(overtime_min=60),
            cost_month=ot_cost,
            cost_note=f"{staff} чел. × 1 ч × {WORKDAYS} дн.: {_m(ot_cost)} в месяц",
            scenario_json={"overtime_min": 60},
        )
    )
    return out


def evaluate(
    plant: Plant,
    cands: list[Candidate],
    base_defect_pct: dict[str, float],
    econ: dict,
    day: date,
    base_params=None,
    runs: int = 6,
    shortfall_month: float = 0.0,
) -> list[dict]:
    margin = econ.get("margin_per_car_kzt", 450_000)
    rework = econ.get("rework_cost_kzt", 60_000)
    overhead = float((econ.get("economy") or {}).get("overhead_kzt_min", ECONOMY_DEFAULTS["overhead_kzt_min"]))
    line_minute = econ.get("line_staff", 60) * econ.get("overtime_rate_kzt_h", 5250) / 60 + overhead
    time_value = plant.takt_s / 60 * line_minute
    seeds = [2000 + i * 31 for i in range(runs)]
    base_cfg = _config(plant, Scenario(), base_defect_pct, base_params)
    base_runs = [_run_day(plant, base_cfg, s, day, 10.0) for s in seeds]
    base = _summarise(base_runs)
    out = []
    for c in cands:
        cfg = _config(plant, c.scenario, base_defect_pct, base_params)
        runs_c = [_run_day(plant, cfg, s, day, 10.0) for s in seeds]
        sc = _summarise(runs_c)
        diffs = [rc["finished"] - rb["finished"] for rc, rb in zip(runs_c, base_runs, strict=True)]
        cars = sc["finished"] - base["finished"]
        defects = sc["defects"] - base["defects"]
        extra = cars * WORKDAYS
        paid = min(max(extra, 0.0), shortfall_month)
        rest = extra - paid
        rest_value = 0.0 if c.id == "overtime" and rest > 0 else time_value
        gross = round(paid * margin + rest * rest_value - defects * rework * WORKDAYS)
        net = gross - c.cost_month
        payback = None
        if c.capex:
            payback = round(c.capex / net, 1) if net > 0 else None
        spread = statistics.pstdev(diffs) if len(diffs) > 1 else 0.0
        out.append(
            {
                "id": c.id,
                "title": c.title,
                "why": c.why,
                "result": _result(cars, defects, gross),
                "valuation": "маржа: план под угрозой"
                if paid > 0
                else (
                    "план выполняется — лишние авто не нужны"
                    if c.id == "overtime"
                    else "сэкономленное время линии: план и так выполняется"
                    if extra > 0.5
                    else "переделка брака"
                ),
                "cars_day": round(cars, 1),
                "cars_low": round(min(diffs), 1),
                "cars_high": round(max(diffs), 1),
                "defects_day": round(defects, 1),
                "effect_kzt_month": gross,
                "cost_kzt_month": c.cost_month,
                "capex_kzt": c.capex,
                "cost_note": c.cost_note,
                "net_kzt_month": net,
                "payback_months": payback,
                "confidence": "высокая"
                if spread < max(abs(cars), 0.5) / 2
                else "средняя"
                if spread < abs(cars)
                else "низкая",
                "area": c.area,
                "equipment": c.equipment,
                "scenario": c.scenario_json or None,
                "worth_it": net > 0,
            }
        )
    out.sort(key=lambda x: (not x["worth_it"], -x["net_kzt_month"]))
    return out


def _result(cars: float, defects: float, gross: int) -> str:
    parts = []
    if abs(cars) >= 0.3:
        parts.append(f"{'+' if cars > 0 else '−'}{abs(cars):.1f} авто в день".replace(".", ","))
    if abs(defects) >= 0.3:
        parts.append(f"{'−' if defects < 0 else '+'}{abs(defects):.1f} дефекта в день".replace(".", ","))
    if not parts:
        parts.append("выпуск почти не меняется")
    sign = "+" if gross >= 0 else "−"
    return f"{', '.join(parts)} → {sign}{_m(abs(gross))} в месяц"


def _m(v: float) -> str:
    a = abs(v)
    if a >= 1_000_000:
        return f"{a / 1e6:.1f} млн ₸".replace(".", ",")
    if a >= 10_000:
        return f"{round(a / 1000)} тыс ₸"
    return f"{round(a)} ₸"
