from __future__ import annotations

import asyncio
import contextlib
import copy
import logging
from datetime import datetime

from app.analytics.economy import DEFAULTS as ECONOMY_DEFAULTS
from app.core.clock import plant_now
from app.core.events import EventBus
from app.domain.plant import Plant
from app.services.incident_service import IncidentService
from app.sim.engine import AreaState, LineSim, SimConfig
from app.sim.snapshot import floor_snapshot

DOWNTIME_SHARE = ECONOMY_DEFAULTS["downtime_line_share"]
log = logging.getLogger(__name__)

TICK_S = 0.2
SNAPSHOT_EVERY = 0.5
MAX_SUBSTEP = 5.0
SPEEDS = (1, 5, 20, 60, 120)


class LiveFloor:
    def __init__(
        self,
        plant: Plant,
        events: EventBus,
        incidents: IncidentService,
        on_shift_end,
        on_downtime,
        tz_offset_min: int,
        speed: float,
        seed: int | None = None,
    ) -> None:
        self.plant = plant
        self.events = events
        self.incidents = incidents
        self.on_shift_end = on_shift_end
        self.on_downtime = on_downtime
        self.tz_offset_min = tz_offset_min
        self.speed = speed
        self.paused = False
        self.seed = seed
        self.sim: LineSim | None = None
        self._task: asyncio.Task | None = None
        self._open_incidents: dict[str, int] = {}
        self._claimed: dict[str, int] = {}
        self._calibrated: dict[str, float] = {}
        self._defect_override: dict[str, float] = {}
        self._quality_flagged: set[tuple[int | None, str]] = set()
        self._recent: list[dict] = []
        self.config = SimConfig(hazard_scale=2.5)

    def calibrate(self, defect_pct: dict[str, float]) -> None:
        self._calibrated = dict(defect_pct)
        self._apply_defects()

    def _apply_defects(self) -> None:
        merged = {**self._calibrated, **self._defect_override}
        self.config.defect_rate = {k: v / 100 for k, v in merged.items()}
        if self.sim is not None:
            self.sim.cfg.defect_rate = dict(self.config.defect_rate)

    def apply_params(self, ov) -> None:
        cfg = self.config
        cfg.cycle_factor = dict(ov.cycle_factor)
        cfg.buffer_override = dict(ov.buffer_override)
        cfg.mtbf_h = dict(ov.mtbf_h)
        cfg.mttr_factor = dict(ov.mttr_factor)
        cfg.kit_delivery_every_min = ov.kit_every_min
        cfg.kit_delivery_size = ov.kit_size
        self._defect_override = dict(ov.defect_pct)
        self._apply_defects()
        sim = self.sim
        if sim is None:
            return
        for name in ("cycle_factor", "buffer_override", "mtbf_h", "mttr_factor"):
            setattr(sim.cfg, name, dict(getattr(cfg, name)))
        sim.cfg.kit_delivery_every_min = cfg.kit_delivery_every_min
        sim.cfg.kit_delivery_size = cfg.kit_delivery_size
        for code, a in sim.areas.items():
            a.cycle_s = self.plant.area(code).cycle_s * cfg.cycle_factor.get(code, 1.0)
            sim.buffer_cap[code] = cfg.buffer_override.get(code, self.plant.area(code).buffer_after)

    def start(self) -> None:
        now = plant_now(self.tz_offset_min)
        day_start = datetime.combine(now.date(), self.plant.shifts[0].start)
        if now.weekday() in self.plant.workdays and now >= day_start:
            self.sim = LineSim(self.plant, day_start, self.config, seed=self.seed)
            while self.sim.clock < now:
                self.sim.step(MAX_SUBSTEP)
            self._handle_events()
        else:
            probe = LineSim(self.plant, now, self.config, seed=self.seed)
            self.sim = LineSim(self.plant, probe.next_shift_start(now), self.config, seed=self.seed)
        self._task = asyncio.create_task(self._run(), name="live-floor")
        log.info("Живой цех запущен: %s, скорость ×%s", self.sim.clock.strftime("%d.%m %H:%M"), self.speed)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        last = loop.time()
        last_snapshot = 0.0
        while True:
            await asyncio.sleep(TICK_S)
            now = loop.time()
            real_dt, last = now - last, now
            if self.sim is None:
                continue
            try:
                if not self.paused:
                    remaining = min(real_dt, 1.0) * self.speed
                    while remaining > 0:
                        step = min(MAX_SUBSTEP, remaining)
                        self.sim.step(step)
                        remaining -= step
                        if not self.sim.working:
                            self.sim.clock = self.sim.next_shift_start(self.sim.clock)
                            self.sim.step(0.001)
                            break
                    self._handle_events()
                if now - last_snapshot >= SNAPSHOT_EVERY:
                    last_snapshot = now
                    self.events.publish("floor", self.snapshot())
            except Exception:
                log.exception("Ошибка шага живого цеха")

    def _handle_events(self) -> None:
        sim = self.sim
        assert sim is not None
        for e in sim.drain_events():
            d = e.data
            if e.kind == "equipment_down":
                eq = self.plant.eq(d["equipment"])
                claimed = self._claimed.pop(eq.code, None)
                if claimed is not None:
                    self._open_incidents[eq.code] = claimed
                    continue
                sev = "info" if d["planned"] else ("critical" if eq.critical else "warning")
                effect = "участок остановлен" if eq.critical else f"участок замедлен на {round(eq.slowdown * 100)}%"
                inc = self.incidents.create(
                    at=e.at,
                    kind="equipment",
                    severity=sev,
                    area=eq.area,
                    equipment=eq.code,
                    title=f"{eq.code}: {d['reason'].lower()}",
                    details=f"{eq.name} — {effect}. Ожидаемое восстановление ~{d['expected_min']} мин.",
                )
                self._open_incidents[eq.code] = inc["id"]
            elif e.kind == "equipment_up":
                inc_id = self._open_incidents.pop(d["equipment"], None)
                eq = self.plant.eq(d["equipment"])
                share = DOWNTIME_SHARE if eq.critical else eq.slowdown / (1 + eq.slowdown)
                lost = 0.0 if d.get("planned") else d["minutes"] * 60 / self.plant.takt_s * share
                if inc_id:
                    self.incidents.resolve_auto(inc_id, e.at, d["minutes"], lost)
                if sim.shift_number:
                    self.on_downtime(
                        sim.shift_start.date(),
                        sim.shift_number,
                        {**d, "minutes": round(d["minutes"], 1)},
                    )
            elif e.kind == "supply_delay":
                claimed = self._claimed.pop("__supply__", None)
                if claimed is not None:
                    self._open_incidents["__supply__"] = claimed
                    continue
                inc = self.incidents.create(
                    at=e.at,
                    kind="supply",
                    severity="warning",
                    area="WH_IN",
                    equipment=None,
                    title="Задержка поставки комплектов",
                    details=f"Следующая поставка задерживается на {d['minutes']} мин. "
                    f"Комплектов на складе: {sim.kits}. Сварка остановится, когда они закончатся.",
                )
                self._open_incidents["__supply__"] = inc["id"]
            elif e.kind == "supply_restored":
                inc_id = self._open_incidents.pop("__supply__", None)
                if inc_id:
                    self.incidents.resolve_auto(inc_id, e.at, None, None)
            elif e.kind == "body_done":
                self._recent = ([{"vin": d["vin"], "model": d["model"], "at": e.at}] + self._recent)[:8]
            elif e.kind == "shift_end":
                self.on_shift_end(d)
                self._quality_flagged = {k for k in self._quality_flagged if k[0] != d["shift"]}
                self.incidents.resolve_kind("quality", e.at)
                plan = self.plant.targets.shift_plan
                if d["finished"] < plan * 0.95:
                    self.incidents.create(
                        at=e.at,
                        kind="kpi",
                        severity="warning",
                        area="ASSY",
                        equipment=None,
                        title=f"Смена {d['shift']}: выпущено {d['finished']} из {plan}",
                        details="Смена не выполнила план. Разбор причин — в разделе «Показатели».",
                    )
                self.events.publish(
                    "shift.closed",
                    {"day": d["day"], "shift": d["shift"], "finished": d["finished"]},
                )
        self._check_quality()

    def _check_quality(self) -> None:
        sim = self.sim
        assert sim is not None
        limit = self.plant.targets.defect_pct
        for code, a in sim.areas.items():
            key = (sim.shift_number, code)
            if a.output < 40 or a.defects < 3 or key in self._quality_flagged:
                continue
            pct = a.defects / a.output * 100
            if pct > limit * 1.5:
                self._quality_flagged.add(key)
                area = self.plant.area(code)
                self.incidents.create(
                    at=sim.clock,
                    kind="quality",
                    severity="warning",
                    area=code,
                    equipment=None,
                    title=f"{area.name}: брак {pct:.1f}% в текущей смене".replace(".", ","),
                    details=f"{a.defects} из {a.output} кузовов. Норма — не более {limit:.0f}%.",
                )

    def set_speed(self, speed: float) -> None:
        self.speed = max(0.5, min(speed, 300))

    def set_paused(self, paused: bool) -> None:
        self.paused = paused

    def fail(self, equipment: str, minutes: float, reason: str | None, incident_id: int | None = None) -> bool:
        assert self.sim is not None
        self.plant.eq(equipment)
        eq = self.sim.equipment[equipment]
        if eq.status.value in ("down", "maint"):
            if incident_id is not None and equipment not in self._open_incidents:
                self._open_incidents[equipment] = incident_id
            return False
        if incident_id is not None:
            self._claimed[equipment] = incident_id
        self.sim.fail(equipment, minutes, reason)
        return True

    def claim_supply(self, incident_id: int) -> None:
        self._claimed["__supply__"] = incident_id

    def is_down(self, equipment: str) -> bool:
        if not self.sim or equipment not in self.sim.equipment:
            return False
        return self.sim.equipment[equipment].status.value in ("down", "maint")

    def incident_of(self, equipment: str) -> int | None:
        return self._open_incidents.get(equipment)

    def repair(self, equipment: str) -> None:
        assert self.sim is not None
        self.sim.repair(equipment)

    def delay_supply(self, minutes: float) -> None:
        assert self.sim is not None
        self.sim.kits = min(self.sim.kits, 3)
        self.sim.delay_supply(minutes)

    def snapshot(self) -> dict:
        if self.sim is None:
            return {"ready": False}
        return floor_snapshot(self.sim, self.plant, speed=self.speed, paused=self.paused, recent=self._recent)

    def snapshot_copy(self) -> LineSim | None:
        return copy.deepcopy(self.sim) if self.sim else None

    @property
    def clock(self) -> datetime:
        return self.sim.clock if self.sim else plant_now(self.tz_offset_min)

    def today_output(self) -> int:
        return len(self.sim.finished) if self.sim and self.sim.working else 0

    def state_of(self, area: str) -> AreaState | None:
        if not self.sim or area not in self.sim.areas:
            return None
        return self.sim.areas[area].state
