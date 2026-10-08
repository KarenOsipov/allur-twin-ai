from __future__ import annotations

from dataclasses import asdict
from datetime import date, datetime

from app.services.excel import Sheet

STATE = {
    "run": "Работает",
    "starved": "Ждёт кузов",
    "blocked": "Буфер полон",
    "down": "Стоит",
    "off": "Не работает",
    "idle": "Ожидает",
    "maint": "Обслуживание",
}
INC_STATUS = {"open": "Открыт", "ack": "В работе", "resolved": "Закрыт"}
INC_SEV = {"critical": "Авария", "warning": "Отклонение", "info": "Информация"}
KIND = {"equipment": "Оборудование", "quality": "Качество", "supply": "Поставки", "kpi": "План"}
PRIORITY = {"critical": "Срочно", "high": "Важно", "medium": "Желательно"}
LEVEL = {"high": "высокий", "medium": "средний", "low": "низкий"}
TITLES = {
    "floor": "Цех",
    "kpi": "Показатели",
    "quality": "Качество",
    "forecast": "Прогноз и риски",
    "sim": "Симуляция",
    "incidents": "Инциденты",
    "data": "Данные",
    "ai": "ИИ-анализ",
}


def _d(v):
    if isinstance(v, str) and len(v) in (10, 19) and v[4:5] == "-":
        try:
            return datetime.fromisoformat(v) if len(v) == 19 else date.fromisoformat(v)
        except ValueError:
            return v
    return v


def kv(title: str, pairs: list[tuple[str, object]], note: str | None = None) -> Sheet:
    return Sheet(title, ["Показатель", "Значение"], [[k, v] for k, v in pairs], note)


def floor_sheets(snap: dict, forecast: dict | None) -> list[Sheet]:
    if not snap.get("ready"):
        return [kv("Цех", [("Состояние", "Модель цеха ещё не готова")])]
    k = snap["kpi"]
    sheets = [
        kv(
            "Смена",
            [
                ("Время цеха", snap["clock"]),
                ("Смена", snap["shift"]["number"] or "вне смены"),
                ("Выпущено", k["finished"]),
                ("План смены", k["shift_plan"]),
                ("План к этому часу", k["plan_to_now"]),
                ("Брак в смене, %", k["defect_pct"]),
                ("На переделку", k["rework"]),
                ("Оборудования в отказе", k["down_now"]),
                ("Узкое место сейчас", k["bottleneck"] or "—"),
                ("Комплектов на складе", snap.get("kits")),
            ],
        ),
        Sheet(
            "Участки",
            [
                "Участок",
                "Состояние",
                "Выпуск",
                "Брак",
                "OEE, %",
                "В буфере",
                "Ёмкость буфера",
                "Работа, мин",
                "Простой, мин",
                "Ждал кузов, мин",
                "Буфер полон, мин",
                "Склад",
            ],
            [
                [
                    a["name"],
                    STATE.get(a.get("state") or "", "—"),
                    a.get("output"),
                    a.get("defects"),
                    a.get("oee"),
                    len(a.get("buffer") or []),
                    a.get("buffer_cap"),
                    (a.get("time") or {}).get("run"),
                    (a.get("time") or {}).get("down"),
                    (a.get("time") or {}).get("starved"),
                    (a.get("time") or {}).get("blocked"),
                    a.get("stock"),
                ]
                for a in snap["areas"]
            ],
        ),
        Sheet(
            "Оборудование",
            ["Код", "Участок", "Состояние", "Причина", "С", "До", "Критичное"],
            [
                [
                    e["code"],
                    e["area"],
                    STATE.get(e["status"], e["status"]),
                    e["reason"],
                    e["since"],
                    e["until"],
                    e["critical"],
                ]
                for e in snap["equipment"]
            ],
        ),
        Sheet(
            "Сошли с линии",
            ["VIN", "Модель", "Время"],
            [[r["vin"], r["model"], r["at"]] for r in snap.get("recent", [])],
        ),
        Sheet("Выпуск по моделям", ["Модель", "Авто за смену"], [[m, v] for m, v in k["models"].items()]),
    ]
    if forecast and forecast.get("available"):
        sheets.append(
            Sheet(
                "Прогноз до конца смены",
                ["Время", "Ожидаемо", "Минимум", "Максимум"],
                [[p["t"], p["mean"], p["low"], p["high"]] for p in forecast["timeline"]],
                note=(
                    f"Ожидается {forecast['expected']} (от {forecast['low']} до {forecast['high']}), "
                    f"вероятность плана {forecast['probability']}%"
                ),
            )
        )
    return sheets


