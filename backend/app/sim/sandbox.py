from __future__ import annotations

import copy
import statistics
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.domain.plant import Plant
from app.sim.engine import EqStatus, LineSim
from app.sim.snapshot import floor_snapshot

STEP_S = 10.0
SERIES_EVERY_MIN = 10
MAX_FRAMES = 900


@dataclass
class SimAction:
    kind: str
    at_min: float = 0.0
    minutes: float = 30.0
    equipment: str | None = None
    area: str | None = None
    value: float | None = None
    reason: str | None = None

    def title(self, plant: Plant) -> str:
        when = "сейчас" if self.at_min < 1 else f"через {round(self.at_min)} мин"
        dur = _dur(self.minutes)
        if self.kind == "failure":
            eq = plant.eq(self.equipment or "")
            what = f"{eq.code}: {(self.reason or 'поломка').lower()}"
            return f"{what} — {when}, ремонт {dur}"
        if self.kind == "supply_delay":
            return f"Задержка поставки комплектов — {when}, на {dur}"
        name = plant.area(self.area or "").name
        if self.kind == "defects":
            return f"{name}: брак {_pct(self.value)} — {when}, {dur}"
        return f"{name}: цикл медленнее на {_pct(self.value)} — {when}, {dur}"


@dataclass
class _Due:
    at: datetime
    apply: Callable[[LineSim], None]
    log: dict | None = None


@dataclass
class _Run:
    frames: list[dict] = field(default_factory=list)
    log: list[dict] = field(default_factory=list)
    series: list[dict] = field(default_factory=list)
    shifts: list[dict] = field(default_factory=list)
    downtime: list[dict] = field(default_factory=list)
    cars: int = 0
    defects: int = 0
    downtime_min: float = 0.0
    final: dict | None = None


def run_sandbox(
    fork: LineSim,
    plant: Plant,
    actions: list[SimAction],
    end: datetime,
    *,
    margin_per_car: int,
    rework_cost: int,
    runs: int | None = None,
) -> dict:
    t0 = fork.clock
    total_s = max((end - t0).total_seconds(), 60.0)
    frame_every = max(30.0, total_s / MAX_FRAMES)
    runs = runs or (10 if total_s <= 9 * 3600 else 6)

    pairs: list[tuple[_Run, _Run]] = []
    for i in range(runs):
        scen, base = copy.deepcopy(fork), copy.deepcopy(fork)
        if i > 0:
            scen.reseed(7_717 * i)
            base.reseed(7_717 * i)
        for twin in (scen, base):
            twin.cfg = copy.deepcopy(fork.cfg)
            twin.cfg.hazard_scale = 1.0
            twin.events = []
        main = i == 0
        r_scen = _play(scen, plant, _schedule(actions, t0, plant), end, frames=main, frame_every=frame_every)
        r_base = _play(base, plant, [], end, frames=False, frame_every=frame_every)
        pairs.append((r_scen, r_base))

    main_s, main_b = pairs[0]
    lost = [b.cars - s.cars for s, b in pairs]
    extra_defects = [s.defects - b.defects for s, b in pairs]
    lost_mean = statistics.mean(lost)
    defects_mean = statistics.mean(extra_defects)
    money = round(max(lost_mean, 0) * margin_per_car + max(defects_mean, 0) * rework_cost)
    plan = _plan_in_window(fork, plant, end)
    summary = {
        "cars": {"scenario": main_s.cars, "baseline": main_b.cars, "lost": main_b.cars - main_s.cars},
        "mean": {
            "scenario": round(statistics.mean(s.cars for s, _ in pairs), 1),
            "baseline": round(statistics.mean(b.cars for _, b in pairs), 1),
            "lost": round(lost_mean, 1),
            "lost_low": min(lost),
            "lost_high": max(lost),
            "runs": runs,
        },
        "downtime_min": {"scenario": round(main_s.downtime_min), "baseline": round(main_b.downtime_min)},
        "defects": {"scenario": main_s.defects, "baseline": main_b.defects, "extra": round(defects_mean, 1)},
        "plan": plan,
        "money_kzt": money,
        "margin_per_car": margin_per_car,
        "verdict": _verdict(
            actions,
            plant,
            lost_mean,
            min(lost),
            max(lost),
            money,
            plan,
            statistics.mean(s.cars for s, _ in pairs),
            statistics.mean(b.cars for _, b in pairs),
        ),
    }
    return {
        "start": t0,
        "end": end,
        "frame_every_s": frame_every,
        "frames": main_s.frames,
        "log": main_s.log,
        "series": {"scenario": main_s.series, "baseline": main_b.series},
        "summary": summary,
        "final": main_s.final,
        "shifts": main_s.shifts,
        "downtime": main_s.downtime,
        "actions": [{**a.__dict__, "title": a.title(plant)} for a in actions],
    }


