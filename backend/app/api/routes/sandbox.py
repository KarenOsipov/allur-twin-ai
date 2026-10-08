from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import ContainerDep, ViewerDep
from app.schemas.requests import SandboxIn
from app.services.sandbox_service import SandboxService
from app.sim.sandbox import SimAction

router = APIRouter(prefix="/sandbox", tags=["Симуляция"])


@router.post("", summary="Запустить симуляцию от текущего момента живой линии")
async def create(body: SandboxIn, c: ContainerDep, session: ViewerDep) -> dict:
    actions = [SimAction(**e.model_dump()) for e in body.events]
    sb = await c.sandboxes.create(session.sandbox_owner, actions, body.horizon)
    c.audit.log(
        "simulation",
        "run",
        "Симуляция: " + "; ".join(a["title"] for a in sb.result["actions"]),
        actor=session.name,
        details={
            "Окно": f"{sb.result['start']:%H:%M}–{sb.result['end']:%H:%M}",
            "Итог": sb.summary["verdict"],
            "Потеря, авто": sb.summary["mean"]["lost"],
            "Цена, ₸": sb.summary["money_kzt"],
        },
    )
    return SandboxService.public(sb)


@router.get("/{sandbox_id}", summary="Результат симуляции: кадры, хронология, итог")
def get(sandbox_id: str, c: ContainerDep, session: ViewerDep) -> dict:
    return SandboxService.public(c.sandboxes.get(sandbox_id, session.sandbox_owner))


@router.delete("/{sandbox_id}", summary="Выйти из симуляции")
def delete(sandbox_id: str, c: ContainerDep, session: ViewerDep) -> dict:
    c.sandboxes.delete(sandbox_id, session.sandbox_owner)
    c.audit.log("simulation", "exit", "Возврат из симуляции в реальное время", actor=session.name)
    return {"ok": True}
