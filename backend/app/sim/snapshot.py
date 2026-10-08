from __future__ import annotations

from app.domain.plant import Plant
from app.sim.engine import Body, EqStatus, LineSim


def body_dict(b: Body | None) -> dict | None:
    if b is None:
        return None
    return {"vin": b.vin, "model": b.model, "color": b.color, "hex": b.hex, "defect": b.defect_area is not None}


def floor_snapshot(sim: LineSim, plant: Plant, *, speed: float, paused: bool, recent: list[dict]) -> dict:
    elapsed = (sim.clock - sim.shift_start).total_seconds() if sim.working and sim.shift_start else 0.0
    shift_len = (sim.shift_end - sim.shift_start).total_seconds() if sim.working else 8 * 3600
    plan_to_now = int(elapsed / plant.takt_s) if sim.working else 0
    areas = []
    for area in plant.areas:
        a = sim.areas.get(area.code)
        if a is None:
            areas.append(
                {
                    "code": area.code,
                    "name": area.name,
                    "kind": area.kind.value,
                    "stock": sim.kits if area.code == "WH_IN" else len(sim.finished),
                    "delayed": sim.kits_delayed_until is not None if area.code == "WH_IN" else False,
                }
            )
            continue
        busy = a.run_s + a.down_s + a.starved_s + a.blocked_s
        avail = 1 - a.down_s / busy if busy else 1.0
        perf = min(1.0, a.output * a.cycle_s / max(busy - a.down_s, 1)) if busy else 0.0
        qual = (a.output - a.defects) / a.output if a.output else 1.0
        areas.append(
            {
                "code": area.code,
                "name": area.name,
                "kind": area.kind.value,
                "state": a.state.value,
                "progress": round(min(a.progress_s / a.target_s, 1.0), 3) if a.current and a.target_s else 0,
                "current": body_dict(a.current),
                "output": a.output,
                "defects": a.defects,
                "oee": round(avail * perf * qual * 100, 1) if a.output else None,
                "buffer": [body_dict(b) for b in sim.buffers[area.code]] if area.code != "QC" else [],
                "buffer_cap": sim.buffer_cap[area.code] if area.code != "QC" else 0,
                "time": {
                    "run": round(a.run_s / 60),
                    "down": round(a.down_s / 60),
                    "starved": round(a.starved_s / 60),
                    "blocked": round(a.blocked_s / 60),
                },
            }
        )
    equipment = [
        {
            "code": eq.spec.code,
            "area": eq.spec.area,
            "status": eq.status.value,
            "reason": eq.reason,
            "since": eq.since,
            "until": eq.until,
            "critical": eq.spec.critical,
        }
        for eq in sim.equipment.values()
    ]
    down = [e for e in equipment if e["status"] in (EqStatus.DOWN.value, EqStatus.MAINT.value)]
    finished = len(sim.finished)
    total_out = sum(a.output for c, a in sim.areas.items() if c != "QC")
    total_def = sum(a.defects for a in sim.areas.values())
    return {
        "ready": True,
        "clock": sim.clock,
        "speed": speed,
        "paused": paused,
        "working": sim.working,
        "shift": {
            "number": sim.shift_number,
            "start": sim.shift_start,
            "end": sim.shift_end,
            "progress": round(elapsed / shift_len, 4) if sim.working else 0,
        },
        "areas": areas,
        "equipment": equipment,
        "kpi": {
            "finished": finished,
            "plan_to_now": plan_to_now,
            "shift_plan": plant.targets.shift_plan,
            "forecast_shift": round(finished / elapsed * shift_len) if elapsed > 600 else None,
            "defect_pct": round(total_def / total_out * 100, 2) if total_out else 0.0,
            "rework": sim.rework,
            "down_now": len(down),
            "bottleneck": sim.bottleneck(),
            "models": sim.model_counts,
        },
        "recent": recent,
        "kits": sim.kits,
    }