def sim_sheets(result: dict) -> list[Sheet]:
    sm = result["summary"]
    return [
        kv(
            "Итог симуляции",
            [
                ("Окно", f"{result['start']:%d.%m %H:%M} – {result['end']:%d.%m %H:%M}"),
                ("Вывод", sm["verdict"]),
                ("Без событий, авто (среднее)", sm["mean"]["baseline"]),
                ("С событиями, авто (среднее)", sm["mean"]["scenario"]),
                ("Потеря, авто", sm["mean"]["lost"]),
                ("Потеря: от", sm["mean"]["lost_low"]),
                ("Потеря: до", sm["mean"]["lost_high"]),
                ("Цена, ₸", sm["money_kzt"]),
                ("План окна, авто", sm["plan"]["cars"]),
                (
                    "Простой критичного, мин: без / с событиями",
                    f"{sm['downtime_min']['baseline']} / {sm['downtime_min']['scenario']}",
                ),
                ("Брак: без / с событиями", f"{sm['defects']['baseline']} / {sm['defects']['scenario']}"),
                ("Прогонов", sm["mean"]["runs"]),
            ],
        ),
        Sheet("Введённые события", ["Событие"], [[a["title"]] for a in result["actions"]]),
        Sheet(
            "Хронология",
            ["Время", "Событие", "Участок", "Введено вами"],
            [[e["t"], e["title"], e["area"], e["user"]] for e in result["log"]],
        ),
        Sheet(
            "Выпуск по времени",
            ["Время", "Без событий", "С событиями (повтор)"],
            [
                [b["t"], b["cars"], s["cars"]]
                for b, s in zip(result["series"]["baseline"], result["series"]["scenario"], strict=False)
            ],
        ),
    ]


def kpi_sheets(o: dict) -> list[Sheet]:
    p = o["period"]
    sheets = [
        Sheet(
            "Цели",
            ["Показатель", "Значение", "Цель", "Статус"],
            [
                [
                    c["label"],
                    c["value"],
                    f"{c['op']} {c['target']} {c['unit']}",
                    {"ok": "выполнена", "warning": "у границы", "critical": "не выполнена"}[c["status"]],
                ]
                for c in p["checks"]
            ],
            note=(
                f"Период {p['start']} — {p['end']}: выпуск {p['output']} из {p['plan']} ({p['plan_pct']}%), "
                f"OEE {p['oee']}%, брак {p['defect_pct']}%"
            ),
        ),
        Sheet(
            "По суткам",
            ["День", "Выпуск", "План", "OEE, %", "Простой, мин", "Брак сварки, %", "Брак окраски, %", "Брак сборки, %"],
            [
                [
                    _d(d["day"]),
                    d["output"],
                    d["plan"],
                    d["oee"],
                    d["downtime_min"],
                    d["defect_pct"].get("WELD"),
                    d["defect_pct"].get("PAINT"),
                    d["defect_pct"].get("ASSY"),
                ]
                for d in o["daily"]
            ],
        ),
        Sheet(
            "Линии",
            [
                "Линия",
                "План",
                "Факт",
                "Доступность, %",
                "Производительность, %",
                "Качество, %",
                "OEE, %",
                "Брак, %",
                "Часы работы",
            ],
            [
                [
                    x["line"],
                    x["plan"],
                    x["fact"],
                    x["availability"],
                    x["performance"],
                    x["quality"],
                    x["oee"],
                    x["defect_pct"],
                    x["run_hours"],
                ]
                for x in p["lines"]
            ],
        ),
        Sheet(
            "Простои по причинам",
            ["Причина", "Минут", "Случаев", "Доля, %", "Накопительно, %", "Плановый", "Оборудование"],
            [
                [r["key"], r["minutes"], r["count"], r["share"], r["cumulative"], r["planned"], r["equipment"]]
                for r in o["pareto_reason"]
            ],
        ),
        Sheet(
            "Простои по оборудованию",
            ["Оборудование", "Минут", "Случаев", "Доля, %", "Накопительно, %"],
            [[r["key"], r["minutes"], r["count"], r["share"], r["cumulative"]] for r in o["pareto_equipment"]],
        ),
        Sheet(
            "План по моделям",
            ["Модель", "План месяца", "Факт"],
            [[m["model"], m["plan"], m["fact"]] for m in o["month"]["models"]],
        ),
    ]
    return sheets


def quality_sheets(qs: list[dict]) -> list[Sheet]:
    days = sorted({p["day"] for q in qs for p in q["series"]})
    by = {q["area"]: {p["day"]: p["pct"] for p in q["series"]} for q in qs}
    return [
        Sheet(
            "Участки",
            [
                "Участок",
                "Уровень по тренду, %",
                "Последний день, %",
                "Изменение за неделю, п.п.",
                "Прогноз через 7 дней, %",
                "Норма, %",
                "Дней выше нормы подряд",
            ],
            [
                [q["name"], q["level"], q["last"], q["slope_week"], q["forecast_7"], q["target"], q["days_over"]]
                for q in qs
            ],
        ),
        Sheet(
            "Брак по дням",
            ["День", *[q["name"] for q in qs]],
            [[_d(d), *[by[q["area"]].get(d) for q in qs]] for d in days],
        ),
        Sheet(
            "Причины",
            ["Участок", "Что показал разбор", "Сила связи"],
            [[q["name"], c["text"], c["strength"]] for q in qs for c in q["causes"]],
        ),
    ]


