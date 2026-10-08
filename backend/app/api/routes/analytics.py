from __future__ import annotations

import asyncio

from fastapi import APIRouter, Query

from app.analytics.whatif import PRESETS, Scenario
from app.api.deps import ContainerDep, OperatorDep, ScopeDep, ViewerDep
from app.core.errors import ValidationFailed
from app.schemas.requests import ScenarioRunIn
from app.sim.engine import ScheduledStop

router = APIRouter(tags=["Аналитика и ИИ"])


@router.get(
    "/kpi/overview",
    summary="Показатели за период против целей + сравнение с прошлым периодом",
)
def overview(scope: ScopeDep, days: int = Query(7, ge=1, le=120)) -> dict:
    return scope.analytics.overview(days)


@router.get(
    "/insights",
    summary="Прогноз плана, риски отказов, качество, узкое место, аномалии, рекомендации",
)
def insights(scope: ScopeDep) -> dict:
    return scope.analytics.insights()


@router.get("/forecast/month", summary="Прогноз выполнения плана месяца")
def forecast(scope: ScopeDep) -> dict:
    return scope.analytics.month_forecast()


@router.get("/scenarios/presets", summary="Готовые сценарии")
def presets(_: ViewerDep) -> list[dict]:
    return PRESETS


@router.post(
    "/scenarios/run",
    summary="Прогнать сценарий на модели линии и сравнить с базовым днём",
)
async def run(body: ScenarioRunIn, c: ContainerDep, session: OperatorDep) -> dict:
    s = body.scenario
    areas = {a.code for a in c.plant.process_areas}
    for mapping in (s.cycle_factor, s.buffer_override, s.defect_pct):
        unknown = set(mapping) - areas
        if unknown:
            raise ValidationFailed(f"Неизвестный участок: {', '.join(sorted(unknown))}")
    if any(not 0.7 <= v <= 1.3 for v in s.cycle_factor.values()):
        raise ValidationFailed("Изменение цикла — от −30% до +30%")
    if any(not 1 <= v <= 40 for v in s.buffer_override.values()):
        raise ValidationFailed("Буфер — от 1 до 40 кузовов")
    if any(not 0 <= v <= 30 for v in s.defect_pct.values()):
        raise ValidationFailed("Брак — от 0 до 30%")
    known = {e.code for e in c.plant.equipment}
    for stop in s.stops:
        if stop.equipment not in known:
            raise ValidationFailed(f"Оборудование «{stop.equipment}» не найдено")
    scenario = Scenario(
        stops=[ScheduledStop(x.equipment, x.at_min, x.minutes, shift=x.shift) for x in s.stops],
        cycle_factor=s.cycle_factor,
        buffer_override=s.buffer_override,
        defect_pct=s.defect_pct,
        supply_delay=s.supply_delay,
        overtime_min=s.overtime_min,
    )
    result = await asyncio.to_thread(c.analytics.whatif, scenario, body.runs)
    c.audit.log(
        "scenario",
        "run",
        "Сценарий «решения на завтра» прогнан",
        actor=session.name,
        details=_scenario_details(s, result),
    )
    return result


def _scenario_details(s, result: dict) -> dict:
    d: dict = {}
    if s.stops:
        d["Остановки"] = ", ".join(f"{x.equipment} {x.minutes:g} мин" for x in s.stops)
    if s.cycle_factor:
        d["Цикл"] = ", ".join(f"{k} ×{v:g}" for k, v in s.cycle_factor.items())
    if s.buffer_override:
        d["Буферы"] = ", ".join(f"{k} {v}" for k, v in s.buffer_override.items())
    if s.overtime_min:
        d["Сверхурочно, мин"] = s.overtime_min
    delta = result.get("delta") if isinstance(result, dict) else None
    if isinstance(delta, dict) and "cars" in delta:
        d["Эффект, авто"] = delta["cars"]
    return d
