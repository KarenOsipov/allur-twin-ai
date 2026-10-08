from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date

from app.core.text import ru
from app.domain.plant import Plant
from app.services.data_service import Dataset


def _count_days(year: int, month: int, weekdays: set[int]) -> int:
    n = calendar.monthrange(year, month)[1]
    return sum(1 for d in range(1, n + 1) if date(year, month, d).weekday() in weekdays)


def data_checks(ds: Dataset, plant: Plant, today: date) -> list[dict]:
    t = plant.targets
    out: list[dict] = []
    month = today.strftime("%Y-%m")

    plans = [p for p in ds.model_plan if p.month == month]
    if not plans and ds.model_plan:
        last = max(p.month for p in ds.model_plan)
        plans = [p for p in ds.model_plan if p.month == last]
    if plans:
        total = sum(p.plan for p in plans)
        if total != t.month_output:
            parts = " + ".join(f"{p.plan:,}".replace(",", " ") for p in plans)
            out.append(
                {
                    "level": "critical" if total < t.month_output else "info",
                    "title": f"План по моделям не совпадает с целью: {total:,} вместо {t.month_output:,}".replace(
                        ",", " "
                    ),
                    "text": f"{parts} = {total:,} автомобилей, а цель — не менее {t.month_output:,}. "
                    f"Не распределено {t.month_output - total:,} машин: им не назначена модель, "
                    "а значит, под них не заказаны комплекты.".replace(",", " "),
                }
            )

    capacity_shift = t.shift_plan
    per_day = capacity_shift * len(plant.shifts)
    five = _count_days(today.year, today.month, {0, 1, 2, 3, 4})
    six = _count_days(today.year, today.month, {0, 1, 2, 3, 4, 5})
    if per_day * five < t.month_output:
        out.append(
            {
                "level": "warning",
                "title": "При пятидневке план 5 500 недостижим даже при 100% загрузке",
                "text": f"{len(plant.shifts)} смены × {capacity_shift} авт. = {per_day} в сутки. "
                f"В {today:%m.%Y} — {five} будних дней → максимум {per_day * five:,} автомобилей. "
                f"С рабочими субботами ({six} дн.) — {per_day * six:,}, план выполним при выпуске "
                f"{t.month_output / six:.0f}+ в сутки. В модели заложена шестидневка.".replace(",", " "),
            }
        )

    by_shift = defaultdict(dict)
    for r in ds.production:
        if r.source == "customer":
            by_shift[(r.day, r.shift)][r.area] = r.fact
    for (d, _), facts in sorted(by_shift.items()):
        names = [a for a in plant.lines if a.code in facts]
        for prev, nxt in zip(names, names[1:], strict=False):
            if facts[nxt.code] > facts[prev.code]:
                out.append(
                    {
                        "level": "info",
                        "title": f"{d:%d.%m}: {nxt.line} выпустила больше, чем пришло с {prev.line}",
                        "text": f"{facts[nxt.code]} против {facts[prev.code]} — разница "
                        f"{facts[nxt.code] - facts[prev.code]} "
                        "кузова взята из буфера незавершённого производства между участками. Это нормально, "
                        "но буфер истощается: в цифровом двойнике он виден в реальном времени.",
                    }
                )

    limit = t.critical_downtime_min_per_day
    customer_down = [r for r in ds.downtime if r.source == "customer"]
    for r in customer_down:
        try:
            critical = plant.eq(r.equipment).critical
        except StopIteration:
            critical = False
        if critical and r.minutes >= limit * 0.85:
            out.append(
                {
                    "level": "warning",
                    "title": f"{r.equipment}: {round(r.minutes)} мин простоя из {round(limit)} допустимых",
                    "text": f"{r.day:%d.%m} — «{r.reason}». До предела оставалось {round(limit - r.minutes)} мин. "
                    "Посмотрите прогноз риска отказов: у этой единицы интервалы между отказами сокращаются.",
                }
            )

    for q in ds.quality:
        if q.source != "customer" or not q.produced:
            continue
        pct = q.defects / q.produced * 100
        if pct > t.defect_pct * 2:
            area = plant.area(q.area)
            out.append(
                {
                    "level": "critical",
                    "title": f"{q.day:%d.%m} {area.name}: брак {pct:.1f}% при норме {t.defect_pct:.0f}%",
                    "text": f"{q.defects} из {q.produced}. Превышение в {pct / t.defect_pct:.1f} раза — "
                    "главная проблема качества в данных заказчика.",
                }
            )

    for r in ds.production:
        if r.source == "customer" and r.load_pct is not None:
            expected = r.run_hours / 8 * 100
            if abs(expected - r.load_pct) > 1.5:
                out.append(
                    {
                        "level": "info",
                        "title": f"{r.day:%d.%m} {r.line}: загрузка {r.load_pct:.0f}% не равна {r.run_hours} ч / 8 ч",
                        "text": f"Ожидалось {expected:.0f}%. Возможно, загрузка считается от другого фонда времени.",
                    }
                )

    for c in out:
        c["title"], c["text"] = ru(c["title"]), ru(c["text"])
    order = {"critical": 0, "warning": 1, "info": 2}
    out.sort(key=lambda x: order[x["level"]])
    return out
