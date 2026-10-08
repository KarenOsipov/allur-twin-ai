from __future__ import annotations

import json
import random
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlalchemy import func, select

from app.db.base import Database
from app.db.models import (
    AuditEntry,
    BuilderLayout,
    DowntimeRecord,
    Incident,
    Meta,
    ProductionRecord,
    QualityRecord,
    ShiftSession,
)
from app.domain.plant import Plant

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
DAYS = 14

SUPERVISORS = {1: "Ерлан Жумабеков", 2: "Сергей Ковалёв"}
WORKERS = {
    "WELD": "Асель Нурланова",
    "PAINT": "Данияр Оспанов",
    "ASSY": "Тимур Беков",
    "QC": "Марат Ибраев",
    "WH_IN": "Бауыржан Сейтказы",
}
DIRECTOR = "Айгерим Касымова"
ADMIN = "Нуржан Ахметов"

FIXES = {
    "ошибка датчика": "Заменён датчик положения, проверена проводка",
    "сбой позиционирования": "Перекалиброван робот по реперным точкам",
    "износ электрода": "Заменены электроды, зачищены колпачки",
    "обрыв цепи": "Заменено звено цепи, отрегулирован натяжитель",
    "перегрев привода": "Очищен радиатор привода, заменён вентилятор",
    "заклинивание тележки": "Тележка снята, заменён подшипник ролика",
    "отклонение химсостава": "Скорректирован состав ванны, отобрана проба",
    "засор форсунок": "Форсунки прочищены и продуты",
    "сбой подачи краски": "Заменён фильтр насоса подачи краски",
    "отказ вентиляции": "Перезапущен вентилятор, заменён ремень",
    "неравномерный нагрев": "Отрегулированы горелки, проверены термопары",
    "отказ горелки": "Заменён электрод розжига горелки",
    "ошибка момента затяжки": "Перекалиброван шпиндель гайковёрта",
    "отказ контроллера": "Перезагружен и перепрошит контроллер",
    "утечка магистрали": "Заменён уплотнитель магистрали",
    "сбой дозатора": "Прочищен клапан дозатора",
    "калибровка": "Стенд откалиброван по эталону",
    "сбой роликов": "Заменена муфта ролика",
    "износ фиксаторов": "Заменены фиксаторы кондуктора",
}


def seed_demo(db: Database, plant: Plant, today: date, margin_per_car: int) -> bool:
    with db.session() as s:
        if s.get(Meta, "demo_seeded") is not None:
            return False
        s.add(Meta(key="demo_seeded", value=today.isoformat()))
    rng = random.Random(2026)
    _layouts(db)
    _history(db, plant, today, rng, margin_per_car)
    return True


def _layouts(db: Database) -> None:
    path = SEED_DIR / "layouts.json"
    if not path.exists():
        return
    items = json.loads(path.read_text(encoding="utf-8"))
    with db.session() as s:
        if (s.scalar(select(func.count(BuilderLayout.id))) or 0) > 0:
            return
        base = datetime.now().replace(second=0, microsecond=0)
        for i, it in enumerate(items):
            nodes = it["data"]["nodes"]
            s.add(
                BuilderLayout(
                    name=it["name"],
                    data=it["data"],
                    nodes=len(nodes),
                    equipment=sum(len(n["data"].get("equipment") or []) for n in nodes),
                    author="Айгерим Касымова" if i else "Нуржан Ахметов",
                    updated_at=base - timedelta(days=6 - i, hours=3 * i),
                )
            )


