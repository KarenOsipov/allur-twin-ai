from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

import numpy as np

from app.core.text import ru
from app.domain.plant import Plant
from app.services.data_service import Dataset


def _rate(rows) -> float:
    produced = sum(r[0] for r in rows)
    return sum(r[1] for r in rows) / produced * 100 if produced else 0.0


def quality_analysis(ds: Dataset, plant: Plant, today: date, window: int = 21) -> list[dict]:
    target = plant.targets.defect_pct
    per_day: dict[str, dict[date, list]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    per_shift: dict[str, dict[int, list]] = defaultdict(lambda: defaultdict(list))
    for q in ds.quality:
        cell = per_day[q.area][q.day]
        cell[0] += q.produced
        cell[1] += q.defects
        if (today - q.day).days <= 45:
            per_shift[q.area][q.shift].append((q.produced, q.defects))

    out = []
    for area in plant.lines:
        series = sorted(per_day[area.code].items())
        if len(series) < 7:
            continue
        recent = series[-window:]
        xs = np.array([(d - recent[0][0]).days for d, _ in recent], dtype=float)
        ys = np.array([v[1] / v[0] * 100 if v[0] else 0 for _, v in recent])
        slope, intercept = np.polyfit(xs, ys, 1)
        level = float(intercept + slope * xs[-1])
        forecast_7 = float(level + slope * 7)
        days_over = 0
        for _, v in reversed(series):
            if v[0] and v[1] / v[0] * 100 > target:
                days_over += 1
            else:
                break
        crossing = None
        if level <= target < forecast_7 and slope > 0:
            crossing = (series[-1][0] + timedelta(days=round((target - level) / slope))).isoformat()

        causes = _causes(ds, plant, area.code, per_day[area.code], per_shift[area.code], today)
        if level <= target:
            causes = [c for c in causes if c["kind"] != "maintenance"]
        for c in causes:
            c["text"] = ru(c["text"])
        out.append(
            {
                "area": area.code,
                "name": area.name,
                "level": round(level, 2),
                "last": round(float(ys[-1]), 2),
                "slope_week": round(float(slope) * 7, 2),
                "forecast_7": round(forecast_7, 2),
                "target": target,
                "status": "critical" if level > target * 1.5 else "warning" if level > target else "ok",
                "days_over": days_over,
                "crossing": crossing,
                "series": [{"day": d, "pct": round(v[1] / v[0] * 100, 2) if v[0] else 0} for d, v in series[-60:]],
                "causes": causes,
            }
        )
    return out


def _causes(ds: Dataset, plant: Plant, area: str, per_day, per_shift, today: date) -> list[dict]:
    causes = []
    s1, s2 = per_shift.get(1, []), per_shift.get(2, [])
    if s1 and s2:
        r1, r2 = _rate(s1), _rate(s2)
        if abs(r2 - r1) >= 0.4:
            worse = 2 if r2 > r1 else 1
            causes.append(
                {
                    "kind": "shift",
                    "strength": round(abs(r2 - r1), 2),
                    "text": f"Во {worse}-й смене брак выше: {max(r1, r2):.1f}% против {min(r1, r2):.1f}% (45 дней)",
                }
            )
    daily = {d: (v[1] / v[0] * 100 if v[0] else 0.0) for d, v in per_day.items()}
    by_eq: dict[tuple[str, bool, str], set[date]] = defaultdict(set)
    for r in ds.downtime:
        if r.area == area and r.equipment != "Поставка":
            by_eq[(r.equipment, r.planned, r.reason)].add(r.day)
    for (eq, planned, reason), days in by_eq.items():
        if len(days) < 2:
            continue
        if not planned:
            affected = {d + timedelta(days=k) for d in days for k in (0, 1)} & daily.keys()
            if len(affected) < 2:
                continue
            diffs = []
            for d in days:
                around = [daily[x] for x in daily if 2 <= abs((x - d).days) <= 7]
                hit = [daily[x] for x in (d, d + timedelta(days=1)) if x in daily]
                if around and hit:
                    diffs.append(np.mean(hit) - np.mean(around))
            if diffs and np.mean(diffs) >= 0.6:
                causes.append(
                    {
                        "kind": "equipment",
                        "equipment": eq,
                        "strength": round(float(np.mean(diffs)), 2),
                        "text": f"После отказа «{reason}» ({eq}) брак в тот и следующий день выше на "
                        f"{np.mean(diffs):.1f} п.п.",
                    }
                )
        else:
            before, after = [], []
            for d in days:
                before += [daily[d - timedelta(days=k)] for k in (1, 2, 3) if d - timedelta(days=k) in daily]
                after += [daily[d + timedelta(days=k)] for k in (1, 2, 3) if d + timedelta(days=k) in daily]
            if len(before) >= 3 and len(after) >= 3:
                effect = float(np.mean(after) - np.mean(before))
                helps = effect <= -0.3
                causes.append(
                    {
                        "kind": "maintenance",
                        "equipment": eq,
                        "strength": round(abs(effect), 2),
                        "text": (
                            f"«{reason}» ({eq}) снижает брак на {abs(effect):.1f} п.п."
                            if helps
                            else f"«{reason}» ({eq}) почти не влияет на брак ({effect:+.1f} п.п.) — причина в другом"
                        ),
                    }
                )
    series = sorted(daily.items())
    if len(series) >= 40:
        first = np.mean([v for _, v in series[:20]])
        last = np.mean([v for _, v in series[-20:]])
        if last - first >= 0.8:
            causes.append(
                {
                    "kind": "trend",
                    "strength": round(float(last - first), 2),
                    "text": f"Брак растёт постепенно уже несколько недель: {first:.1f}% → {last:.1f}% — "
                    "похоже на износ или разладку процесса, а не на разовые сбои",
                }
            )
    causes.sort(key=lambda c: -c["strength"])
    return causes[:5]
