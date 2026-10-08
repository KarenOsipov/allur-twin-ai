from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import ContainerDep, UsersAdminDep
from app.core.errors import ValidationFailed
from app.core.security import ROLE_NAMES, Role
from app.schemas.requests import DecideIn, UserIn, UserPatch

router = APIRouter(prefix="/users", tags=["Сотрудники"])


def _area(c, area: str | None) -> None:
    if area is not None and area not in {a.code for a in c.plant.areas}:
        raise ValidationFailed(f"Неизвестный участок: {area}")


@router.get("", summary="Все сотрудники")
def list_users(c: ContainerDep, _: UsersAdminDep) -> list[dict]:
    return c.users.list()


@router.post("", summary="Добавить сотрудника")
def create_user(body: UserIn, c: ContainerDep, session: UsersAdminDep) -> dict:
    _area(c, body.area)
    u = c.users.create(body.model_dump())
    c.audit.log(
        "users",
        "create",
        f"Добавлен сотрудник: {u['name']} — {u['position'].lower()}",
        actor=session.name,
        details={"Роль": ROLE_NAMES[Role(u["role"])], "Участок": u["area"]},
    )
    return u


@router.patch("/{user_id}", summary="Изменить сотрудника, сменить PIN, отключить")
def update_user(user_id: int, body: UserPatch, c: ContainerDep, session: UsersAdminDep) -> dict:
    data = body.model_dump(exclude_unset=True)
    _area(c, data.get("area"))
    u = c.users.update(user_id, data, by_user_id=session.user_id)
    what = []
    if "pin" in data:
        what.append("сменён PIN/пароль")
    if "login" in data:
        what.append("логин")
    if data.get("active") is False:
        what.append("отключён")
    if data.get("active") is True:
        what.append("включён")
    for k, label in (("role", "роль"), ("position", "должность"), ("name", "ФИО"), ("area", "участок")):
        if k in data:
            what.append(label)
    c.audit.log(
        "users",
        "update",
        f"Сотрудник {u['name']}: {', '.join(what) or 'изменён'}",
        actor=session.name,
        severity="warning" if "pin" in data or data.get("active") is False else "info",
    )
    return u


@router.post("/{user_id}/approve", summary="Подтвердить заявку на доступ (можно поправить роль, участок, должность)")
def approve(user_id: int, c: ContainerDep, session: UsersAdminDep, body: DecideIn | None = None) -> dict:
    data = body.model_dump(exclude_none=True) if body else {}
    _area(c, data.get("area"))
    u = c.users.decide(user_id, True, data)
    c.audit.log(
        "users",
        "approve",
        f"Заявка подтверждена: {u['name']} — {u['role_name'].lower()}",
        actor=session.name,
        details={"Участок": u["area"], "Логин": u["login"]},
    )
    c.events.publish("users.request", {"id": u["id"], "decided": "approved"})
    return u


@router.post("/{user_id}/reject", summary="Отклонить заявку на доступ")
def reject(user_id: int, c: ContainerDep, session: UsersAdminDep) -> dict:
    u = c.users.decide(user_id, False)
    c.audit.log("users", "reject", f"Заявка отклонена: {u['name']}", actor=session.name, severity="warning")
    c.events.publish("users.request", {"id": u["id"], "decided": "rejected"})
    return u
