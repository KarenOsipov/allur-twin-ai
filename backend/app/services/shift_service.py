from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, or_, select

from app.core.errors import ValidationFailed
from app.db.base import Database
from app.db.models import Incident, SettingValue, ShiftReady, ShiftSession, User
from app.domain.plant import AreaKind, Plant

SETUP_KEY = "shift_setup"
DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
CHECKLIST = [
    "Оборудование осмотрено, замечаний нет",
    "Средства защиты и инструмент на местах",
    "Комплектующие на начало смены подвезены",
    "Передача от прошлой смены прочитана",
    "Люди расставлены по участкам",
]
STAFF_NORM = {"WH_IN": 4, "WELD": 10, "PAINT": 14, "ASSY": 20, "QC": 6, "WH_OUT": 4}


def _out(x: ShiftSession | None) -> dict | None:
    if x is None:
        return None
    return {
        "id": x.id,
        "day": x.day,
        "shift": x.shift,
        "supervisor": x.supervisor,
        "started_at": x.started_at,
        "closed_at": x.closed_at,
        "plan": x.plan,
        "staff": x.staff,
        "note": x.note,
        "summary": x.summary or {},
    }


class ShiftService:
    def __init__(self, db: Database, plant: Plant) -> None:
        self.db = db
        self.plant = plant

    def _default_setup(self) -> dict:
        staff = {a.code: STAFF_NORM.get(a.code, 4) for a in self.plant.areas}
        return {
            "shifts": {
                str(sh.number): {"plan": self.plant.targets.shift_plan, "supervisor": None, "staff": dict(staff)}
                for sh in self.plant.shifts
            },
            "checklist": list(CHECKLIST),
        }

    def setup(self) -> dict:
        base = self._default_setup()
        with self.db.session() as s:
            row = s.get(SettingValue, SETUP_KEY)
            saved = dict(row.value) if row else {}
            sups = [
                {"name": u.name, "position": u.position}
                for u in s.scalars(
                    select(User)
                    .where(User.active.is_(True), User.role.in_(("supervisor", "admin")))
                    .order_by(User.name)
                )
            ]
        for k, v in (saved.get("shifts") or {}).items():
            if k in base["shifts"]:
                base["shifts"][k] = {
                    **base["shifts"][k],
                    **v,
                    "staff": {**base["shifts"][k]["staff"], **(v.get("staff") or {})},
                }
        if saved.get("checklist") is not None:
            base["checklist"] = saved["checklist"]
        return {
            **base,
            "schedule": [
                {
                    "number": sh.number,
                    "start": sh.start.strftime("%H:%M"),
                    "end": sh.end.strftime("%H:%M"),
                    "hours": sh.hours,
                }
                for sh in self.plant.shifts
            ],
            "workdays": [DAYS[d] for d in sorted(self.plant.workdays)],
            "areas": [{"code": a.code, "name": a.name, "store": a.kind == AreaKind.STORE} for a in self.plant.areas],
            "supervisors": sups,
        }

    def save_setup(self, data: dict) -> dict:
        codes = {a.code for a in self.plant.areas}
        numbers = {str(sh.number) for sh in self.plant.shifts}
        shifts: dict = {}
        for k, v in data["shifts"].items():
            if k not in numbers:
                raise ValidationFailed(f"Нет смены {k}")
            bad = [c for c in v["staff"] if c not in codes]
            if bad:
                raise ValidationFailed(f"Неизвестный участок: {bad[0]}")
            if any(not 0 <= n <= 500 for n in v["staff"].values()):
                raise ValidationFailed("Людей на участке — от 0 до 500")
            shifts[k] = {"plan": v["plan"], "supervisor": (v.get("supervisor") or None), "staff": v["staff"]}
        checklist = [x.strip()[:120] for x in data.get("checklist", []) if x and x.strip()]
        with self.db.session() as s:
            row = s.get(SettingValue, SETUP_KEY)
            value = {"shifts": shifts, "checklist": checklist}
            if row is None:
                s.add(SettingValue(key=SETUP_KEY, value=value))
            else:
                row.value = value
        return self.setup()

    def _plan_for(self, number: int) -> int:
        return int(self.setup()["shifts"].get(str(number), {}).get("plan") or self.plant.targets.shift_plan)

    def current(self, snap: dict) -> dict:
        if not snap.get("ready") or not snap.get("working"):
            return {"working": False, "session": None, "previous": self.last_closed()}
        sh = snap["shift"]
        day = sh["start"].date()
        with self.db.session() as s:
            row = s.scalar(select(ShiftSession).where(ShiftSession.day == day, ShiftSession.shift == sh["number"]))
            sess = _out(row)
        return {
            "working": True,
            "day": day,
            "number": sh["number"],
            "start": sh["start"],
            "end": sh["end"],
            "plan": sess["plan"] if sess else self._plan_for(sh["number"]),
            "session": sess,
            "previous": self.last_closed(),
        }

    def start(
        self,
        snap: dict,
        supervisor: str,
        staff: int | None,
        note: str,
        at: datetime,
        *,
        plan: int | None = None,
        staff_by_area: dict[str, int] | None = None,
        checklist: list[str] | None = None,
    ) -> dict:
        if staff_by_area:
            codes = {a.code for a in self.plant.areas}
            staff_by_area = {k: max(0, min(int(v), 500)) for k, v in staff_by_area.items() if k in codes}
            staff = sum(staff_by_area.values()) or staff
        setup = self.setup()
        items = setup["checklist"]
        done = [x for x in (checklist or []) if x in items]
        start_info = {
            "staff_by_area": staff_by_area or {},
            "checklist": done,
            "missing": [x for x in items if x not in done] if checklist is not None else [],
        }
        cur = self.current(snap)
        if not cur["working"]:
            raise ValidationFailed("Сейчас нерабочее время — смену принять нельзя")
        if cur["session"] and not cur["session"]["closed_at"]:
            raise ValidationFailed(f"Смену уже принял {cur['session']['supervisor']}")
        with self.db.session() as s:
            row = s.scalar(
                select(ShiftSession).where(ShiftSession.day == cur["day"], ShiftSession.shift == cur["number"])
            )
            if row is None:
                row = ShiftSession(
                    day=cur["day"],
                    shift=cur["number"],
                    supervisor=supervisor,
                    started_at=at,
                    plan=plan or cur["plan"],
                    staff=staff,
                    note=note,
                    summary={"start": start_info},
                )
                s.add(row)
            else:
                row.supervisor, row.started_at, row.closed_at, row.staff, row.note = supervisor, at, None, staff, note
                row.plan = plan or row.plan
                row.summary = {"start": start_info}
            s.flush()
            return _out(row)

    def close(self, snap: dict, note: str, at: datetime, by: str) -> dict:
        cur = self.current(snap)
        sess = cur.get("session")
        if not cur["working"] or not sess or sess["closed_at"]:
            raise ValidationFailed("Нет принятой смены, которую можно сдать")
        summary = self._summary(snap, sess["started_at"], at)
        with self.db.session() as s:
            row = s.get(ShiftSession, sess["id"])
            assert row is not None
            row.closed_at = at
            row.summary = {
                **summary,
                "plan": row.plan,
                "start": (row.summary or {}).get("start"),
                "closed_by": by,
                "readiness": self._compact(self._readiness(s, row)),
            }
            if note:
                row.note = (row.note + "\n" if row.note else "") + f"При сдаче: {note}"
            s.flush()
            return _out(row)

    def on_shift_end(self, d: dict, at: datetime) -> None:
        with self.db.session() as s:
            row = s.scalar(select(ShiftSession).where(ShiftSession.day == d["day"], ShiftSession.shift == d["shift"]))
            if row is None or row.closed_at is not None:
                return
            areas = d.get("areas", {})
            out = sum(a.get("output", 0) for k, a in areas.items() if k != "QC")
            defects = sum(a.get("defects", 0) for a in areas.values())
            row.closed_at = at
            row.summary = {
                "start": (row.summary or {}).get("start"),
                "finished": d.get("finished", 0),
                "plan": row.plan,
                "defect_pct": round(defects / out * 100, 2) if out else 0.0,
                "rework": d.get("rework", 0),
                "down_min": round(sum(a.get("down_s", 0) for a in areas.values()) / 60),
                "closed_by": "по графику",
                "readiness": self._compact(self._readiness(s, row)),
            }

    def _expected(self, s, row: ShiftSession) -> list[User]:
        start = (row.summary or {}).get("start") or {}
        by_area = {k for k, v in (start.get("staff_by_area") or {}).items() if v}
        users = list(
            s.scalars(
                select(User)
                .where(
                    User.active.is_(True),
                    User.role == "worker",
                    or_(User.status.is_(None), User.status == "active"),
                )
                .order_by(User.name)
            )
        )
        if by_area:
            users = [u for u in users if u.area is None or u.area in by_area]
        return users

    def _readiness(self, s, row: ShiftSession) -> dict:
        marks = {r.user_id: r for r in s.scalars(select(ShiftReady).where(ShiftReady.shift_id == row.id))}
        names = {a.code: a.name for a in self.plant.areas}
        people = []
        for u in self._expected(s, row):
            m = marks.pop(u.id, None)
            people.append(
                {
                    "user_id": u.id,
                    "name": u.name,
                    "position": u.position,
                    "area": u.area,
                    "area_name": names.get(u.area or "", ""),
                    "status": m.status if m else "pending",
                    "note": m.note if m else "",
                    "at": m.at if m else None,
                }
            )
        for m in marks.values():
            people.append(
                {
                    "user_id": m.user_id,
                    "name": m.name,
                    "position": "",
                    "area": m.area,
                    "area_name": names.get(m.area or "", ""),
                    "status": m.status,
                    "note": m.note,
                    "at": m.at,
                }
            )
        count = {k: sum(1 for p in people if p["status"] == k) for k in ("ready", "absent", "pending")}
        return {
            "shift_id": row.id,
            "shift": row.shift,
            "day": row.day,
            "started_at": row.started_at,
            "closed_at": row.closed_at,
            "supervisor": row.supervisor,
            "total": len(people),
            **count,
            "people": people,
        }

    @staticmethod
    def _compact(r: dict) -> dict:
        return {
            "total": r["total"],
            "ready": r["ready"],
            "absent": r["absent"],
            "pending": r["pending"],
            "absent_people": [{"name": p["name"], "note": p["note"]} for p in r["people"] if p["status"] == "absent"],
            "pending_people": [p["name"] for p in r["people"] if p["status"] == "pending"],
        }

    def _open_row(self, s, snap: dict) -> ShiftSession | None:
        cur = self.current(snap)
        sess = cur.get("session")
        if not cur["working"] or not sess or sess["closed_at"]:
            return None
        return s.get(ShiftSession, sess["id"])

    def readiness(self, snap: dict, user_id: int | None = None) -> dict:
        with self.db.session() as s:
            row = self._open_row(s, snap)
            if row is None:
                return {"shift_id": None, "total": 0, "ready": 0, "absent": 0, "pending": 0, "people": [], "mine": None}
            out = self._readiness(s, row)
        mine = next((p for p in out["people"] if p["user_id"] == user_id), None) if user_id is not None else None
        return {**out, "mine": mine}

    def mark_ready(self, snap: dict, user_id: int, status: str, note: str, at: datetime) -> dict:
        with self.db.session() as s:
            row = self._open_row(s, snap)
            if row is None:
                raise ValidationFailed("Смена ещё не принята — подтверждать пока нечего")
            u = s.get(User, user_id)
            if u is None:
                raise ValidationFailed("Сотрудник не найден")
            note = note.strip()[:200]
            if status == "absent" and not note:
                raise ValidationFailed("Напишите коротко, почему не можете выйти")
            mark = s.scalar(select(ShiftReady).where(ShiftReady.shift_id == row.id, ShiftReady.user_id == user_id))
            if mark is None:
                mark = ShiftReady(shift_id=row.id, user_id=user_id, name=u.name, area=u.area, status=status)
                s.add(mark)
            mark.status, mark.note, mark.at, mark.name, mark.area = status, note, at, u.name, u.area
            s.flush()
            out = self._readiness(s, row)
        mine = next((p for p in out["people"] if p["user_id"] == user_id), None)
        return {**out, "mine": mine}

    def _summary(self, snap: dict, since: datetime, until: datetime) -> dict:
        k = snap.get("kpi", {})
        with self.db.session() as s:
            n = s.scalar(
                select(func.count(Incident.id)).where(Incident.created_at >= since, Incident.created_at <= until)
            )
            worker = s.scalar(
                select(func.count(Incident.id)).where(
                    Incident.created_at >= since, Incident.created_at <= until, Incident.source == "worker"
                )
            )
            cost = s.scalar(
                select(func.coalesce(func.sum(Incident.cost_kzt), 0)).where(
                    Incident.created_at >= since, Incident.created_at <= until
                )
            )
        down = sum(a.get("time", {}).get("down", 0) for a in snap.get("areas", []))
        return {
            "finished": k.get("finished", 0),
            "plan": k.get("shift_plan", self.plant.targets.shift_plan),
            "plan_to_now": k.get("plan_to_now"),
            "defect_pct": k.get("defect_pct", 0),
            "rework": k.get("rework", 0),
            "down_min": down,
            "incidents": n or 0,
            "reports": worker or 0,
            "cost_kzt": int(cost or 0),
        }

    def last_closed(self) -> dict | None:
        with self.db.session() as s:
            row = s.scalar(
                select(ShiftSession)
                .where(ShiftSession.closed_at.is_not(None))
                .order_by(ShiftSession.day.desc(), ShiftSession.shift.desc())
                .limit(1)
            )
            return _out(row)

    def history(self, limit: int = 30) -> list[dict]:
        with self.db.session() as s:
            rows = s.scalars(
                select(ShiftSession).order_by(ShiftSession.day.desc(), ShiftSession.shift.desc()).limit(limit)
            )
            return [_out(r) for r in rows]
