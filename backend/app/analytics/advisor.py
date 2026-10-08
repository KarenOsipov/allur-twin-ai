from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date

from app.analytics.risk import EquipmentRisk
from app.core.text import ru
from app.domain.plant import Plant


@dataclass
class Recommendation:
    id: str
    priority: str
    title: str
    problem: str
    action: str
    effect_kzt_month: int
    area: str | None = None
    equipment: str | None = None
    link: str | None = None

    def as_dict(self) -> dict:
        d = asdict(self)
        for k in ("title", "problem", "action"):
            d[k] = ru(d[k])
        return d


def recommendations(
    plant: Plant,
    today: date,
    risks: list[EquipmentRisk],
    quality: list[dict],
    bottleneck: dict,
    forecast: dict,
    checks: list[dict],
    margin_per_car: int,
    rework_cost: int,
) -> list[Recommendation]:
    out: list[Recommendation] = []
    t = plant.targets
    daily_volume = t.shift_plan * len(plant.shifts)
    workdays = 26
    cars_per_min = 60 / plant.takt_s

    for q in quality:
        if q["status"] == "ok":
            continue
        excess = max(0.0, q["level"] - t.defect_pct) / 100
        monthly_defects = excess * daily_volume * workdays
        cause = q["causes"][0]["text"] if q["causes"] else "Причина не выявлена — нужен разбор на месте"
        eq_cause = next(
            (c for c in q["causes"] if c.get("equipment") and c["kind"] == "equipment"),
            None,
        )
        action = (
            "Остановить рост брака: проверить вентиляцию и подачу краски Камеры-02, режим нагрева Печи-01; "
            "ввести контроль толщины ЛКП каждого 10-го кузова. Замена фильтров чаще не поможет."
            if q["area"] == "PAINT"
            else "Провести разбор причин брака на участке, проверить оснастку и режимы."
        )
        if eq_cause:
            action += f" Отдельно — {eq_cause['equipment']}: после его отказов брак растёт."
        out.append(
            Recommendation(
                id=f"quality-{q['area']}",
                priority="critical" if q["status"] == "critical" else "high",
                title=f"{q['name']}: брак {q['level']:.1f}% при норме {t.defect_pct:.0f}%",
                problem=f"{cause}. Выше нормы {q['days_over']} дн. подряд, тренд {q['slope_week']:+.2f} п.п. в неделю.",
                action=action,
                effect_kzt_month=round(monthly_defects * rework_cost),
                area=q["area"],
                link="/app/quality",
            )
        )

    risky = sorted((r for r in risks if r.level == "high" and r.critical), key=lambda r: -r.expected_loss_kzt)[:2]
    for r in risky:
        days = (r.next_failure - today).days if r.next_failure else None
        when = (
            f"около {r.next_failure:%d.%m}" if r.next_failure and days is not None and days >= 0 else "в любой момент"
        )
        lost_cars = (r.mttr_min or 30) * cars_per_min
        iv = r.intervals[-3:]
        per_month = 30 / max(sum(iv) / len(iv), 1) if iv else 1
        effect = round(lost_cars * margin_per_car * per_month)
        reason = (r.main_reason or "отказ").lower()
        out.append(
            Recommendation(
                id=f"risk-{r.code}",
                priority="critical" if days is not None and days <= 2 else "high",
                title=f"{r.code}: риск отказа {round(r.probability * 100)}% за 7 дней",
                problem=f"{'; '.join(r.factors[:2])}. Главная причина — «{reason}», "
                f"в среднем {round(r.mttr_min or 0)} мин простоя.",
                action=(
                    f"Заменить цепь {r.code} в плановое окно {when}: 40 минут ночью вместо "
                    f"~{round(r.mttr_min or 0)} минут аварийного простоя днём. Затем проверить натяжитель и звёздочки."
                    if "цеп" in reason
                    else f"Запланировать обслуживание {r.code} {when}, держать запчасти на участке."
                ),
                effect_kzt_month=effect,
                area=r.area,
                equipment=r.code,
                link="/app/forecast",
            )
        )

    constraint = next((x for x in bottleneck["lines"] if x["area"] == bottleneck["constraint"]), None)
    if constraint and constraint["share"] >= 50:
        others = [x["good_capacity_per_shift"] for x in bottleneck["lines"] if x["area"] != constraint["area"]]
        gain = max(0.0, min(others) - constraint["good_capacity_per_shift"]) if others else 0.0
        out.append(
            Recommendation(
                id="bottleneck",
                priority="high",
                title=f"Узкое место — {constraint['name'].lower()} ({constraint['share']}% смен)",
                problem=f"Годная мощность {constraint['good_capacity_per_shift']} авт./смену — меньше, чем у соседних "
                f"линий. Каждая минута простоя этого участка — минута простоя всего завода.",
                action=f"Защитить узкое место ({constraint['name'].lower()}): обед и пересменка со скользящим "
                "графиком, буфер перед ним не опустошать, ремонты здесь — в первую очередь. "
                + (
                    "Проверьте сценарий «Ускорить окраску на 4%»."
                    if constraint["area"] == "PAINT"
                    else "Проверьте ускорение участка в сценариях."
                ),
                effect_kzt_month=round(gain * len(plant.shifts) * workdays * margin_per_car),
                area=constraint["area"],
                link="/app/scenarios",
            )
        )

    for c in checks:
        if c["level"] == "critical" and "модел" in c["title"]:
            out.append(
                Recommendation(
                    id="model-plan",
                    priority="high",
                    title="Распределить остаток месячного плана по моделям",
                    problem=c["text"],
                    action="Согласовать с отделом планирования распределение по моделям и заказ комплектов. "
                    "Без этого линия будет недогружена в конце месяца.",
                    effect_kzt_month=0,
                    link="/app/data",
                )
            )
    if forecast.get("available") and forecast["probability"] < 70:
        gap = -forecast["gap"]
        out.append(
            Recommendation(
                id="month-plan",
                priority="critical" if forecast["probability"] < 40 else "high",
                title=f"Риск невыполнения плана месяца: {forecast['probability']}%",
                problem=f"Прогноз {forecast['expected']} при плане {forecast['target']}, не хватает ~{gap}.",
                action=f"Нужен темп {forecast['need_daily'] if forecast['need_daily'] is not None else '—'} авт./сутки "
                f"вместо {forecast['daily_rate']}. "
                "Оцените сверхурочные в сценариях.",
                effect_kzt_month=round(max(gap, 0) * margin_per_car),
                link="/app/forecast",
            )
        )

    order = {"critical": 0, "high": 1, "medium": 2}
    out.sort(key=lambda r: (order[r.priority], -r.effect_kzt_month))
    return out
