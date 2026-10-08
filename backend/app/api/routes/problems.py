from __future__ import annotations

from fastapi import APIRouter, File, Form, UploadFile
from sqlalchemy import select

from app.api.deps import ContainerDep, OperatorDep, ReporterDep
from app.api.routes.chat import MAGIC, MAX_PHOTO
from app.core.errors import ForbiddenError, TooManyRequestsError, ValidationFailed
from app.db.models import ChatFile, User
from app.schemas.requests import ProblemIn

router = APIRouter(tags=["Участок и сообщения"])

KIND_LABEL = {
    "equipment": "Поломка оборудования",
    "supply": "Нет комплектующих",
    "quality": "Брак",
    "safety": "Опасная ситуация",
    "other": "Другое",
}


def _supervisor(c) -> str | None:
    cur = c.shifts.current(c.live.snapshot())
    sess = cur.get("session")
    return sess["supervisor"] if sess and not sess.get("closed_at") else None


REASONS = {
    "equipment": ["Не включается", "Ошибка на пульте", "Посторонний шум", "Утечка", "Перегрев", "Сломан инструмент"],
    "supply": ["Не подвезли", "Не та комплектация", "Повреждена упаковка", "Кончается на линии"],
    "quality": ["Подтёки краски", "Царапины", "Непровар шва", "Зазоры", "Не та деталь"],
    "safety": ["Травма", "Утечка", "Дым или запах", "Нет защиты", "Скользкий пол"],
    "other": ["Не хватает людей", "Вопрос по заданию", "Нужен мастер"],
}

URGENCY = {"high": "Срочно", "normal": "В течение часа", "low": "Не срочно"}


def _check_photo(c, photo_id: int | None, user_id: int | None) -> int | None:
    if photo_id is None:
        return None
    with c.db.session() as s:
        owner = s.scalar(select(ChatFile.author_id).where(ChatFile.id == photo_id))
    if owner is None or (user_id is not None and owner != user_id):
        raise ValidationFailed("Фото не найдено — прикрепите его ещё раз")
    return photo_id


def report_problem(c, body: ProblemIn, reporter: str, default_area: str | None, reporter_id: int | None = None) -> dict:
    area = body.area or default_area
    areas = {a.code: a for a in c.plant.areas}
    if area is None or area not in areas:
        raise ValidationFailed("Укажите участок")
    eq = None
    if body.equipment:
        eq = next((e for e in c.plant.equipment if e.code == body.equipment), None)
        if eq is None:
            raise ValidationFailed(f"Оборудование «{body.equipment}» не найдено")
        if eq.area != area:
            area = eq.area
    if body.kind == "equipment" and eq is None:
        raise ValidationFailed("Выберите, какое оборудование сломалось")
    inc = c.incidents.report(
        at=c.live.clock,
        kind=body.kind,
        area=area,
        equipment=eq.code if eq else None,
        text=body.text,
        line_stopped=body.line_stopped,
        reporter=reporter,
        area_name=areas[area].name,
        reporter_id=reporter_id,
        urgency=body.urgency,
        reasons=[r for r in body.reasons if isinstance(r, str)],
        photo_id=_check_photo(c, body.photo_id, reporter_id),
        est_minutes=body.minutes if body.line_stopped else None,
    )
    applied = None
    if body.kind == "equipment" and eq is not None and body.line_stopped:
        if c.live.fail(eq.code, body.minutes, body.text[:80] or "Сообщение с участка", incident_id=inc["id"]):
            applied = f"{eq.code} остановлен в модели цеха на ~{body.minutes:g} мин"
        else:
            applied = f"{eq.code} уже стоит в модели цеха"
    elif body.kind == "supply":
        c.live.claim_supply(inc["id"])
        c.live.delay_supply(body.minutes)
        applied = f"Поставка комплектов задержана в модели на ~{body.minutes:g} мин"
    return {"incident": inc, "applied": applied, "supervisor": _supervisor(c)}


