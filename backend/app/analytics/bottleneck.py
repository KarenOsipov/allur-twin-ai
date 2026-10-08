from __future__ import annotations

from collections import Counter, defaultdict

from app.domain.plant import Plant
from app.services.data_service import Dataset


def bottleneck_history(ds: Dataset, plant: Plant, last_shifts: int = 60) -> dict:
    by_shift = defaultdict(dict)
    for r in ds.production:
        by_shift[(r.day, r.shift)][r.area] = r
    defects = {(q.day, q.shift, q.area): q for q in ds.quality}
    keys = sorted(by_shift)[-last_shifts:]
    counts: Counter[str] = Counter()
    capacity_sum: dict[str, float] = defaultdict(float)
    for k in keys:
        rows = by_shift[k]
        if len(rows) < len(plant.lines):
            continue
        cap = {}
        for a in plant.lines:
            q = defects.get((k[0], k[1], a.code))
            good = 1 - (q.defects / q.produced if q and q.produced else 0)
            cap[a.code] = 3600 / a.cycle_s * rows[a.code].run_hours * good
            capacity_sum[a.code] += cap[a.code]
        counts[min(cap, key=lambda c: cap[c])] += 1
    shifts = sum(counts.values())
    total = shifts or 1

    lines = []
    for area in plant.lines:
        rows = [by_shift[k][area.code] for k in keys if area.code in by_shift[k]]
        run = sum(r.run_hours for r in rows) or 1
        fact = sum(r.fact for r in rows)
        lines.append(
            {
                "area": area.code,
                "name": area.name,
                "share": round(counts[area.code] / total * 100),
                "good_capacity_per_shift": round(capacity_sum[area.code] / total, 1),
                "rate_per_hour": round(fact / run, 2),
                "ideal_per_hour": round(3600 / area.cycle_s, 2),
                "cycle_s": area.cycle_s,
                "takt_s": round(plant.takt_s),
            }
        )
    main = max(lines, key=lambda x: x["share"])
    return {"shifts": shifts, "constraint": main["area"], "lines": lines}
