from __future__ import annotations

import math
import random
from collections import deque
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from enum import StrEnum

from app.domain.plant import AreaKind, Equipment, FailureMode, Plant


class AreaState(StrEnum):
    RUN = "run"
    STARVED = "starved"
    BLOCKED = "blocked"
    DOWN = "down"
    OFF = "off"


class EqStatus(StrEnum):
    RUN = "run"
    IDLE = "idle"
    DOWN = "down"
    MAINT = "maint"
    OFF = "off"


@dataclass
class Body:
    vin: str
    model: str
    color: str
    hex: str
    started: datetime
    defect_area: str | None = None


@dataclass
class EqRuntime:
    spec: Equipment
    status: EqStatus = EqStatus.RUN
    reason: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    run_s_since_repair: float = 0.0
    hazard_left: float = 1.0
    planned: bool = False
    forced: bool = False


@dataclass
class AreaRuntime:
    code: str
    cycle_s: float
    current: Body | None = None
    progress_s: float = 0.0
    target_s: float = 0.0
    state: AreaState = AreaState.STARVED
    output: int = 0
    defects: int = 0
    run_s: float = 0.0
    down_s: float = 0.0
    starved_s: float = 0.0
    blocked_s: float = 0.0


@dataclass
class SimEvent:
    kind: str
    at: datetime
    data: dict = field(default_factory=dict)


@dataclass
class ScheduledStop:
    equipment: str
    at_min: float
    minutes: float
    reason: str = "Сценарий"
    shift: int = 1


@dataclass
class SimConfig:
    hazard_scale: float = 1.0
    random_failures: bool = True
    cycle_factor: dict[str, float] = field(default_factory=dict)
    buffer_override: dict[str, int] = field(default_factory=dict)
    defect_rate: dict[str, float] = field(default_factory=dict)
    stops: list[ScheduledStop] = field(default_factory=list)
    supply_delay: tuple[float, float] | None = None
    overtime_min: float = 0.0
    kit_delivery_every_min: float = 60.0
    kit_delivery_size: int = 34
    mtbf_h: dict[str, float] = field(default_factory=dict)
    mttr_factor: dict[str, float] = field(default_factory=dict)


BASE_DEFECT = {"WELD": 0.017, "PAINT": 0.035, "ASSY": 0.011, "QC": 0.0}
WEAR_EQUIPMENT = {"Конвейер-03": 3.0}