@router.post("/problems", summary="Сообщить о проблеме на участке")
def create_problem(body: ProblemIn, c: ContainerDep, session: ReporterDep) -> dict:
    return report_problem(c, body, session.name, session.area, session.user_id)


@router.post("/problems/photo", summary="Прикрепить фото к сообщению о проблеме")
async def problem_photo(
    c: ContainerDep,
    session: ReporterDep,
    file: UploadFile = File(...),
    area: str | None = Form(None, max_length=16),
    width: int | None = Form(None, ge=1, le=10000),
    height: int | None = Form(None, ge=1, le=10000),
) -> dict:
    key = f"chat:{session.user_id}"
    if c.chat_limiter.blocked_for(key) > 0:
        raise TooManyRequestsError("Слишком много фото подряд — подождите немного")
    c.chat_limiter.hit(key)
    data = await file.read(MAX_PHOTO + 1)
    if len(data) > MAX_PHOTO:
        raise ValidationFailed("Фото больше 6 МБ")
    mime = next((m for sig, m in MAGIC.items() if data.startswith(sig)), None)
    if mime is None or (mime == "image/webp" and data[8:12] != b"WEBP"):
        raise ValidationFailed("Можно прикрепить только фото: JPEG, PNG или WebP")
    codes = {a.code for a in c.plant.areas}
    channel = session.area if session.role.value == "worker" else (area if area in codes else "staff")
    with c.db.session() as s:
        f = ChatFile(
            channel=channel or "all",
            author_id=session.user_id,
            created_at=c.live.clock,
            mime=mime,
            size=len(data),
            width=width,
            height=height,
            data=data,
        )
        s.add(f)
        s.flush()
        return {"id": f.id, "w": f.width, "h": f.height}


@router.get("/problems/mine", summary="Мои сообщения и их статус")
def my_problems(c: ContainerDep, session: ReporterDep) -> list[dict]:
    return c.incidents.mine(session.name, reporter_id=session.user_id)


@router.get("/worker/overview", summary="Мой участок: состояние, оборудование, смена")
def worker_overview(c: ContainerDep, session: ReporterDep, area: str | None = None) -> dict:
    code = area or session.area or "PAINT"
    if code not in {a.code for a in c.plant.areas}:
        raise ValidationFailed("Неизвестный участок")
    snap = c.live.snapshot()
    a = next((x for x in snap.get("areas", []) if x["code"] == code), None)
    eqs = [e for e in snap.get("equipment", []) if e["area"] == code]
    names = {e.code: e.name for e in c.plant.equipment}
    for e in eqs:
        e["name"] = names.get(e["code"], e["code"])
    k = snap.get("kpi", {})
    return {
        "area": {"code": code, "name": c.plant.area(code).name, **(a or {})},
        "equipment": eqs,
        "clock": snap.get("clock"),
        "working": snap.get("working"),
        "shift": snap.get("shift"),
        "kpi": {"finished": k.get("finished"), "plan_to_now": k.get("plan_to_now"), "shift_plan": k.get("shift_plan")},
        "supervisor": _supervisor(c),
        "kinds": KIND_LABEL,
        "reasons": REASONS,
        "urgency": URGENCY,
        "areas": [{"code": x.code, "name": x.name} for x in c.plant.areas],
    }


@router.post("/demo/problem", summary="Демо: рабочий окраски сообщает, что Камера-02 встала")
def demo_problem(c: ContainerDep, session: OperatorDep) -> dict:
    if not c.settings.demo_mode:
        raise ForbiddenError("Только в демо-режиме")
    body = ProblemIn(
        kind="equipment",
        area="PAINT",
        equipment="Камера-02",
        text="Пропала подача краски, камера встала. Насос гудит, давления нет.",
        line_stopped=True,
        minutes=35,
    )
    with c.db.session() as s:
        uid = s.scalar(select(User.id).where(User.name == "Данияр Оспанов", User.active.is_(True)))
    out = report_problem(c, body, "Данияр Оспанов", "PAINT", uid)
    c.audit.log("control", "demo", "Демонстрация: сообщение с участка окраски", actor=session.name)
    return out
