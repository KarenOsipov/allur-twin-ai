from __future__ import annotations

import asyncio
import copy
import secrets
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from app.assistant.engine import Assistant
from app.core.errors import NotFoundError, ValidationFailed
from app.db.models import DowntimeRecord, ModelOutput, ProductionRecord, QualityRecord
from app.domain.plant import Plant
from app.services.analytics_service import AnalyticsService
from app.services.data_service import DataService, Dataset
from app.services.settings_service import SettingsService
from app.sim.live import LiveFloor
from app.sim.sandbox import SimAction, run_sandbox

TTL = timedelta(hours=2)
MAX_SANDBOXES = 8


@dataclass
class Sandbox:
    id: str
    owner: str
    created: datetime
    horizon: str
    result: dict
    analytics: AnalyticsService | None = None
    assistant: Assistant | None = None
    _overlay: tuple[object, Dataset] | None = field(default=None, repr=False)

    @property
    def summary(self) -> dict:
        return self.result["summary"]


class _OverlaySource:
    def __init__(self, sandbox: Sandbox, data: DataService, plant: Plant) -> None:
        self.sb = sandbox
        self.data = data
        self.plant = plant

    def dataset(self) -> Dataset:
        base = self.data.dataset()
        cached = self.sb._overlay
        if cached and cached[0] == base.version:
            return cached[1]
        ds = build_overlay(base, self.sb.result, self.plant, f"sb:{self.sb.id}:{base.version}")
        self.sb._overlay = (base.version, ds)
        return ds


class _FinalFloor:
    def __init__(self, result: dict) -> None:
        self.result = result

    def snapshot(self) -> dict:
        return self.result["final"] or {"ready": False}


def build_overlay(base: Dataset, result: dict, plant: Plant, version: str) -> Dataset:
    shifts = result["shifts"]
    lines = plant.lines
    keys = {(s["day"], s["shift"], a.code) for s in shifts for a in lines}
    production = [r for r in base.production if (r.day, r.shift, r.area) not in keys]
    quality = [r for r in base.quality if (r.day, r.shift, r.area) not in keys]
    added_models: dict[tuple[date, str], int] = {}
    for s in shifts:
        for a in lines:
            x = s["areas"][a.code]
            run_h = min(round((x["run_s"] + x["starved_s"] + x["blocked_s"]) / 3600, 1), 8.0)
            production.append(
                ProductionRecord(
                    day=s["day"],
                    shift=s["shift"],
                    area=a.code,
                    line=a.line,
                    plan=plant.targets.shift_plan,
                    fact=x["output"],
                    run_hours=run_h,
                    load_pct=round(run_h / 8 * 100),
                    source="sim",
                )
            )
            quality.append(
                QualityRecord(
                    day=s["day"],
                    shift=s["shift"],
                    area=a.code,
                    produced=x["output"],
                    defects=x["defects"],
                    source="sim",
                )
            )
        for model, qty in s["models"].items():
            added_models[(s["day"], model)] = added_models.get((s["day"], model), 0) + qty

    model_output = []
    for r in base.model_output:
        extra = added_models.pop((r.day, r.model), 0)
        model_output.append(ModelOutput(day=r.day, model=r.model, qty=r.qty + extra, source=r.source) if extra else r)
    model_output += [ModelOutput(day=d, model=m, qty=q, source="sim") for (d, m), q in added_models.items()]

    downtime = list(base.downtime)
    for d in result["downtime"]:
        started = d.get("started_at")
        downtime.append(
            DowntimeRecord(
                day=d["day"],
                shift=_shift_of(plant, started),
                area=d["area"],
                equipment=d["equipment"],
                reason=d["reason"] or "Отказ",
                minutes=d["minutes"],
                planned=bool(d["planned"]),
                started_at=started,
                source="sim",
            )
        )
    return Dataset(
        production=sorted(production, key=lambda r: r.day),
        quality=sorted(quality, key=lambda r: r.day),
        downtime=sorted(downtime, key=lambda r: r.day),
        model_output=sorted(model_output, key=lambda r: r.day),
        model_plan=base.model_plan,
        version=version,
    )


def _shift_of(plant: Plant, t: datetime | None) -> int:
    if t is None:
        return 1
    for sh in plant.shifts:
        if sh.start <= t.time() and (sh.end <= sh.start or t.time() < sh.end):
            return sh.number
    return plant.shifts[-1].number


