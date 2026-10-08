"""Экономический эффект цифрового двойника: сколько денег и часов он экономит заводу.

Считаем от фактических потерь за последние 30 дней (простои, брак, недовыпуск) и прозрачных
допущений — их видно на странице «Экономика» и можно поменять. Каждый рычаг — отдельная строка:
откуда берётся эффект, формула и сумма. Итог: эффект в месяц и год, срок окупаемости, ROI,
сэкономленные часы.

Минуту простоя линии оцениваем двумя способами:
  * консервативно (основной итог): потерянный выпуск догоняют сверхурочными — минута стоит
    оплату всей линии по ставке сверхурочных плюс накладные расходы;
  * по марже (верхняя оценка): если план под угрозой, потерянная минута — непроданная доля автомобиля.
"""

from __future__ import annotations

from datetime import timedelta

from app.analytics import kpi
from app.domain.plant import Plant

DEFAULTS = {
    "reaction_before_min": 12.0,  # сейчас: пока рабочий найдёт мастера, мастер — ремонтника
    "reaction_after_min": 3.0,  # с двойником: сообщение с телефона, анализ за минуту
    "downtime_line_share": 0.6,  # какая часть простоя станка превращается в потерю выпуска (буферы спасают)
    "predictive_share": 0.2,  # доля внеплановых отказов, которые профилактика по прогнозу предотвращает
    "defect_catch_share": 0.3,  # доля брака сверх нормы, которую ловят раньше благодаря контролю трендов
    "report_hours_before": 1.5,  # часов на отчёты у начальника смены за смену
    "report_hours_after": 0.25,
    "analyst_hours_day": 2.0,  # часов в день на сбор данных и сводки у планового отдела
    "manager_rate_kzt_h": 6_500,
    "overhead_kzt_min": 2_000,  # энергия и накладные расходы минуты работы линии
    "implementation_kzt": 25_000_000,  # внедрение: интеграция, обучение, оборудование
    "support_kzt_month": 1_500_000,  # сопровождение и сервер
}

LABELS = {
    "reaction_before_min": "Реакция на поломку сейчас, мин",
    "reaction_after_min": "Реакция с двойником, мин",
    "downtime_line_share": "Доля простоя станка, которая теряет выпуск",
    "predictive_share": "Отказов предотвращает профилактика по прогнозу",
    "defect_catch_share": "Брака сверх нормы ловится раньше",
    "report_hours_before": "Часов на отчёты за смену сейчас",
    "report_hours_after": "Часов на отчёты за смену с двойником",
    "analyst_hours_day": "Часов в день на сводки у планового отдела",
    "manager_rate_kzt_h": "Час работы ИТР, ₸",
    "overhead_kzt_min": "Накладные расходы минуты линии, ₸",
    "implementation_kzt": "Внедрение, ₸ разово",
    "support_kzt_month": "Сопровождение, ₸ в месяц",
}

WORKDAYS = 26


