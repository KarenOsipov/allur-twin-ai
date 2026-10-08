from __future__ import annotations

import copy
import statistics
from datetime import timedelta

from app.sim.engine import LineSim

STEP_S = 10.0
MARK_MIN = 15


def forecast_shift(sim: LineSim, plan: int, runs: int = 8) -> dict:
    if not sim.working or sim.shift_end is None or sim.shift_start is None:
        return {"available": False}
    start = sim.clock
    end = sim.shift_end
    done_now = len(sim.finished)
    results, defects, downtime = [], [], []
    marks: list[list[int]] = []
    for i in range(runs):
        twin = copy.deepcopy(sim)
        twin.reseed(7919 * (i + 1))
        twin.cfg = copy.deepcopy(sim.cfg)
        twin.cfg.hazard_scale = 1.0
        twin.events = []
        series, nxt, down = [], start, 0.0
        defects0 = sum(a.defects for a in twin.areas.values())
        while twin.clock < end - timedelta(seconds=1):
            twin.step(min(STEP_S, (end - twin.clock).total_seconds()))
            for e in twin.drain_events():
                if e.kind == "equipment_up" and e.data["critical"]:
                    down += e.data["minutes"]
            if twin.clock >= nxt:
                series.append(len(twin.finished))
                nxt += timedelta(minutes=MARK_MIN)
        series.append(len(twin.finished))
        marks.append(series)
        results.append(len(twin.finished))
        defects.append(sum(a.defects for a in twin.areas.values()) - defects0)
        downtime.append(down)

    n = min(len(s) for s in marks)
    timeline = []
    for k in range(n):
        vals = sorted(s[k] for s in marks)
        t = min(start + timedelta(minutes=MARK_MIN * k), end)
        timeline.append({"t": t, "mean": round(statistics.mean(vals), 1), "low": vals[0], "high": vals[-1]})
    meet = sum(1 for r in results if r >= plan) / runs
    return {
        "available": True,
        "now": start,
        "end": end,
        "minutes_left": round((end - start).total_seconds() / 60),
        "finished_now": done_now,
        "expected": round(statistics.mean(results)),
        "low": min(results),
        "high": max(results),
        "plan": plan,
        "probability": round(meet * 100),
        "defects_expected": round(statistics.mean(defects), 1),
        "downtime_expected_min": round(statistics.mean(downtime)),
        "runs": runs,
        "timeline": timeline,
    }
