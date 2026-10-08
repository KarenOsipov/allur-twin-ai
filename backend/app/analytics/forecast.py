from __future__ import annotations

import calendar
import math
from collections import defaultdict
from datetime import date, timedelta

from app.domain.plant import Plant
from app.services.data_service import Dataset


def _workdays(plant: Plant, start: date, end: date) -> list[date]:
    out, d = [], start
    while d <= end:
        if d.weekday() in plant.workdays:
            out.append(d)
        d += timedelta(days=1)
    return out


def _phi(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def month_forecast(ds: Dataset, plant: Plant, today: date, today_live: int = 0, lookback: int = 15) -> dict:
    last_line = plant.lines[-1].code
    month_start = today.replace(day=1)
    month_end = today.replace(day=calendar.monthrange(today.year, today.month)[1])
    daily = defaultdict(int)
    for r in ds.production:
        if r.area == last_line:
            daily[r.day] += r.fact

    history_days = [d for d in sorted(daily) if d < today]
    recent = history_days[-lookback:]
    if not recent:
        return {"available": False}
    weights = [0.88 ** (len(recent) - 1 - i) for i in range(len(recent))]
    mean = sum(daily[d] * w for d, w in zip(recent, weights, strict=True)) / sum(weights)
    var = sum(w * (daily[d] - mean) ** 2 for d, w in zip(recent, weights, strict=True)) / sum(weights)
    sd = math.sqrt(var)

    today_done = daily.get(today, 0) + today_live
    mtd = sum(v for d, v in daily.items() if month_start <= d < today) + today_done
    remaining = _workdays(plant, today, month_end)
    rest_days = max(0.0, len(remaining) - (today_done / mean if mean else 0))
    expected = mtd + mean * rest_days
    spread = sd * math.sqrt(max(rest_days, 0.0)) + mean * rest_days * 0.02
    target = plant.targets.month_output
    p_meet = 1 - _phi((target - expected) / spread) if spread > 0 else float(expected >= target)
    need_daily = max(0.0, (target - mtd) / max(rest_days, 1.0)) if rest_days > 0 else None
    capacity_daily = plant.targets.shift_plan * len(plant.shifts)

    series = []
    cum = 0
    for d in _workdays(plant, month_start, month_end):
        if d < today:
            cum += daily.get(d, 0)
            series.append({"day": d, "fact": cum})
    cum_f = mtd
    lo = hi = mtd
    for i, d in enumerate(remaining):
        step = mean * (1 - (min(today_done / mean, 1) if (i == 0 and mean) else 0))
        cum_f += step
        n = i + 1
        band = 1.2816 * (sd * math.sqrt(n) + mean * n * 0.02)
        lo, hi = cum_f - band, cum_f + band
        series.append({"day": d, "forecast": round(cum_f), "low": round(lo), "high": round(hi)})

    return {
        "available": True,
        "month": today.strftime("%Y-%m"),
        "target": target,
        "fact_to_date": mtd,
        "expected": round(expected),
        "p10": round(expected - 1.2816 * spread),
        "p90": round(expected + 1.2816 * spread),
        "probability": round(p_meet * 100),
        "gap": round(expected - target),
        "daily_rate": round(mean, 1),
        "daily_sd": round(sd, 1),
        "need_daily": round(need_daily, 1) if need_daily is not None else None,
        "capacity_daily": capacity_daily,
        "workdays_left": len(remaining),
        "workdays_total": len(_workdays(plant, month_start, month_end)),
        "series": series,
    }