class SandboxService:
    def __init__(
        self,
        plant: Plant,
        live: LiveFloor,
        data: DataService,
        analytics: AnalyticsService,
        assistant: Assistant,
        economics: SettingsService,
    ) -> None:
        self.plant = plant
        self.live = live
        self.data = data
        self.analytics = analytics
        self.assistant = assistant
        self.economics = economics
        self._items: dict[str, Sandbox] = {}
        self._lock = threading.Lock()
        self._running: set[str] = set()

    async def create(self, owner: str, actions: list[SimAction], horizon: str) -> Sandbox:
        self._validate(actions)
        fork = self.live.snapshot_copy()
        if fork is None or not fork.working or fork.shift_end is None:
            raise ValidationFailed("Сейчас нерабочее время — симуляция запускается во время смены")
        if owner in self._running:
            raise ValidationFailed("Симуляция уже считается — подождите пару секунд")
        end = fork.shift_end
        if horizon == "day":
            probe = copy.copy(fork)
            while True:
                number, _, nxt_end = probe._shift_window(end)
                if number is None or nxt_end is None:
                    break
                end = nxt_end
        econ = self.economics.economics()
        self._running.add(owner)
        try:
            result = await asyncio.to_thread(
                run_sandbox,
                fork,
                self.plant,
                actions,
                end,
                margin_per_car=econ["margin_per_car_kzt"],
                rework_cost=econ["rework_cost_kzt"],
            )
        finally:
            self._running.discard(owner)
        sb = Sandbox(
            id=secrets.token_urlsafe(9),
            owner=owner,
            created=datetime.now(),
            horizon=horizon,
            result=result,
        )
        source = _OverlaySource(sb, self.data, self.plant)
        sb.analytics = self.analytics.scoped(source, live_output_fn=lambda: 0)
        sb.assistant = self.assistant.scoped(sb.analytics, _FinalFloor(result), sandbox=result)
        with self._lock:
            self._purge()
            for k, v in list(self._items.items()):
                if v.owner == owner:
                    del self._items[k]
            self._items[sb.id] = sb
        return sb

    def _validate(self, actions: list[SimAction]) -> None:
        eq_codes = {e.code for e in self.plant.equipment}
        areas = {a.code for a in self.plant.process_areas}
        for a in actions:
            if a.kind == "failure" and a.equipment not in eq_codes:
                raise ValidationFailed(f"Оборудование «{a.equipment}» не найдено")
            if a.kind in ("defects", "slowdown"):
                if a.area not in areas:
                    raise ValidationFailed("Выберите участок")
                if a.value is None:
                    raise ValidationFailed("Укажите, на сколько процентов")
            if a.kind == "defects" and not 0 <= (a.value or 0) <= 40:
                raise ValidationFailed("Брак — от 0 до 40%")
            if a.kind == "slowdown" and not 1 <= (a.value or 0) <= 100:
                raise ValidationFailed("Замедление — от 1 до 100%")

    def get(self, sandbox_id: str, owner: str) -> Sandbox:
        with self._lock:
            self._purge()
            sb = self._items.get(sandbox_id)
        if sb is None or sb.owner != owner:
            raise NotFoundError("Симуляция не найдена или устарела — запустите её заново")
        return sb

    def delete(self, sandbox_id: str, owner: str) -> None:
        with self._lock:
            sb = self._items.get(sandbox_id)
            if sb and sb.owner == owner:
                del self._items[sandbox_id]

    def _purge(self) -> None:
        now = datetime.now()
        for k, v in list(self._items.items()):
            if now - v.created > TTL:
                del self._items[k]
        while len(self._items) > MAX_SANDBOXES:
            oldest = min(self._items.values(), key=lambda x: x.created)
            del self._items[oldest.id]

    @staticmethod
    def public(sb: Sandbox) -> dict:
        r = sb.result
        return {
            "id": sb.id,
            "horizon": sb.horizon,
            "start": r["start"],
            "end": r["end"],
            "frame_every_s": r["frame_every_s"],
            "frames": r["frames"],
            "log": r["log"],
            "series": r["series"],
            "summary": r["summary"],
            "actions": r["actions"],
        }

    def incidents(self, sb: Sandbox, status: str | None, severity: str | None) -> dict:
        margin = self.economics.margin()
        opened: dict[str, dict] = {}
        items: list[dict] = []
        n = 0
        for e in sb.result["log"]:
            if e["kind"] in ("down", "already_down"):
                n += 1
                inc = {
                    "id": -n,
                    "created_at": e["t"],
                    "kind": "equipment",
                    "severity": e.get("severity", "warning"),
                    "area": e["area"],
                    "equipment": e.get("equipment"),
                    "title": e["title"],
                    "details": "Введено вами в симуляции" if e.get("user") else "Случайный отказ в симуляции",
                    "status": "open",
                    "acked_by": None,
                    "resolved_at": None,
                    "downtime_min": None,
                    "cost_kzt": None,
                    "simulated": True,
                }
                opened[e.get("equipment") or f"#{n}"] = inc
                items.append(inc)
            elif e["kind"] == "up" and e.get("equipment") in opened:
                inc = opened.pop(e["equipment"])
                inc["status"] = "resolved"
                inc["resolved_at"] = e["t"]
                minutes = (e["t"] - inc["created_at"]).total_seconds() / 60
                inc["downtime_min"] = round(minutes, 1)
                if inc["severity"] == "critical":
                    inc["cost_kzt"] = round(minutes * 60 / self.plant.takt_s * margin)
        if status == "active":
            items = [i for i in items if i["status"] != "resolved"]
        elif status:
            items = [i for i in items if i["status"] == status]
        if severity:
            items = [i for i in items if i["severity"] == severity]
        items.sort(key=lambda i: i["created_at"], reverse=True)
        return {
            "items": items,
            "total": len(items),
            "active": sum(1 for i in items if i["status"] != "resolved"),
            "cost_kzt": sum(i["cost_kzt"] or 0 for i in items),
            "simulated": True,
        }
