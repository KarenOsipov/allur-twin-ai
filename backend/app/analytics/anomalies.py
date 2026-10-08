from __future__ import annotations

from collections import defaultdict
from datetime import date

import numpy as np

from app.domain.plant import Plant
from app.services.data_service import Dataset

FEATURES = (
    "output",
    "worst_line",
    "downtime",
    "weld_defect",
    "paint_defect",
    "run_hours",
)
LABELS = {
    "output": ("выпуск", "{:.0f} авт.", -1),
    "worst_line": ("выполнение плана худшей линией", "{:.0f}%", -1),
    "downtime": ("внеплановый простой", "{:.0f} мин", 1),
    "weld_defect": ("брак сварки", "{:.1f}%", 1),
    "paint_defect": ("брак окраски", "{:.1f}%", 1),
    "run_hours": ("время работы линий", "{:.1f} ч", -1),
}


def shift_anomalies(ds: Dataset, plant: Plant, since: date | None = None, limit: int = 8) -> list[dict]:
    from sklearn.ensemble import IsolationForest

    last_line = plant.lines[-1].code
    prod = defaultdict(dict)
    for r in ds.production:
        prod[(r.day, r.shift)][r.area] = r
    qual = defaultdict(dict)
    for q in ds.quality:
        qual[(q.day, q.shift)][q.area] = q
    down = defaultdict(float)
    reasons = defaultdict(list)
    for r in ds.downtime:
        if not r.planned:
            down[(r.day, r.shift)] += r.minutes
            reasons[(r.day, r.shift)].append(f"{r.equipment}: {r.reason.lower()} {round(r.minutes)} мин")

    keys, X = [], []
    for key, lines in sorted(prod.items()):
        if last_line not in lines or len(lines) < len(plant.lines):
            continue
        q = qual.get(key, {})

        def rate(area: str, q=q) -> float:
            r = q.get(area)
            return r.defects / r.produced * 100 if r and r.produced else 0.0

        X.append(
            [
                lines[last_line].fact,
                min((r.fact / r.plan * 100 for r in lines.values() if r.plan), default=100.0),
                down.get(key, 0.0),
                rate("WELD"),
                rate("PAINT"),
                sum(r.run_hours for r in lines.values()) / len(lines),
            ]
        )
        keys.append(key)
    if len(X) < 30:
        return []
    arr = np.array(X)
    model = IsolationForest(n_estimators=200, contamination=0.06, random_state=0).fit(arr)
    scores = -model.score_samples(arr)
    flags = model.predict(arr) == -1
    med = np.median(arr, axis=0)
    mad = np.median(np.abs(arr - med), axis=0) * 1.4826 + 1e-6

    out = []
    for i in np.argsort(-scores):
        if not flags[i]:
            continue
        day, shift = keys[i]
        if since and day < since:
            continue
        z = (arr[i] - med) / mad
        drivers = []
        for j in np.argsort(-np.abs(z)):
            name, fmt, bad_dir = LABELS[FEATURES[j]]
            if np.sign(z[j]) != bad_dir or abs(z[j]) < 2:
                continue
            value, usual = fmt.format(arr[i][j]), fmt.format(med[j])
            drivers.append(f"{name} {value} (обычно {usual})".replace(".", ","))
            if len(drivers) == 2:
                break
        if not drivers:
            continue
        out.append(
            {
                "day": day,
                "shift": shift,
                "score": round(float(scores[i]), 3),
                "output": int(arr[i][0]),
                "drivers": drivers,
                "events": reasons.get((day, shift), [])[:3],
            }
        )
        if len(out) >= limit:
            break
    out.sort(key=lambda a: (a["day"], a["shift"]), reverse=True)
    return out