def _schedule(actions: list[SimAction], t0: datetime, plant: Plant) -> list[_Due]:
    due: list[_Due] = []
    for a in actions:
        at = t0 + timedelta(minutes=a.at_min)
        until = at + timedelta(minutes=a.minutes)
        if a.kind == "failure" and a.equipment:
            code, minutes, reason = a.equipment, a.minutes, a.reason or "Поломка (ввод диспетчера)"
            due.append(_Due(at, lambda s, c=code, m=minutes, r=reason: s.fail(c, m, r, forced=True)))
        elif a.kind == "supply_delay":
            minutes = a.minutes

            def _supply(s: LineSim, m: float = minutes) -> None:
                s.kits = min(s.kits, 4)
                s.delay_supply(m)

            due.append(_Due(at, _supply))
        elif a.kind == "defects" and a.area:
            area, rate = a.area, (a.value or 0) / 100
            saved: dict[str, float | None] = {}

            def _on(s: LineSim, ar: str = area, v: float = rate, box: dict = saved) -> None:
                box["old"] = s.cfg.defect_rate.get(ar)
                s.cfg.defect_rate[ar] = v

            def _off(s: LineSim, ar: str = area, box: dict = saved) -> None:
                if box.get("old") is None:
                    s.cfg.defect_rate.pop(ar, None)
                else:
                    s.cfg.defect_rate[ar] = box["old"]

            name = plant.area(area).name
            due.append(_Due(at, _on, _log(at, "defects", f"{name}: брак вырос до {_pct(a.value)}", area, user=True)))
            due.append(_Due(until, _off, _log(until, "defects_end", f"{name}: брак вернулся к обычному", area)))
        elif a.kind == "slowdown" and a.area:
            area, k = a.area, 1 + (a.value or 0) / 100
            name = plant.area(area).name

            def _slow(s: LineSim, ar: str = area, f: float = k) -> None:
                s.areas[ar].cycle_s *= f

            def _fast(s: LineSim, ar: str = area, f: float = k) -> None:
                s.areas[ar].cycle_s /= f

            due.append(_Due(at, _slow, _log(at, "slowdown", f"{name}: цикл медленнее на {_pct(a.value)}", area, True)))
            due.append(_Due(until, _fast, _log(until, "slowdown_end", f"{name}: цикл снова обычный", area)))
    return sorted(due, key=lambda d: d.at)


