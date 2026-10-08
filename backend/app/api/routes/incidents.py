from __future__ import annotations

import asyncio
from typing import Literal

from fastapi import APIRouter, Query

from app.api.deps import ContainerDep, OperatorDep, ScopeDep, ViewerDep
from app.core.errors import TooManyRequestsError
from app.schemas.requests import CommentIn, ResolveIn

router = APIRouter(prefix="/incidents", tags=["Инциденты"])


@router.get("", summary="Журнал инцидентов")
def list_incidents(
    c: ContainerDep,
    scope: ScopeDep,
    status: Literal["active", "open", "ack", "resolved"] | None = None,
    severity: Literal["critical", "warning", "info"] | None = None,
    source: Literal["worker", "auto"] | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    if scope.sandbox:
        return c.sandboxes.incidents(scope.sandbox, status, severity)
    return c.incidents.list(status, severity, limit, offset, source=source)


@router.get("/{incident_id}", summary="Один инцидент")
def get_incident(incident_id: int, c: ContainerDep, _: ViewerDep) -> dict:
    return c.incidents.get(incident_id)


@router.get("/{incident_id}/impact", summary="Экспресс-анализ: сколько стоит, когда встанет линия, что делать")
async def impact(
    incident_id: int, c: ContainerDep, session: ViewerDep, minutes: float | None = Query(None, ge=1, le=480)
) -> dict:
    key = f"heavy:{session.user_id}"
    if c.heavy_limiter.blocked_for(key) > 0:
        raise TooManyRequestsError("Слишком много расчётов подряд. Подождите минуту.")
    c.heavy_limiter.hit(key)
    inc = c.incidents.get(incident_id)
    problem = c.advice.problem_from(inc, minutes)
    twin = c.live.snapshot_copy()
    out = await asyncio.to_thread(c.advice.impact, inc, problem, twin)
    if out.get("available"):
        c.audit.log(
            "incident",
            "impact",
            f"Экспресс-анализ: {inc['title']}",
            actor=session.name,
            details={
                "Потеря, авто": out["lost_cars"],
                "Потеря, ₸": out["lost_kzt"],
                "Прогноз смены": out["plan_expected"],
            },
        )
    return out


@router.post("/{incident_id}/ack", summary="Принять в работу")
def ack(incident_id: int, c: ContainerDep, session: OperatorDep) -> dict:
    out = c.incidents.ack(incident_id, session.name, c.live.clock, by_id=session.user_id)
    if out.get("source") == "worker":
        c.chat.system(
            out.get("area") or "all",
            f"{session.name} принял в работу: {out['title']}",
            ref={"incident": out["id"]},
            actor_id=session.user_id,
        )
    return out


@router.post("/{incident_id}/resolve", summary="Закрыть (станок в модели цеха тоже запускается)")
def resolve(incident_id: int, c: ContainerDep, session: OperatorDep, body: ResolveIn | None = None) -> dict:
    inc = c.incidents.get(incident_id)
    eq = inc.get("equipment")
    if eq and c.live.is_down(eq) and c.live.incident_of(eq) == incident_id:
        c.live.repair(eq)
    out = c.incidents.resolve(
        incident_id,
        c.live.clock,
        by=session.name,
        resolution=body.resolution if body else None,
        by_id=session.user_id,
    )
    if out.get("source") == "worker":
        done = f" Что сделано: {out['resolution']}" if out.get("resolution") else ""
        c.chat.system(
            out.get("area") or "all",
            f"Решено ({session.name}): {out['title']}.{done}",
            ref={"incident": out["id"]},
            actor_id=session.user_id,
        )
    return out


@router.post("/{incident_id}/comment", summary="Комментарий к сообщению — рабочий получит уведомление")
def comment(incident_id: int, body: CommentIn, c: ContainerDep, session: OperatorDep) -> dict:
    out = c.incidents.comment(incident_id, body.text, c.live.clock, session.name, session.user_id)
    c.audit.log(
        "incident",
        "comment",
        f"Комментарий к «{out['title']}»: {body.text.strip()[:120]}",
        actor=session.name,
    )
    return out