def forecast_sheets(ins: dict) -> list[Sheet]:
    f = ins["forecast"]
    sheets = [
        Sheet(
            "Рекомендации",
            ["#", "Приоритет", "Что", "Проблема", "Действие", "Эффект, ₸/мес"],
            [
                [
                    i,
                    PRIORITY.get(r["priority"], r["priority"]),
                    r["title"],
                    r["problem"],
                    r["action"],
                    r["effect_kzt_month"],
                ]
                for i, r in enumerate(ins["recommendations"], 1)
            ],
        ),
    ]
    if f.get("available"):
        sheets.append(
            Sheet(
                "План месяца",
                ["День", "Факт нараст.", "Прогноз", "Нижняя граница", "Верхняя граница"],
                [[_d(p["day"]), p.get("fact"), p.get("forecast"), p.get("low"), p.get("high")] for p in f["series"]],
                note=(
                    f"Прогноз {f['expected']} из {f['target']} (P10 {f['p10']} — P90 {f['p90']}), "
                    f"вероятность {f['probability']}%"
                ),
            )
        )
    sheets += [
        Sheet(
            "Риск отказа (7 дней)",
            [
                "Оборудование",
                "Участок",
                "Вероятность, %",
                "Уровень",
                "Следующий отказ",
                "Главная причина",
                "Отказов за 90 дней",
                "Потери, ₸/нед",
                "Почему",
            ],
            [
                [
                    r["code"],
                    r["area"],
                    round(r["probability"] * 100),
                    LEVEL[r["level"]],
                    _d(r["next_failure"]) if r["next_failure"] else ("уже ожидался" if r["overdue"] else "—"),
                    r["main_reason"],
                    r["failures_90"],
                    r["expected_loss_kzt"],
                    r["factors"],
                ]
                for r in ins["risks"]
            ],
        ),
        Sheet(
            "Узкое место",
            ["Линия", "Годная мощность, авт/смену", "Ограничивала выпуск, % смен", "Цикл, с", "Такт, с"],
            [
                [x["name"], x["good_capacity_per_shift"], round(x["share"] * 100), x["cycle_s"], x["takt_s"]]
                for x in ins["bottleneck"]["lines"]
            ],
        ),
        Sheet(
            "Необычные смены",
            ["День", "Смена", "Выпуск", "Чем отличается", "События"],
            [[_d(a["day"]), a["shift"], a["output"], a["drivers"], a["events"]] for a in ins["anomalies"]],
        ),
    ]
    return sheets


def incident_sheets(data: dict) -> list[Sheet]:
    return [
        Sheet(
            "Инциденты",
            [
                "Время",
                "Важность",
                "Тип",
                "Участок",
                "Оборудование",
                "Что",
                "Подробности",
                "Статус",
                "Принял",
                "Закрыт",
                "Простой, мин",
                "Потери, ₸",
            ],
            [
                [
                    i["created_at"],
                    INC_SEV.get(i["severity"], i["severity"]),
                    KIND.get(i["kind"], i["kind"]),
                    i["area"],
                    i["equipment"],
                    i["title"],
                    i["details"],
                    INC_STATUS[i["status"]],
                    i["acked_by"],
                    i["resolved_at"],
                    i["downtime_min"],
                    i["cost_kzt"],
                ]
                for i in data["items"]
            ],
            note="Журнал симуляции" if data.get("simulated") else None,
        )
    ]


def data_sheets(ds, checks: list[dict]) -> list[Sheet]:
    def table(title: str, rows: list, skip=("id",)) -> Sheet:
        if not rows:
            return Sheet(title, ["—"], [])
        cols = [c.name for c in rows[0].__table__.columns if c.name not in skip]
        return Sheet(title, cols, [[getattr(r, c) for c in cols] for r in rows])

    return [
        Sheet(
            "Проверки", ["Тип", "Что", "Подробности"], [[c.get("level"), c.get("title"), c.get("text")] for c in checks]
        ),
        table("Работа линий", ds.production),
        table("Качество", ds.quality),
        table("Простои", ds.downtime),
        table("План по моделям", ds.model_plan),
    ]


def ai_sheets(report_text: str, ins: dict) -> list[Sheet]:
    lines = [ln.replace("**", "").strip() for ln in report_text.split("\n") if ln.strip()]
    return [
        Sheet("Разбор", ["Текст"], [[ln] for ln in lines]),
        Sheet(
            "Риски",
            ["Оборудование", "Вероятность, %", "Причина"],
            [[r["code"], round(r["probability"] * 100), r["main_reason"]] for r in ins["risks"] if r["level"] != "low"],
        ),
        Sheet(
            "Что сделать",
            ["#", "Что", "Эффект, ₸/мес"],
            [[i, r["title"], r["effect_kzt_month"]] for i, r in enumerate(ins["recommendations"], 1)],
        ),
    ]


def risks_as_dicts(risks) -> list[dict]:
    return [asdict(r) for r in risks]