def _play(sim: LineSim, plant: Plant, due: list[_Due], end: datetime, *, frames: bool, frame_every: float) -> _Run:
    run = _Run()
    t0 = sim.clock
    closed_cars = 0
    defects = 0
    recent: list[dict] = []
    next_frame = t0
    next_mark = t0
    pending = list(due)
    if frames:
        for eq in sim.equipment.values():
            if eq.status in (EqStatus.DOWN, EqStatus.MAINT):
                run.log.append(
                    _log(
                        t0, "already_down", f"{eq.spec.code} уже стоит: {(eq.reason or 'отказ').lower()}", eq.spec.area
                    )
                    | {"equipment": eq.spec.code, "severity": "critical" if eq.spec.critical else "warning"}
                )

    def handle(events) -> None:
        nonlocal closed_cars, defects, recent
        for e in events:
            d = e.data
            if e.kind == "equipment_down":
                run.log.append(
                    _log(
                        e.at,
                        "down",
                        f"{d['equipment']}: {d['reason'].lower()}",
                        d["area"],
                        user=sim.equipment[d["equipment"]].forced,
                    )
                    | {
                        "equipment": d["equipment"],
                        "severity": "info" if d["planned"] else ("critical" if d["critical"] else "warning"),
                        "expected_min": d["expected_min"],
                    }
                )
            elif e.kind == "equipment_up":
                if d["critical"] and not d["planned"]:
                    run.downtime_min += d["minutes"]
                run.downtime.append({**d, "day": (d["started_at"] or e.at).date()})
                run.log.append(
                    _log(e.at, "up", f"{d['equipment']} снова в работе · простой {_dur(d['minutes'])}", d["area"])
                    | {"equipment": d["equipment"]}
                )
            elif e.kind == "supply_delay":
                run.log.append(
                    _log(e.at, "supply", f"Поставка комплектов задерживается на {_dur(d['minutes'])}", "WH_IN")
                )
            elif e.kind == "supply_restored":
                run.log.append(_log(e.at, "supply_end", "Комплекты привезли — склад пополнен", "WH_IN"))
            elif e.kind == "defect":
                defects += 1
            elif e.kind == "body_done":
                recent = ([{"vin": d["vin"], "model": d["model"], "at": e.at}] + recent)[:8]
            elif e.kind == "shift_end":
                closed_cars += d["finished"]
                run.shifts.append(d)
                run.log.append(_log(e.at, "shift_end", f"Смена {d['shift']} закрыта: {d['finished']} авто", None))

    while True:
        while pending and pending[0].at <= sim.clock:
            item = pending.pop(0)
            item.apply(sim)
            if item.log:
                run.log.append(item.log)
        handle(sim.drain_events())
        if frames and sim.clock >= next_frame and sim.clock <= end:
            run.frames.append(floor_snapshot(sim, plant, speed=1, paused=False, recent=recent))
            next_frame += timedelta(seconds=frame_every)
        if sim.clock >= next_mark:
            run.series.append({"t": sim.clock, "cars": closed_cars + len(sim.finished)})
            next_mark += timedelta(minutes=SERIES_EVERY_MIN)
        if sim.clock >= end:
            break
        sim.step(min(STEP_S, max((end - sim.clock).total_seconds(), 0.5)))

    if frames:
        run.final = floor_snapshot(sim, plant, speed=1, paused=False, recent=recent)
    cars_at_end = closed_cars + len(sim.finished)
    for eq in sim.equipment.values():
        if eq.status == EqStatus.DOWN and eq.spec.critical and eq.since:
            run.downtime_min += (sim.clock - eq.since).total_seconds() / 60
    if sim.working:
        sim.step(1.0)
        handle(sim.drain_events())
    run.cars = cars_at_end
    run.defects = defects
    run.series.append({"t": end, "cars": cars_at_end})
    return run


def _plan_in_window(sim: LineSim, plant: Plant, end: datetime) -> dict:
    shifts, t = 0, sim.clock
    probe = copy.copy(sim)
    while t < end:
        number, _, s_end = probe._shift_window(t)
        if number is None:
            t = probe.next_shift_start(t)
            continue
        if s_end and s_end <= end + timedelta(minutes=1):
            shifts += 1
        t = (s_end or t) + timedelta(seconds=1)
    return {"shifts": shifts, "cars": shifts * plant.targets.shift_plan}


def _verdict(actions, plant, lost, low, high, money, plan, scen_mean: float, base_mean: float) -> str:
    what = "Эти события обойдутся" if len(actions) > 1 else "Это событие обойдётся"
    if lost < 0.5:
        head = "Событие почти не влияет на выпуск: линия успевает наверстать за счёт буферов."
    else:
        rng = f" (в разных прогонах от {low} до {high})" if high != low else ""
        head = f"{what} примерно в {_n(_r(lost))} авто{rng} — около {_money(money)}."
    tail = ""
    if plan["cars"]:
        tail = (
            f" План {_n(plan['cars'])}: без событий выйдет около {_n(_r(base_mean))}, "
            f"с событиями — около {_n(_r(scen_mean))}."
        )
    return head + tail


def _r(x: float) -> int:
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


def _log(at: datetime, kind: str, title: str, area: str | None, user: bool = False) -> dict:
    return {"t": at, "kind": kind, "title": title, "area": area, "user": user}


def _dur(minutes: float | None) -> str:
    m = round(minutes or 0)
    if m < 60:
        return f"{m} мин"
    h, r = divmod(m, 60)
    return f"{h} ч {r} мин" if r else f"{h} ч"


def _pct(v: float | None) -> str:
    return f"{v:g}%".replace(".", ",") if v is not None else "—"


def _n(x: float) -> str:
    return f"{x:,.0f}".replace(",", " ")


def _money(kzt: float) -> str:
    if kzt >= 1_000_000:
        return f"{kzt / 1_000_000:.1f} млн ₸".replace(".", ",")
    if kzt >= 1000:
        return f"{kzt / 1000:.0f} тыс ₸"
    return f"{kzt:.0f} ₸"
