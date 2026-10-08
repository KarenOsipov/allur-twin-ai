from __future__ import annotations

import asyncio
from dataclasses import asdict

from fastapi import APIRouter

from app.api.deps import ContainerDep, OperatorDep, SessionDep, ViewerDep
from app.core.errors import NotFoundError
from app.schemas.requests import FailureIn, PauseIn, RepairIn, SpeedIn, SupplyDelayIn
from app.sim.forecast import forecast_shift

router = APIRouter(tags=["Цех"])


@router.get("/plant", summary="Схема завода: участки, оборудование, модели, цели")
def plant(c: ContainerDep, _: SessionDep) -> dict:
    p = c.plant
    return {
        "name": p.name,
        "takt_s": p.takt_s,
        "targets": asdict(p.targets),
        "shifts": [{"number": s.number, "start": s.start, "end": s.end} for s in p.shifts],
        "areas": [
            {
                "code": a.code,
                "name": a.name,
                "kind": a.kind.value,
                "line": a.line,
                "cycle_s": a.cycle_s,
                "buffer_after": a.buffer_after,
                "x": a.x,
            }
            for a in p.areas
        ],
        "equipment": [
            {
                "code": e.code,
                "name": e.name,
                "kind": e.kind,
                "area": e.area,
                "critical": e.critical,
                "mtbf_h": e.mtbf_h,
                "modes": [m.reason for m in e.modes if not m.planned],
            }
            for e in p.equipment
        ],
        "models": [{"code": m.code, "name": m.name, "month_plan": m.month_plan} for m in p.models],
        "economics": c.economics.economics(),
    }


@router.get("/floor", summary="Снимок цеха прямо сейчас (то же приходит по WebSocket)")
def floor(c: ContainerDep, _: SessionDep) -> dict:
    return c.live.snapshot()


@router.get("/floor/forecast", summary="Прогноз до конца смены (копия линии проматывается вперёд)")
async def floor_forecast(c: ContainerDep, _: ViewerDep) -> dict:
    twin = c.live.snapshot_copy()
    if twin is None:
        return {"available": False}
    return await asyncio.to_thread(forecast_shift, twin, c.plant.targets.shift_plan)


@router.post("/floor/speed", summary="Скорость модели (1 = реальное время)")
def set_speed(body: SpeedIn, c: ContainerDep, session: OperatorDep) -> dict:
    c.live.set_speed(body.speed)
    label = "реальное время" if body.speed == 1 else f"ускорение ×{body.speed:g}"
    c.audit.log("control", "speed", f"Скорость модели цеха: {label}", actor=session.name)
    return {"speed": c.live.speed}


@router.post("/floor/pause", summary="Пауза / продолжить")
def pause(body: PauseIn, c: ContainerDep, session: OperatorDep) -> dict:
    c.live.set_paused(body.paused)
    c.audit.log(
        "control",
        "pause",
        "Модель цеха на паузе" if body.paused else "Модель цеха продолжила работу",
        actor=session.name,
    )
    return {"paused": c.live.paused}


def _known(c, code: str) -> None:
    if code not in {e.code for e in c.plant.equipment}:
        raise NotFoundError(f"Оборудование «{code}» не найдено")


@router.post("/floor/failure", summary="Смоделировать отказ оборудования")
def failure(body: FailureIn, c: ContainerDep, session: OperatorDep) -> dict:
    _known(c, body.equipment)
    c.live.fail(body.equipment, body.minutes, body.reason)
    c.audit.log(
        "control",
        "failure",
        f"Остановлено вручную: {body.equipment} на {body.minutes:g} мин",
        actor=session.name,
        severity="warning",
        details={"Причина": body.reason or "не указана"},
    )
    return {"ok": True}


@router.post("/floor/repair", summary="Завершить ремонт досрочно")
def repair(body: RepairIn, c: ContainerDep, session: OperatorDep) -> dict:
    _known(c, body.equipment)
    c.live.repair(body.equipment)
    c.audit.log("control", "repair", f"Ремонт завершён досрочно: {body.equipment}", actor=session.name)
    return {"ok": True}


@router.post("/floor/supply-delay", summary="Смоделировать задержку поставки комплектов")
def supply_delay(body: SupplyDelayIn, c: ContainerDep, session: OperatorDep) -> dict:
    c.live.delay_supply(body.minutes)
    c.audit.log(
        "control",
        "supply",
        f"Задержка поставки комплектов на {body.minutes:g} мин",
        actor=session.name,
        severity="warning",
    )
    return {"ok": True}
