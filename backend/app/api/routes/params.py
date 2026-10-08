from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import AdminDep, ContainerDep, ViewerDep
from app.schemas.requests import ParamsIn

router = APIRouter(prefix="/params", tags=["Параметры линии"])


@router.get("", summary="Параметры участков, оборудования и поставок")
def get_params(c: ContainerDep, _: ViewerDep) -> dict:
    return c.params.view(c.analytics.current_defect_levels())


@router.put("", summary="Изменить параметры (сразу применяются к живому цеху и расчётам)")
def put_params(body: ParamsIn, c: ContainerDep, session: AdminDep) -> dict:
    changes = c.params.update(body.model_dump(), c.analytics.current_defect_levels())
    if changes:
        c.audit.log(
            "data",
            "params",
            f"Изменены параметры линии: {len(changes)}",
            actor=session.name,
            severity="warning",
            details={x["what"]: f"{_n(x['before'])} → {_n(x['after'])}" for x in changes},
        )
        c.events.publish("params.changed", {"changes": changes})
        if c.floor_layout.write_back(c.analytics.current_defect_levels()):
            c.events.publish("floor.layout", {"id": c.floor_layout.active_id()})
    return {"changes": changes, **c.params.view(c.analytics.current_defect_levels())}


@router.post("/reset", summary="Вернуть все параметры к модели завода")
def reset_params(c: ContainerDep, session: AdminDep) -> dict:
    c.params.reset()
    c.audit.log(
        "data", "params_reset", "Параметры линии возвращены к модели завода", actor=session.name, severity="warning"
    )
    c.events.publish("params.changed", {"changes": []})
    if c.floor_layout.write_back(c.analytics.current_defect_levels()):
        c.events.publish("floor.layout", {"id": c.floor_layout.active_id()})
    return c.params.view(c.analytics.current_defect_levels())


def _n(v) -> str:
    return f"{v:g}".replace(".", ",") if isinstance(v, (int, float)) else str(v)
