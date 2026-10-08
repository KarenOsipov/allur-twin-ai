from __future__ import annotations

import json

from fastapi import APIRouter
from pydantic import Field
from sqlalchemy import select

from app.api.deps import ContainerDep, OperatorDep, ViewerDep
from app.core.clock import plant_now
from app.core.errors import ForbiddenError, NotFoundError, ValidationFailed
from app.core.security import Permission, Session
from app.db.models import BuilderLayout
from app.schemas.requests import Strict

router = APIRouter(prefix="/layouts", tags=["Конструктор"])

MAX_BYTES = 3 * 1024 * 1024
MAX_NODES = 3000


class LayoutIn(Strict):
    name: str = Field(min_length=1, max_length=120)
    data: dict


def _check(body: LayoutIn) -> tuple[int, int]:
    raw = json.dumps(body.data, ensure_ascii=False)
    if len(raw.encode()) > MAX_BYTES:
        raise ValidationFailed("Проект слишком большой (больше 3 МБ)")
    nodes = body.data.get("nodes")
    edges = body.data.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValidationFailed("В проекте должны быть узлы и связи")
    if len(nodes) > MAX_NODES:
        raise ValidationFailed(f"Не больше {MAX_NODES} узлов в одном проекте")
    eq = 0
    for n in nodes:
        if not isinstance(n, dict) or not isinstance(n.get("data"), dict):
            raise ValidationFailed("Повреждённый узел в проекте")
        eq += len(n["data"].get("equipment") or [])
    return len(nodes), eq


def _out(x: BuilderLayout, with_data: bool = False) -> dict:
    d = {
        "id": x.id,
        "name": x.name,
        "nodes": x.nodes,
        "equipment": x.equipment,
        "author": x.author,
        "updated_at": x.updated_at,
    }
    if with_data:
        d["data"] = x.data
    return d


class FloorIn(Strict):
    id: int | None = None


@router.get("", summary="Сохранённые проекты")
def list_layouts(c: ContainerDep, _: ViewerDep) -> list[dict]:
    active = c.floor_layout.active_id()
    with c.db.session() as s:
        return [
            {**_out(x), "floor": x.id == active}
            for x in s.scalars(select(BuilderLayout).order_by(BuilderLayout.updated_at.desc()))
        ]


@router.get("/floor", summary="Схема цеха: проект конструктора, который показывает страница «Цех»")
def floor_layout(c: ContainerDep, _: ViewerDep) -> dict:
    return c.floor_layout.current()


@router.put("/floor", summary="Сделать проект схемой цеха (id = null — стандартная линия «Аллюр»)")
def set_floor_layout(body: FloorIn, c: ContainerDep, session: OperatorDep) -> dict:
    changes: list[dict] = []
    notes: list[str] = []
    if body.id is not None:
        with c.db.session() as s:
            x = s.get(BuilderLayout, body.id)
            if x is None:
                raise NotFoundError("Проект не найден")
            name, data = x.name, x.data
        c.floor_layout.activate(body.id, session.name)
        changes, notes = c.floor_layout.apply_layout(data, c.analytics.current_defect_levels())
        c.audit.log(
            "builder",
            "floor",
            f"Схема цеха: «{name}»",
            actor=session.name,
            severity="warning",
            details={x["what"]: f"{x['before']} → {x['after']}" for x in changes} or None,
        )
    else:
        c.floor_layout.activate(None, session.name)
        c.audit.log("builder", "floor", "Схема цеха: стандартная линия «Аллюр»", actor=session.name)
    _published(c, changes)
    return {**c.floor_layout.current(), "changes": changes, "notes": notes}


def _published(c, changes: list[dict]) -> None:
    if changes:
        c.events.publish("params.changed", {"changes": changes})
    c.events.publish("floor.layout", {"id": c.floor_layout.active_id()})


def _guard_floor(c, session: Session, layout_id: int) -> bool:
    if c.floor_layout.active_id() != layout_id:
        return False
    if not session.can(Permission.OPERATE):
        raise ForbiddenError("Схему цеха меняют администратор, директор или мастер смены.")
    return True


@router.get("/{layout_id}", summary="Открыть проект")
def get_layout(layout_id: int, c: ContainerDep, _: ViewerDep) -> dict:
    with c.db.session() as s:
        x = s.get(BuilderLayout, layout_id)
        if x is None:
            raise NotFoundError("Проект не найден")
        return _out(x, with_data=True)


@router.post("", summary="Сохранить новый проект")
def create_layout(body: LayoutIn, c: ContainerDep, session: OperatorDep) -> dict:
    nodes, eq = _check(body)
    with c.db.session() as s:
        x = BuilderLayout(
            name=body.name,
            data=body.data,
            nodes=nodes,
            equipment=eq,
            author=session.name,
            updated_at=plant_now(c.settings.tz_offset_min),
        )
        s.add(x)
        s.flush()
        out = _out(x)
    c.audit.log(
        "builder", "save", f"Сохранён проект «{body.name}»: {nodes} узлов, {eq} ед. оборудования", actor=session.name
    )
    return out


@router.put("/{layout_id}", summary="Обновить проект")
def update_layout(layout_id: int, body: LayoutIn, c: ContainerDep, session: OperatorDep) -> dict:
    nodes, eq = _check(body)
    is_floor = _guard_floor(c, session, layout_id)
    with c.db.session() as s:
        x = s.get(BuilderLayout, layout_id)
        if x is None:
            raise NotFoundError("Проект не найден")
        x.name, x.data, x.nodes, x.equipment = body.name, body.data, nodes, eq
        x.updated_at = plant_now(c.settings.tz_offset_min)
        out = _out(x)
    c.audit.log("builder", "update", f"Изменён проект «{body.name}»", actor=session.name)
    if is_floor:
        changes, notes = c.floor_layout.apply_layout(body.data, c.analytics.current_defect_levels())
        if changes:
            c.audit.log(
                "data",
                "params",
                f"Схема цеха изменила параметры линии: {len(changes)}",
                actor=session.name,
                severity="warning",
                details={x["what"]: f"{x['before']} → {x['after']}" for x in changes},
            )
        _published(c, changes)
        out = {**out, "floor": True, "changes": changes, "notes": notes}
    return out


@router.delete("/{layout_id}", summary="Удалить проект")
def delete_layout(layout_id: int, c: ContainerDep, session: OperatorDep) -> dict:
    _guard_floor(c, session, layout_id)
    with c.db.session() as s:
        x = s.get(BuilderLayout, layout_id)
        if x is None:
            raise NotFoundError("Проект не найден")
        name = x.name
        s.delete(x)
    c.audit.log("builder", "delete", f"Удалён проект «{name}»", actor=session.name, severity="warning")
    if c.floor_layout.forget(layout_id):
        _published(c, [])
    return {"ok": True}
