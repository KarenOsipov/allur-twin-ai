from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import ContainerDep, ReporterDep, SessionDep, ShiftDep, ViewerDep
from app.core.security import Permission
from app.schemas.requests import ShiftCloseIn, ShiftReadyIn, ShiftSetupIn, ShiftStartIn

router = APIRouter(prefix="/shift", tags=["Смены"])


@router.get("", summary="Текущая смена и кто её ведёт")
def current(c: ContainerDep, _: SessionDep) -> dict:
    return c.shifts.current(c.live.snapshot())


@router.post("/start", summary="Принять смену")
def start(body: ShiftStartIn, c: ContainerDep, session: ShiftDep) -> dict:
    out = c.shifts.start(
        c.live.snapshot(),
        session.name,
        body.staff,
        body.note,
        c.live.clock,
        plan=body.plan,
        staff_by_area=body.staff_by_area,
        checklist=body.checklist,
    )
    missing = (out["summary"].get("start") or {}).get("missing") or []
    c.audit.log(
        "shift",
        "start",
        f"Смена {out['shift']} принята: {session.name}",
        actor=session.name,
        severity="warning" if missing else "info",
        details={
            "Людей на смене": out["staff"],
            "План": out["plan"],
            "Не отмечено при приёмке": "; ".join(missing) or None,
            "Заметка": body.note or None,
        },
    )
    c.chat.system(
        "all",
        f"Смену {out['shift']} принял {session.name}. План — {out['plan']} авто"
        + (f", на смене {out['staff']} чел." if out["staff"] else ".")
        + (f" Не отмечено при приёмке: {'; '.join(missing).lower()}." if missing else "")
        + " Подтвердите готовность на экране участка.",
        actor_id=session.user_id,
    )
    c.events.publish("shift.session", out)
    return out


@router.post("/close", summary="Сдать смену")
def close(body: ShiftCloseIn, c: ContainerDep, session: ShiftDep) -> dict:
    out = c.shifts.close(c.live.snapshot(), body.note, c.live.clock, session.name)
    s = out["summary"]
    c.audit.log(
        "shift",
        "closed",
        f"Смена {out['shift']} сдана: выпущено {s['finished']} (к этому часу план {s.get('plan_to_now')})",
        actor=session.name,
        details={"Брак, %": s["defect_pct"], "Инцидентов": s["incidents"], "Заметка": body.note or None},
    )
    c.chat.system(
        "all",
        f"Смена {out['shift']} сдана ({session.name}): выпущено {s['finished']} из {out['plan']}"
        + (f". Следующей смене: {body.note}" if body.note else "."),
        actor_id=session.user_id,
    )
    c.events.publish("shift.session", out)
    return out


@router.get("/setup", summary="Настройка смен: график, план, ответственные, нормы людей, чек-лист")
def get_setup(c: ContainerDep, _: ViewerDep) -> dict:
    return c.shifts.setup()


@router.put("/setup", summary="Сохранить настройку смен")
def put_setup(body: ShiftSetupIn, c: ContainerDep, session: ShiftDep) -> dict:
    out = c.shifts.save_setup(body.model_dump())
    c.audit.log(
        "shift",
        "setup",
        "Изменена настройка смен",
        actor=session.name,
        details={f"Смена {k}": f"план {v['plan']}, людей {sum(v['staff'].values())}" for k, v in out["shifts"].items()},
    )
    c.events.publish("shift.setup", {})
    return out


@router.get("/history", summary="Последние смены")
def history(c: ContainerDep, _: ViewerDep) -> list[dict]:
    return c.shifts.history(40)


def _public(out: dict, session) -> dict:
    if session.can(Permission.OPERATE):
        return out
    return {**out, "people": [p for p in out["people"] if p["user_id"] == session.user_id]}


@router.get("/ready", summary="Готовность людей к текущей смене: кто подтвердил, кто нет, кто не выйдет")
def readiness(c: ContainerDep, session: SessionDep) -> dict:
    return _public(c.shifts.readiness(c.live.snapshot(), session.user_id), session)


@router.post("/ready", summary="Подтвердить готовность к смене или сообщить, что не можете выйти")
def mark_ready(body: ShiftReadyIn, c: ContainerDep, session: ReporterDep) -> dict:
    out = c.shifts.mark_ready(c.live.snapshot(), session.user_id, body.status, body.note, c.live.clock)
    mine = out["mine"] or {}
    absent = body.status == "absent"
    c.audit.log(
        "shift",
        "ready",
        f"{session.name}: {'не может выйти' if absent else 'готов к работе'}"
        + (f" — {mine.get('note')}" if absent and mine.get("note") else ""),
        actor=session.name,
        severity="warning" if absent else "info",
        details={"Готовы": f"{out['ready']} из {out['total']}", "Не выйдут": out["absent"] or None},
    )
    if absent:
        c.chat.system(
            "staff",
            f"{session.name} не может выйти на смену {out['shift']}: {mine.get('note')}",
            kind="alert",
            actor_id=session.user_id,
        )
    c.events.publish(
        "shift.ready",
        {
            "shift_id": out["shift_id"],
            "user_id": session.user_id,
            "name": session.name,
            "status": body.status,
            "note": mine.get("note"),
            "total": out["total"],
            "ready": out["ready"],
            "absent": out["absent"],
            "pending": out["pending"],
        },
    )
    return _public(out, session)