class LineSim:
    def __init__(
        self,
        plant: Plant,
        start: datetime,
        config: SimConfig | None = None,
        seed: int | None = None,
    ) -> None:
        self.plant = plant
        self.cfg = config or SimConfig()
        self._seed_base = seed if seed is not None else random.getrandbits(48)
        self.rng = random.Random(seed)
        self._streams: dict[str, random.Random] = {}
        self.clock = start
        self.serial = self.rng.randint(10_000, 90_000)
        self.events: list[SimEvent] = []

        self.order = [a for a in plant.areas if a.kind != AreaKind.STORE]
        self.areas: dict[str, AreaRuntime] = {
            a.code: AreaRuntime(a.code, a.cycle_s * self.cfg.cycle_factor.get(a.code, 1.0)) for a in self.order
        }
        self.buffers: dict[str, deque[Body]] = {a.code: deque() for a in self.order}
        self.buffer_cap = {a.code: self.cfg.buffer_override.get(a.code, a.buffer_after) for a in self.order}
        self.equipment: dict[str, EqRuntime] = {e.code: EqRuntime(e) for e in plant.equipment}
        for eq in self.equipment.values():
            eq.run_s_since_repair = self.rng.uniform(0, 40) * 3600 if eq.spec.code in WEAR_EQUIPMENT else 0.0
            eq.hazard_left = self._stream("fail:" + eq.spec.code).expovariate(1.0)
        self.kits = 30
        self.kits_delayed_until: datetime | None = None
        self.next_delivery = start + timedelta(minutes=self.cfg.kit_delivery_every_min)
        self.finished: list[Body] = []
        self.rework = 0
        self.model_counts: dict[str, int] = {m.name: 0 for m in plant.models}
        self._mix_credit = {m.name: 0.0 for m in plant.models}
        self._stops_done: set[int] = set()
        self.shift_number, self.shift_start, self.shift_end = self._shift_window(start)
        self._prefill()

    def _stream(self, key: str) -> random.Random:
        r = self._streams.get(key)
        if r is None:
            r = random.Random(f"{self._seed_base}:{key}")
            self._streams[key] = r
        return r

    def reseed(self, seed: int) -> None:
        self._seed_base = seed
        self.rng = random.Random(seed)
        self._streams = {}
        for eq in self.equipment.values():
            if eq.status not in (EqStatus.DOWN, EqStatus.MAINT):
                eq.hazard_left = self._stream("fail:" + eq.spec.code).expovariate(1.0)

    def mtbf(self, code: str) -> float:
        return self.cfg.mtbf_h.get(code) or self.equipment[code].spec.mtbf_h

    def _shift_window(self, t: datetime) -> tuple[int | None, datetime | None, datetime | None]:
        for sh in self.plant.shifts:
            for d in (t.date(), t.date() - timedelta(days=1)):
                start = datetime.combine(d, sh.start)
                end = datetime.combine(d, sh.end)
                if end <= start:
                    end += timedelta(days=1)
                if sh.number == len(self.plant.shifts):
                    end += timedelta(minutes=self.cfg.overtime_min)
                if start <= t < end and start.weekday() in self.plant.workdays:
                    return sh.number, start, end
        return None, None, None

    def next_shift_start(self, t: datetime) -> datetime:
        d: date = t.date()
        for _ in range(8):
            for sh in self.plant.shifts:
                start = datetime.combine(d, sh.start)
                if start > t and d.weekday() in self.plant.workdays:
                    return start
            d += timedelta(days=1)
        return t + timedelta(hours=8)

    @property
    def working(self) -> bool:
        return self.shift_number is not None

    def _prefill(self) -> None:
        fill = {"WELD": 3, "PAINT": 5, "ASSY": 2}
        for code, n in fill.items():
            for _ in range(n):
                self.buffers[code].append(self._new_body())
        for code in ("WELD", "PAINT", "ASSY"):
            a = self.areas[code]
            a.current = self._new_body()
            a.target_s = self._cycle_for(a)
            a.progress_s = self.rng.uniform(0, a.target_s * 0.9)

    def _pick_model(self):
        total = sum(m.month_plan for m in self.plant.models)
        for m in self.plant.models:
            self._mix_credit[m.name] += m.month_plan / total
        name = max(
            self._mix_credit,
            key=lambda k: self._mix_credit[k] + self.rng.uniform(0, 0.3),
        )
        self._mix_credit[name] -= 1
        return next(m for m in self.plant.models if m.name == name)

    def _new_body(self) -> Body:
        model = self._pick_model()
        names, hexes, weights = zip(*[(c[0], c[1], c[2]) for c in model.colors], strict=True)
        i = self.rng.choices(range(len(names)), weights=weights)[0]
        self.serial += 1
        vin = f"XWB{model.code[:2]}{self.serial:06d}"
        return Body(vin, model.name, names[i], hexes[i], self.clock)

    def _cycle_for(self, a: AreaRuntime) -> float:
        r = self._stream("cycle:" + a.code)
        cycle = a.cycle_s * r.lognormvariate(0, 0.06)
        if r.random() < 0.035:
            cycle += r.uniform(60, 240)
        return cycle

    def _critical_down(self, area: str) -> EqRuntime | None:
        for eq in self.equipment.values():
            if eq.spec.area == area and eq.spec.critical and eq.status in (EqStatus.DOWN, EqStatus.MAINT):
                return eq
        return None

    def _slowdown(self, area: str) -> float:
        k = 1.0
        for eq in self.equipment.values():
            if eq.spec.area == area and not eq.spec.critical and eq.status == EqStatus.DOWN:
                k *= 1 + eq.spec.slowdown
        return k

    def fail(
        self,
        code: str,
        minutes: float,
        reason: str | None = None,
        planned: bool = False,
        forced: bool = True,
    ) -> None:
        eq = self.equipment[code]
        if eq.status in (EqStatus.DOWN, EqStatus.MAINT):
            return
        mode = self._pick_mode(eq.spec, planned) if reason is None else None
        eq.status = EqStatus.MAINT if planned else EqStatus.DOWN
        eq.reason = reason or (mode.reason if mode else "Отказ")
        eq.since = self.clock
        eq.until = self.clock + timedelta(minutes=minutes)
        eq.planned = planned
        eq.forced = forced
        self.events.append(
            SimEvent(
                "equipment_down",
                self.clock,
                {
                    "equipment": code,
                    "area": eq.spec.area,
                    "reason": eq.reason,
                    "critical": eq.spec.critical,
                    "planned": planned,
                    "expected_min": round(minutes),
                },
            )
        )

    def repair(self, code: str) -> None:
        eq = self.equipment[code]
        if eq.status not in (EqStatus.DOWN, EqStatus.MAINT):
            return
        minutes = (self.clock - eq.since).total_seconds() / 60 if eq.since else 0
        self.events.append(
            SimEvent(
                "equipment_up",
                self.clock,
                {
                    "equipment": code,
                    "area": eq.spec.area,
                    "reason": eq.reason,
                    "minutes": round(minutes, 1),
                    "critical": eq.spec.critical,
                    "planned": eq.planned,
                    "started_at": eq.since,
                },
            )
        )
        if eq.reason and ("цеп" in eq.reason.lower() or "ТО" in eq.reason):
            eq.run_s_since_repair = 0.0
        eq.status, eq.reason, eq.since, eq.until, eq.planned, eq.forced = (
            EqStatus.RUN,
            None,
            None,
            None,
            False,
            False,
        )

    def delay_supply(self, minutes: float) -> None:
        self.kits_delayed_until = self.clock + timedelta(minutes=minutes)
        self.next_delivery = self.kits_delayed_until
        self.events.append(SimEvent("supply_delay", self.clock, {"minutes": round(minutes)}))

    def _pick_mode(self, spec: Equipment, planned: bool) -> FailureMode | None:
        modes = [m for m in spec.modes if m.planned == planned]
        if not modes:
            return None
        weights = [max(m.weight, 0.01) for m in modes]
        return self._stream("mode:" + spec.code).choices(modes, weights=weights)[0]

    def step(self, dt: float) -> None:
        new_clock = self.clock + timedelta(seconds=dt)
        number, start, end = self._shift_window(self.clock)
        if number != self.shift_number:
            if self.shift_number is not None:
                self._close_shift()
            self.shift_number, self.shift_start, self.shift_end = number, start, end
            self._stops_done.clear()
        self.clock = new_clock
        if not self.working:
            for a in self.areas.values():
                a.state = AreaState.OFF
            for eq in self.equipment.values():
                if eq.status == EqStatus.RUN:
                    eq.status = EqStatus.OFF
            return
        for eq in self.equipment.values():
            if eq.status == EqStatus.OFF:
                eq.status = EqStatus.RUN

        minutes_in = (self.clock - self.shift_start).total_seconds() / 60 if self.shift_start else 0
        self._scenario(minutes_in)
        self._equipment(dt)
        self._supply()
        for area in reversed(self.order):
            self._area(area.code, dt)

    def _scenario(self, minutes_in: float) -> None:
        for i, s in enumerate(self.cfg.stops):
            if i in self._stops_done or s.shift != self.shift_number:
                continue
            if minutes_in >= s.at_min:
                self._stops_done.add(i)
                self.fail(s.equipment, s.minutes, s.reason)
        if self.cfg.supply_delay and self.shift_number == 1 and -1 not in self._stops_done:
            at, minutes = self.cfg.supply_delay
            if minutes_in >= at:
                self._stops_done.add(-1)
                self.kits = min(self.kits, 4)
                self.delay_supply(minutes)

    def _equipment(self, dt: float) -> None:
        for eq in self.equipment.values():
            if eq.status in (EqStatus.DOWN, EqStatus.MAINT):
                if eq.until and self.clock >= eq.until:
                    self.repair(eq.spec.code)
                continue
            area = self.areas[eq.spec.area]
            if area.state != AreaState.RUN:
                eq.status = EqStatus.IDLE
                continue
            eq.status = EqStatus.RUN
            eq.run_s_since_repair += dt
            if not self.cfg.random_failures:
                continue
            code = eq.spec.code
            hazard = dt / (self.mtbf(code) * 3600) * self.cfg.hazard_scale
            wear = WEAR_EQUIPMENT.get(code)
            if wear:
                hazard *= 1 + wear * (eq.run_s_since_repair / 3600 / self.mtbf(code)) ** 2
            eq.hazard_left -= hazard
            if eq.hazard_left <= 0:
                r = self._stream("fail:" + code)
                eq.hazard_left = r.expovariate(1.0)
                mode = self._pick_mode(eq.spec, planned=False)
                if mode is None:
                    continue
                mttr = mode.mttr_min * self.cfg.mttr_factor.get(code, 1.0)
                minutes = max(5.0, r.lognormvariate(math.log(mttr), 0.35))
                self.fail(eq.spec.code, minutes, mode.reason, forced=False)

    def _supply(self) -> None:
        if self.kits_delayed_until and self.clock < self.kits_delayed_until:
            return
        if self.kits_delayed_until and self.clock >= self.kits_delayed_until:
            self.kits_delayed_until = None
            self.kits += self.cfg.kit_delivery_size
            self.next_delivery = self.clock + timedelta(minutes=self.cfg.kit_delivery_every_min)
            self.events.append(SimEvent("supply_restored", self.clock, {"kits": self.kits}))
            return
        if self.clock >= self.next_delivery:
            self.kits = min(self.kits + self.cfg.kit_delivery_size, 60)
            self.next_delivery = self.clock + timedelta(minutes=self.cfg.kit_delivery_every_min)

    def _upstream_take(self, index: int) -> Body | None:
        if index == 0:
            if self.kits <= 0:
                return None
            self.kits -= 1
            return self._new_body()
        prev = self.order[index - 1].code
        return self.buffers[prev].popleft() if self.buffers[prev] else None

    def _area(self, code: str, dt: float) -> None:
        a = self.areas[code]
        index = next(i for i, x in enumerate(self.order) if x.code == code)
        if self._critical_down(code):
            a.state = AreaState.DOWN
            a.down_s += dt
            return
        if a.current is None:
            a.current = self._upstream_take(index)
            a.progress_s = 0.0
            a.target_s = self._cycle_for(a)
            if a.current is None:
                a.state = AreaState.STARVED
                a.starved_s += dt
                return
        if a.progress_s >= a.target_s:
            if not self._push(code, a):
                a.state = AreaState.BLOCKED
                a.blocked_s += dt
            return
        a.state = AreaState.RUN
        a.run_s += dt
        a.progress_s += dt / self._slowdown(code)
        if a.progress_s >= a.target_s:
            self._complete(code, a)
            if not self._push(code, a):
                a.state = AreaState.BLOCKED

    def _complete(self, code: str, a: AreaRuntime) -> None:
        body = a.current
        assert body is not None
        a.output += 1
        rate = self.cfg.defect_rate.get(code, BASE_DEFECT.get(code, 0.0))
        if code != "QC" and self._stream("defect:" + code).random() < rate:
            a.defects += 1
            body.defect_area = body.defect_area or code
            self.events.append(
                SimEvent(
                    "defect",
                    self.clock,
                    {"area": code, "vin": body.vin, "model": body.model},
                )
            )

    def _push(self, code: str, a: AreaRuntime) -> bool:
        body = a.current
        if body is None:
            return True
        if code == "QC":
            if body.defect_area:
                self.rework += 1
            self.finished.append(body)
            self.model_counts[body.model] = self.model_counts.get(body.model, 0) + 1
            self.events.append(SimEvent("body_done", self.clock, {"vin": body.vin, "model": body.model}))
        else:
            if len(self.buffers[code]) >= self.buffer_cap[code]:
                return False
            self.buffers[code].append(body)
        a.current = None
        a.progress_s = 0.0
        return True

    def _close_shift(self) -> None:
        summary = self.shift_summary()
        self.events.append(SimEvent("shift_end", self.clock, summary))
        for a in self.areas.values():
            a.output = a.defects = 0
            a.run_s = a.down_s = a.starved_s = a.blocked_s = 0.0
        self.finished = []
        self.rework = 0
        self.model_counts = {m.name: 0 for m in self.plant.models}

    def shift_summary(self) -> dict:
        return {
            "day": self.shift_start.date() if self.shift_start else self.clock.date(),
            "shift": self.shift_number,
            "areas": {
                code: {
                    "output": a.output,
                    "defects": a.defects,
                    "run_s": a.run_s,
                    "down_s": a.down_s,
                    "starved_s": a.starved_s,
                    "blocked_s": a.blocked_s,
                }
                for code, a in self.areas.items()
            },
            "finished": len(self.finished),
            "rework": self.rework,
            "models": dict(self.model_counts),
        }

    def drain_events(self) -> list[SimEvent]:
        ev, self.events = self.events, []
        return ev

    def bottleneck(self) -> str | None:
        if not self.working:
            return None
        best, score = None, -1.0
        for code, a in self.areas.items():
            if code == "QC":
                continue
            active = a.run_s + a.down_s
            total = active + a.starved_s + a.blocked_s
            if total <= 0:
                continue
            share = active / total
            if share > score:
                best, score = code, share
        return best