def roi(ds, plant: Plant, today, econ: dict) -> dict:
    a = {**DEFAULTS, **{k: v for k, v in (econ.get("roi") or {}).items() if k in DEFAULTS}}
    margin = econ.get("margin_per_car_kzt", 450_000)
    rework = econ.get("rework_cost_kzt", 60_000)
    end = min(ds.last_day or today, today)
    start = end - timedelta(days=29)
    p = kpi.period_kpis(ds, plant, start, end)
    days = max(p["days"], 1)
    k = WORKDAYS / days  # пересчёт в рабочий месяц

    cars_per_min = 60 / plant.takt_s  # такт 240 с → 0,25 авто в минуту
    downtime = [r for r in ds.downtime if start <= r.day <= end and not r.planned]
    stops = len(downtime) * k
    unplanned_min = sum(r.minutes for r in downtime) * k
    defects = sum(line["defects"] for line in p["lines"]) * k
    produced = sum(line["fact"] for line in p["lines"]) * k
    excess_defects = max(0.0, defects - produced * plant.targets.defect_pct / 100)
    shortfall = max(0.0, (p["plan"] - p["output"]) * k)

    cost_min_margin = margin * cars_per_min
    staff = econ.get("line_staff", 60)
    cost_min = staff * econ.get("overtime_rate_kzt_h", 5250) / 60 + a["overhead_kzt_min"]
    k_margin = cost_min_margin / cost_min  # во сколько раз оценка по марже выше
    losses = {
        "downtime_kzt": round(unplanned_min * a["downtime_line_share"] * cost_min),
        "downtime_kzt_margin": round(unplanned_min * a["downtime_line_share"] * cost_min_margin),
        "defects_kzt": round(defects * rework),
        "shortfall_kzt": round(shortfall * margin),
        "unplanned_min": round(unplanned_min),
        "stops": round(stops),
        "defects": round(defects),
        "shortfall_cars": round(shortfall),
    }

    levers = []
    saved_min = stops * max(a["reaction_before_min"] - a["reaction_after_min"], 0)
    levers.append(
        _lever(
            "reaction",
            "Быстрая реакция на поломку",
            f"{round(stops)} внеплановых остановок в месяц × "
            f"{a['reaction_before_min'] - a['reaction_after_min']:g} мин "
            f"быстрее × {a['downtime_line_share']:.0%} доли потерь × {_m(cost_min)} за минуту линии",
            saved_min * a["downtime_line_share"] * cost_min,
            hours=saved_min / 60,
            hours_note="часов простоя линии",
            margin_k=k_margin,
            cars=saved_min * a["downtime_line_share"] * cars_per_min,
        )
    )
    prevented = unplanned_min * a["predictive_share"]
    levers.append(
        _lever(
            "predictive",
            "Профилактика по прогнозу отказов",
            f"{round(unplanned_min)} мин внепланового простоя × {a['predictive_share']:.0%} предотвращённых отказов "
            f"× {a['downtime_line_share']:.0%} × {_m(cost_min)} за минуту",
            prevented * a["downtime_line_share"] * cost_min,
            hours=prevented / 60,
            hours_note="часов простоя линии",
            margin_k=k_margin,
            cars=prevented * a["downtime_line_share"] * cars_per_min,
        )
    )
    caught = excess_defects * a["defect_catch_share"]
    levers.append(
        _lever(
            "quality",
            "Ранний контроль брака",
            f"{round(excess_defects)} дефектов сверх нормы × {a['defect_catch_share']:.0%} пойманных раньше × "
            f"{_m(rework)} за переделку",
            caught * rework,
        )
    )
    shifts_month = len(plant.shifts) * WORKDAYS
    report_h = (
        shifts_month * max(a["report_hours_before"] - a["report_hours_after"], 0) + a["analyst_hours_day"] * WORKDAYS
    )
    levers.append(
        _lever(
            "reports",
            "Отчёты и сводки формируются сами",
            f"{shifts_month} смен × {a['report_hours_before'] - a['report_hours_after']:g} ч начальника смены "
            f"+ {a['analyst_hours_day']:g} ч в день планового отдела × {_m(a['manager_rate_kzt_h'])} за час",
            report_h * a["manager_rate_kzt_h"],
            hours=report_h,
            hours_note="рабочих часов ИТР",
        )
    )
    gross = sum(x["kzt_month"] for x in levers)
    gross_margin = sum(x["kzt_month_margin"] for x in levers)
    net = gross - a["support_kzt_month"]
    net_margin = gross_margin - a["support_kzt_month"]
    payback = round(a["implementation_kzt"] / net, 1) if net > 0 else None
    year_net = net * 12 - a["implementation_kzt"]
    roi_pct = round(year_net / a["implementation_kzt"] * 100) if a["implementation_kzt"] else None
    hours_month = sum(x["hours"] for x in levers)
    return {
        "period": {"start": start, "end": end, "days": p["days"]},
        "losses": losses,
        "levers": levers,
        "gross_kzt_month": round(gross),
        "support_kzt_month": round(a["support_kzt_month"]),
        "net_kzt_month": round(net),
        "net_kzt_year": round(net * 12),
        "implementation_kzt": round(a["implementation_kzt"]),
        "payback_months": payback,
        "roi_year_pct": roi_pct,
        "hours_month": round(hours_month),
        "hours_year": round(hours_month * 12),
        "cars_month": round(sum(x.get("cars", 0) for x in levers), 1),
        "upside": {
            "note": "Если план месяца под угрозой и каждая потерянная минута — непроданный автомобиль",
            "gross_kzt_month": round(gross_margin),
            "net_kzt_month": round(net_margin),
            "payback_months": round(a["implementation_kzt"] / net_margin, 1) if net_margin > 0 else None,
        },
        "assumptions": [{"key": k2, "label": LABELS[k2], "value": a[k2], "default": DEFAULTS[k2]} for k2 in DEFAULTS],
        "basis": {
            "margin_per_car_kzt": margin,
            "rework_cost_kzt": rework,
            "cost_per_line_min_kzt": round(cost_min),
            "cost_per_line_min_margin_kzt": round(cost_min_margin),
            "line_staff": staff,
            "workdays_month": WORKDAYS,
        },
    }


def _lever(
    id_: str,
    title: str,
    formula: str,
    kzt: float,
    *,
    hours: float = 0.0,
    hours_note: str = "",
    margin_k: float = 1.0,
    cars: float = 0.0,
) -> dict:
    return {
        "id": id_,
        "title": title,
        "formula": formula.replace(".", ","),
        "kzt_month": round(kzt),
        "kzt_month_margin": round(kzt * margin_k),
        "kzt_year": round(kzt * 12),
        "hours": round(hours, 1),
        "hours_note": hours_note,
        "cars": round(cars, 1),
    }


def _m(v: float) -> str:
    a = abs(v)
    if a >= 1_000_000:
        return f"{a / 1e6:.1f} млн ₸"
    if a >= 10_000:
        return f"{round(a / 1000)} тыс ₸"
    return f"{round(a)} ₸"