def _history(db: Database, plant: Plant, today: date, rng: random.Random, margin: int) -> None:
    start = today - timedelta(days=DAYS)
    takt_min = plant.takt_s / 60
    names = {a.code: a.name for a in plant.areas}
    journal: list[AuditEntry] = []

    def log(
        at: datetime,
        category: str,
        action: str,
        title: str,
        actor: str = "Система",
        severity: str = "info",
        details: dict | None = None,
    ) -> None:
        journal.append(
            AuditEntry(
                at=at,
                plant_time=at,
                category=category,
                action=action,
                severity=severity,
                actor=actor,
                title=title[:240],
                details=details or {},
            )
        )

    with db.session() as s:
        prod = list(
            s.scalars(select(ProductionRecord).where(ProductionRecord.day >= start, ProductionRecord.day < today))
        )
        qual = list(s.scalars(select(QualityRecord).where(QualityRecord.day >= start, QualityRecord.day < today)))
        downs = list(
            s.scalars(
                select(DowntimeRecord)
                .where(DowntimeRecord.day >= start, DowntimeRecord.day < today)
                .order_by(DowntimeRecord.day, DowntimeRecord.shift)
            )
        )
        out_by: dict[tuple, int] = {}
        for r in prod:
            if r.area == "ASSY":
                out_by[(r.day, r.shift)] = r.fact
        def_by: dict[tuple, list[int]] = {}
        for q in qual:
            x = def_by.setdefault((q.day, q.shift), [0, 0])
            x[0] += q.produced
            x[1] += q.defects
        down_by: dict[tuple, list[DowntimeRecord]] = {}
        for d in downs:
            down_by.setdefault((d.day, d.shift), []).append(d)

        log(
            datetime.combine(start, datetime.min.time()) + timedelta(hours=7, minutes=20),
            "data",
            "import",
            "Загружен файл allur_case2_data.docx: таблицы заказчика",
            ADMIN,
            details={"Таблицы": "Работа линий, Простои, План по моделям, Качество"},
        )

        day = start
        while day < today:
            if day.weekday() not in plant.workdays:
                day += timedelta(days=1)
                continue
            if rng.random() < 0.8:
                t = datetime.combine(day, plant.shifts[0].start) + timedelta(minutes=50 + rng.randint(0, 40))
                log(t, "auth", "login", f"Вход: {DIRECTOR} — директор по производству", DIRECTOR)
                if rng.random() < 0.5:
                    log(
                        t + timedelta(minutes=3),
                        "assistant",
                        "ask",
                        "Вопрос: Что сделать в первую очередь?",
                        DIRECTOR,
                        details={"Режим": "живой завод"},
                    )
            for sh in plant.shifts:
                key = (day, sh.number)
                if key not in out_by:
                    continue
                sup = SUPERVISORS[sh.number]
                t0 = datetime.combine(day, sh.start)
                t1 = t0 + timedelta(hours=sh.hours)
                staff = 56 + rng.randint(0, 6)
                incidents = down_by.get(key, [])
                produced, defects = def_by.get(key, [0, 0])
                cost_total = 0
                reports = 0
                log(t0 - timedelta(minutes=12), "auth", "login", f"Вход: {sup} — начальник смены", sup)
                log(
                    t0 - timedelta(minutes=8),
                    "shift",
                    "start",
                    f"Смена {sh.number} принята: {sup}",
                    sup,
                    details={"Людей на смене": staff, "План": plant.targets.shift_plan},
                )
                for d in incidents:
                    if d.equipment == "Поставка":
                        kind, worker = "supply", WORKERS["WH_IN"]
                    else:
                        kind, worker = "equipment", WORKERS.get(d.area)
                    at = d.started_at or (t0 + timedelta(minutes=rng.randint(25, int(sh.hours * 60) - 90)))
                    from_worker = d.planned is False and worker is not None and rng.random() < 0.75
                    lost = d.minutes / takt_min * (0.6 if not d.planned else 0)
                    cost = int(lost * margin) if not d.planned else 0
                    cost_total += cost
                    resolved = at + timedelta(minutes=d.minutes)
                    reason = d.reason
                    fix = FIXES.get(reason.lower(), "Неисправность устранена, оборудование проверено")
                    sev = "info" if d.planned else ("critical" if d.minutes >= 30 else "warning")
                    title = (
                        f"Поломка: {d.equipment} · линия стоит"
                        if from_worker and kind == "equipment"
                        else f"Нет комплектующих — {names['WH_IN'].lower()}"
                        if kind == "supply"
                        else f"{d.equipment}: {reason.lower()}"
                    )
                    inc = Incident(
                        created_at=at,
                        kind=kind,
                        severity=sev,
                        area=d.area,
                        equipment=None if kind == "supply" else d.equipment,
                        title=title[:200],
                        details=(
                            f"{reason}. "
                            + ("Сообщил оператор с участка." if from_worker else "Зафиксировано системой.")
                        ),
                        status="resolved",
                        acked_by=sup,
                        resolved_at=resolved,
                        downtime_min=round(d.minutes, 1),
                        cost_kzt=cost,
                        source="worker" if from_worker else "auto",
                        reported_by=worker if from_worker else None,
                        line_stopped=bool(from_worker and kind == "equipment"),
                        resolved_by=sup,
                        resolution=fix,
                    )
                    s.add(inc)
                    if from_worker:
                        reports += 1
                        log(
                            at,
                            "incident",
                            "reported",
                            f"Сообщение с участка «{names[d.area]}»: {reason.lower()}",
                            worker,
                            severity="critical" if inc.line_stopped else "warning",
                            details={"Оборудование": d.equipment, "Линия стоит": "да" if inc.line_stopped else "нет"},
                        )
                    else:
                        log(
                            at,
                            "incident",
                            "created",
                            f"{d.equipment}: {reason.lower()}",
                            severity="info" if d.planned else "warning",
                            details={"Участок": names[d.area], "Оборудование": d.equipment},
                        )
                    log(
                        at + timedelta(minutes=1 + rng.randint(0, 2)),
                        "incident",
                        "ack",
                        f"Принят в работу: {title}",
                        sup,
                    )
                    if from_worker and d.minutes >= 20:
                        log(
                            at + timedelta(minutes=2),
                            "incident",
                            "impact",
                            f"Экспресс-анализ: потеря ~{lost:.0f} авто ≈ {cost / 1e6:.1f} млн ₸".replace(".", ","),
                            sup,
                            details={"Простой, мин": round(d.minutes)},
                        )
                    log(
                        resolved,
                        "incident",
                        "resolved",
                        f"Закрыт: {title}",
                        sup,
                        details={"Простой, мин": round(d.minutes, 1), "Потери, ₸": cost, "Что сделано": fix},
                    )
                fin = out_by[key]
                summary = {
                    "finished": fin,
                    "plan": plant.targets.shift_plan,
                    "defect_pct": round(defects / produced * 100, 2) if produced else 0.0,
                    "rework": defects,
                    "down_min": round(sum(d.minutes for d in incidents if not d.planned)),
                    "incidents": len(incidents),
                    "reports": reports,
                    "cost_kzt": cost_total,
                    "closed_by": sup,
                }
                notes = []
                if fin < plant.targets.shift_plan * 0.95:
                    notes.append(f"Недовыпуск {plant.targets.shift_plan - fin} авто")
                if incidents:
                    notes.append(f"простоев: {len(incidents)}")
                s.add(
                    ShiftSession(
                        day=day,
                        shift=sh.number,
                        supervisor=sup,
                        started_at=t0 - timedelta(minutes=8),
                        closed_at=t1 - timedelta(minutes=5),
                        plan=plant.targets.shift_plan,
                        staff=staff,
                        note="; ".join(notes).capitalize(),
                        summary=summary,
                    )
                )
                log(
                    t1 - timedelta(minutes=5),
                    "shift",
                    "closed",
                    f"Смена {sh.number} сдана: выпущено {fin} из {plant.targets.shift_plan}",
                    sup,
                    severity="warning" if fin < plant.targets.shift_plan * 0.95 else "info",
                    details={"Брак, %": summary["defect_pct"], "Простой, мин": summary["down_min"]},
                )
                log(t1 - timedelta(minutes=3), "export", "pdf", "Документ «Сменный отчёт» (PDF)", sup)
            day += timedelta(days=1)
        last = today - timedelta(days=3)
        log(
            datetime.combine(last, datetime.min.time()) + timedelta(hours=10, minutes=12),
            "data",
            "economics",
            "Изменены экономические допущения",
            ADMIN,
            details={"Маржа с автомобиля, ₸": margin},
        )
        log(
            datetime.combine(last, datetime.min.time()) + timedelta(hours=10, minutes=40),
            "scenario",
            "run",
            "Сценарий «решения на завтра» прогнан",
            DIRECTOR,
            details={"Цикл": "PAINT ×0,96", "Эффект, авто": 4.2},
        )
        s.add_all(journal)
