from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta

from app.reports.pages import INC_SEV, INC_STATUS, KIND, LEVEL, PRIORITY, STATE
from app.reports.pdf import (
    Bullets,
    Callout,
    Chart,
    Doc,
    Heading,
    Kpi,
    Kpis,
    Pairs,
    Section,
    Steps,
    Table,
    Text,
    money,
)

KIND.update({"safety": "Безопасность", "other": "Другое"})


@dataclass
class Ctx:
    c: object
    author: str
    position: str
    sandbox: object | None = None
    days: int = 7
    note: str | None = None

    @property
    def now(self) -> datetime:
        return self.c.live.clock


def _doc(ctx: Ctx, title: str, subtitle: str, code: str, meta=None) -> Doc:
    m = list(meta or [])
    m.append(("Режим", "симуляция «что если»" if ctx.sandbox else "живой завод"))
    if ctx.note:
        m.append(("Комментарий", ctx.note))
    return Doc(
        title=title, subtitle=subtitle, code=code, author=ctx.author, position=ctx.position, meta=m, created=ctx.now
    )


def _n(v, digits: int = 1) -> str:
    if v is None:
        return "—"
    if isinstance(v, float) and abs(v - round(v)) > 1e-9:
        return f"{v:,.{digits}f}".replace(",", " ").replace(".", ",")
    return f"{round(v):,}".replace(",", " ")


def _pct(v) -> str:
    return "—" if v is None else f"{_n(float(v))}%"


def _area_names(c) -> dict[str, str]:
    return {a.code: a.name for a in c.plant.areas}


def _advice_steps(c, limit: int = 4) -> list:
    adv = c.advice.get(wait=True, timeout=25)
    items = [x for x in adv["items"] if x["worth_it"]][:limit]
    if not items:
        return (
            [Text("Рекомендации ещё рассчитываются на модели линии — они появятся в следующем документе.", muted=True)]
            if adv["status"] != "ready"
            else []
        )
    return [
        Heading(
            "Что сделать — и что это даст",
            "Каждое действие проверено на модели линии: рабочий день, 6 прогонов, "
            "разница с базовым днём. Чистый эффект — за вычетом стоимости действия.",
        ),
        Steps(
            [
                (
                    x["title"],
                    x["why"],
                    f"{x['result']}; затраты: {x['cost_note'] or 'нет'}; чистый эффект "
                    f"{money(x['net_kzt_month'])} в месяц"
                    + (f"; окупаемость {_n(x['payback_months'])} мес" if x.get("payback_months") else ""),
                )
                for x in items
            ]
        ),
    ]


def floor_doc(ctx: Ctx, forecast: dict | None) -> Doc:
    c = ctx.c
    snap = c.live.snapshot()
    names = _area_names(c)
    if not snap.get("ready"):
        d = _doc(ctx, "Сменный отчёт", "Модель цеха ещё не готова", "SR")
        d.blocks = [Callout("Нет данных", "Модель цеха запускается. Повторите через минуту.", "warn")]
        return d
    cur = c.shifts.current(snap)
    sess = cur.get("session")
    k = snap["kpi"]
    sh = snap["shift"]
    if snap["working"]:
        sub = (
            f"Смена {sh['number']} · {sh['start']:%d.%m.%Y} · {sh['start']:%H:%M}–{sh['end']:%H:%M} · "
            f"на {snap['clock']:%H:%M}"
        )
    else:
        sub = f"Вне смены · {snap['clock']:%d.%m.%Y %H:%M}"
    meta = [("Начальник смены", sess["supervisor"] if sess else "смена не принята")]
    if sess and sess.get("staff"):
        meta.append(("Людей на смене", str(sess["staff"])))
    ready = c.shifts.readiness(snap) if sess and not sess.get("closed_at") else None
    if ready and ready.get("total"):
        meta.append(
            (
                "Готовность людей",
                f"готовы {ready['ready']} из {ready['total']}"
                + (f", не выйдут {ready['absent']}" if ready["absent"] else "")
                + (f", не ответили {ready['pending']}" if ready["pending"] else ""),
            )
        )
    d = _doc(ctx, "Сменный отчёт", sub, "SR", meta)
    behind = k["finished"] - k["plan_to_now"]
    tiles = [
        Kpi(
            "Выпущено автомобилей",
            _n(k["finished"]),
            f"план к этому часу {k['plan_to_now']} · {'+' if behind >= 0 else '−'}{abs(behind)}",
            "ok" if behind >= 0 else "bad",
        ),
    ]
    if forecast and forecast.get("available"):
        tiles.append(
            Kpi(
                "Прогноз к концу смены",
                _n(forecast["expected"]),
                f"план {forecast['plan']} · вероятность {forecast['probability']}%",
                "ok" if forecast["probability"] >= 70 else "warn" if forecast["probability"] >= 30 else "bad",
            )
        )
    tiles += [
        Kpi(
            "Брак в смене",
            _pct(k["defect_pct"]),
            f"норма ≤ {_n(c.plant.targets.defect_pct)}%",
            "bad" if k["defect_pct"] > c.plant.targets.defect_pct else "ok",
        ),
        Kpi("Оборудование в отказе", _n(k["down_now"]), "сейчас", "bad" if k["down_now"] else "ok"),
    ]
    d.blocks.append(Heading("Главное за смену"))
    d.blocks.append(Kpis(tiles))
    if ready and (ready.get("absent") or ready.get("pending")):
        out = [f"{p['name']} ({p['note']})" for p in ready["people"] if p["status"] == "absent"]
        wait = [p["name"] for p in ready["people"] if p["status"] == "pending"]
        d.blocks.append(
            Callout(
                f"Готовность людей: {ready['ready']} из {ready['total']}",
                (f"Не выйдут: {'; '.join(out)}. " if out else "")
                + (f"Не подтвердили: {', '.join(wait)}." if wait else ""),
                "warn",
            )
        )
    if k.get("bottleneck"):
        d.blocks.append(
            Callout(
                f"Ограничивает выпуск: {names.get(k['bottleneck'], k['bottleneck']).lower()}",
                "Участок дольше всех работает без пауз — каждая его минута простоя теряет выпуск "
                "всего завода. Ремонты и обеды здесь — в первую очередь.",
                "warn",
            )
        )
    if forecast and forecast.get("available") and forecast.get("timeline"):
        tl = forecast["timeline"]
        d.blocks += [
            Heading(
                "Прогноз до конца смены",
                f"Копия линии проматывается вперёд {forecast['runs']} раз. "
                f"Ожидается {forecast['expected']} (от {forecast['low']} до {forecast['high']}).",
            ),
            Chart(
                "line",
                [p["t"].strftime("%H:%M") for p in tl],
                [("Ожидаемый выпуск", [p["mean"] for p in tl]), ("Нижняя граница", [p["low"] for p in tl])],
                target=forecast["plan"],
                target_label=f"план {forecast['plan']}",
                unit="автомобилей нарастающим итогом",
            ),
        ]
    d.blocks += [
        Heading("Участки"),
        Table(
            [
                "Участок",
                "Состояние",
                "Выпуск",
                "Брак",
                "OEE, %",
                "Работа, мин",
                "Простой, мин",
                "Ждал, мин",
                "Буфер полон, мин",
            ],
            [
                [
                    a["name"],
                    STATE.get(a.get("state") or "", "склад"),
                    a.get("output", a.get("stock")),
                    a.get("defects"),
                    a.get("oee"),
                    (a.get("time") or {}).get("run"),
                    (a.get("time") or {}).get("down"),
                    (a.get("time") or {}).get("starved"),
                    (a.get("time") or {}).get("blocked"),
                ]
                for a in snap["areas"]
            ],
            widths=[2.2, 1.4, 1, 0.8, 0.9, 1, 1, 0.9, 1.1],
            tones=["bad" if a.get("state") == "down" else None for a in snap["areas"]],
        ),
    ]
    down = [e for e in snap["equipment"] if e["status"] in ("down", "maint")]
    if down:
        d.blocks += [
            Heading("Оборудование, которое стоит сейчас"),
            Table(
                ["Оборудование", "Участок", "Причина", "С", "Ожидается до"],
                [[e["code"], names.get(e["area"]), e["reason"], e["since"], e["until"]] for e in down],
                widths=[1.4, 1.4, 2.4, 1.2, 1.2],
                tones=["bad"] * len(down),
            ),
        ]
    since = sh["start"] if snap["working"] else snap["clock"] - timedelta(hours=8)
    incs = [i for i in c.incidents.list(None, None, 200, 0)["items"] if i["created_at"] >= since]
    d.blocks.append(
        Heading(
            "Инциденты смены",
            f"{len(incs)} шт. · сообщений с участков: {sum(1 for i in incs if i.get('source') == 'worker')}",
        )
    )
    d.blocks.append(_incident_table(incs, names))
    d.blocks += _advice_steps(c, 3)
    keep = {"incident", "shift", "control", "data", "scenario", "simulation"}
    jr = [e for e in c.audit.query(since=since, limit=200)["items"] if e["category"] in keep][:40]
    if jr:
        d.blocks += [
            Heading("Хронология действий за смену"),
            Table(
                ["Время", "Кто", "Событие"],
                [[e["at"].strftime("%H:%M"), e["actor"], e["title"]] for e in reversed(jr)],
                widths=[0.7, 1.8, 5],
                align=["l", "l", "l"],
            ),
        ]
    d.signatures = [
        ("Начальник смены", sess["supervisor"] if sess else ctx.author),
        ("Принял смену", ""),
        ("Руководитель производства", ""),
    ]
    return d


def _incident_table(incs: list[dict], names: dict) -> Table:
    return Table(
        ["Время", "Что", "Участок", "Сообщил", "Статус", "Мин", "Потери"],
        [
            [
                i["created_at"].strftime("%d.%m %H:%M"),
                i["title"],
                names.get(i["area"] or "", "—"),
                i.get("reported_by") or "система",
                INC_STATUS.get(i["status"], i["status"]),
                i.get("downtime_min"),
                money(i["cost_kzt"]) if i.get("cost_kzt") else "—",
            ]
            for i in incs
        ],
        widths=[1.1, 3, 1.3, 1.6, 0.9, 0.9, 1.1],
        align=["l", "l", "l", "l", "l", "r", "r"],
        tones=["bad" if i["severity"] == "critical" and i["status"] != "resolved" else None for i in incs],
        max_rows=120,
    )


def _period_pairs(p: dict, prev: dict) -> list[tuple[str, str]]:
    ok = prev.get("available", True)

    def was(v: str) -> str:
        return f" (прошлый период {v})" if ok else ""

    return [
        ("Выпуск за период", f"{_n(p['output'])} из {_n(p['plan'])} ({_n(p['plan_pct'])}%)"),
        ("OEE", f"{_n(p['oee'])}%" + was(f"{_n(prev['oee'])}%")),
        ("Брак", f"{_n(p['defect_pct'])}%" + was(f"{_n(prev['defect_pct'])}%")),
        (
            "Внеплановый простой",
            f"{_n(p['downtime_unplanned_min'])} мин" + was(f"{_n(prev['downtime_unplanned_min'])} мин"),
        ),
        *([] if ok else [("Сравнение с прошлым периодом", "нет: для прошлого периода не хватает данных")]),
    ]


def kpi_doc(ctx: Ctx) -> Doc:
    c = ctx.c
    a = ctx.sandbox.analytics if ctx.sandbox else c.analytics
    o = a.overview(ctx.days)
    p = o["period"]
    d = _doc(
        ctx,
        "Отчёт о показателях производства",
        f"Период {p['start']:%d.%m.%Y} — {p['end']:%d.%m.%Y} · {p['days']} раб. дн. · сравнение с прошлым периодом",
        "KP",
    )
    tone = {"ok": "ok", "warning": "warn", "critical": "bad"}
    d.blocks += [
        Heading("Цели заказчика"),
        Kpis(
            [
                Kpi(
                    x["label"],
                    f"{_n(x['value'])}{x['unit'].strip() if x['unit'].strip() == '%' else ''}",
                    f"цель {x['op']} {_n(x['target'])}{x['unit']} · "
                    f"{ {'ok': 'выполнена', 'warning': 'у границы', 'critical': 'не выполнена'}[x['status']] }",
                    tone[x["status"]],
                )
                for x in p["checks"]
            ]
        ),
        Pairs(_period_pairs(p, o["previous"])),
    ]
    daily = o["daily"]
    if daily:
        d.blocks += [
            Heading("Выпуск по суткам", "Факт сборки против суточного плана"),
            Chart(
                "bar",
                [_dm(x["day"]) for x in daily],
                [("Выпуск", [x["output"] for x in daily])],
                target=daily[0]["plan"],
                target_label=f"план {daily[0]['plan']}",
                unit="автомобилей в сутки",
            ),
            Heading("OEE линий по суткам"),
            Chart(
                "line",
                [_dm(x["day"]) for x in daily],
                [("OEE, %", [x["oee"] for x in daily])],
                target=c.plant.targets.oee_pct,
                target_label=f"цель {_n(c.plant.targets.oee_pct)}%",
            ),
        ]
    d.blocks += [
        Heading("Линии: из чего складывается OEE", "OEE = доступность × производительность × качество"),
        Table(
            ["Линия", "План", "Факт", "Доступность, %", "Производит., %", "Качество, %", "OEE, %", "Брак, %"],
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
                ]
                for x in p["lines"]
            ],
            widths=[1.6, 1, 1, 1.2, 1.2, 1.1, 1, 0.9],
        ),
        Heading("Куда уходит время: простои по причинам"),
        Table(
            ["Причина", "Минут", "Случаев", "Доля, %", "Накопительно, %", "Плановый"],
            [
                [r["key"], r["minutes"], r["count"], r["share"], r["cumulative"], r["planned"]]
                for r in o["pareto_reason"][:12]
            ],
            widths=[3, 1, 1, 1, 1.3, 1],
        ),
        Heading("План месяца по моделям"),
        Table(
            ["Модель", "План месяца", "Факт", "Выполнено, %"],
            [
                [m["model"], m["plan"], m["fact"], round(m["fact"] / m["plan"] * 100, 1) if m["plan"] else None]
                for m in o["month"]["models"]
            ],
            widths=[3, 1.2, 1.2, 1.2],
        ),
    ]
    d.blocks += _advice_steps(c, 3)
    return d


def _dm(v) -> str:
    if isinstance(v, str):
        v = date.fromisoformat(v[:10])
    return v.strftime("%d.%m")


def quality_doc(ctx: Ctx) -> Doc:
    c = ctx.c
    a = ctx.sandbox.analytics if ctx.sandbox else c.analytics
    qs = a.quality()
    d = _doc(
        ctx,
        "Отчёт по качеству",
        f"Брак по участкам: уровень по тренду, прогноз и причины · норма ≤ {_n(c.plant.targets.defect_pct)}%",
        "QR",
    )
    tones = {"ok": "ok", "warning": "warn", "critical": "bad"}
    d.blocks += [
        Heading("Уровень брака по участкам"),
        Kpis(
            [
                Kpi(
                    q["name"],
                    _pct(q["level"]),
                    f"через 7 дней {_pct(q['forecast_7'])} · "
                    f"{'+' if q['slope_week'] >= 0 else '−'}{_n(abs(q['slope_week']), 2)} п.п./нед",
                    tones.get(q["status"]),
                )
                for q in qs
            ]
        ),
    ]
    days = sorted({p["day"] for q in qs for p in q["series"]})[-30:]
    by = {q["area"]: {p["day"]: p["pct"] for p in q["series"]} for q in qs}
    if days:
        d.blocks += [
            Heading("Брак по дням, %", "Последние 30 рабочих дней"),
            Chart(
                "line",
                [_dm(x) for x in days],
                [(q["name"], [by[q["area"]].get(x) for x in days]) for q in qs if q["series"]],
                target=c.plant.targets.defect_pct,
                target_label="норма",
            ),
        ]
    for q in qs:
        if q["causes"]:
            d.blocks += [
                Heading(f"{q['name']}: что показал разбор"),
                Bullets([f"{x['text']} (связь: {x['strength']})" for x in q["causes"][:5]]),
            ]
    d.blocks += _advice_steps(c, 3)
    return d


def forecast_doc(ctx: Ctx) -> Doc:
    c = ctx.c
    a = ctx.sandbox.analytics if ctx.sandbox else c.analytics
    ins = a.insights()
    f = ins["forecast"]
    d = _doc(ctx, "Прогноз и риски", "План месяца, вероятность отказов оборудования, узкое место и решения", "FR")
    if f.get("available"):
        d.blocks += [
            Heading("План месяца"),
            Kpis(
                [
                    Kpi(
                        "Прогноз выпуска",
                        _n(f["expected"]),
                        f"план {_n(f['target'])}",
                        "ok" if f["expected"] >= f["target"] else "bad",
                    ),
                    Kpi(
                        "Вероятность плана",
                        f"{f['probability']}%",
                        f"P10 {_n(f['p10'])} — P90 {_n(f['p90'])}",
                        "ok" if f["probability"] >= 70 else "warn" if f["probability"] >= 40 else "bad",
                    ),
                    Kpi(
                        "Нужный темп",
                        _n(f["need_daily"]),
                        f"сейчас {_n(f['daily_rate'])} авт./сутки",
                        "ok" if f["daily_rate"] >= f["need_daily"] else "warn",
                    ),
                ],
                per_row=3,
            ),
        ]
        series = f.get("series") or []
        if series:
            d.blocks.append(
                Chart(
                    "line",
                    [_dm(p["day"]) for p in series],
                    [
                        ("Факт нарастающим", [p.get("fact") for p in series]),
                        ("Прогноз", [p.get("forecast") for p in series]),
                    ],
                    target=f["target"],
                    target_label=f"план {_n(f['target'])}",
                )
            )
    risks = [r for r in ins["risks"] if r["level"] != "low"]
    d.blocks += [
        Heading("Риск отказа оборудования в ближайшие 7 дней", "Модель по истории отказов, наработке и износу"),
        Table(
            ["Оборудование", "Вероятность", "Уровень", "Следующий отказ", "Главная причина", "Потери за неделю"],
            [
                [
                    r["code"],
                    f"{round(r['probability'] * 100)}%",
                    LEVEL[r["level"]],
                    r["next_failure"].strftime("%d.%m")
                    if r["next_failure"]
                    else ("уже ожидался" if r["overdue"] else "—"),
                    r["main_reason"],
                    money(r["expected_loss_kzt"]),
                ]
                for r in risks
            ],
            widths=[1.4, 1, 0.9, 1.2, 2, 1.3],
            align=["l", "r", "l", "l", "l", "r"],
            tones=["bad" if r["level"] == "high" else None for r in risks],
        ),
        Heading("Рекомендации по выводам аналитики"),
        Steps(
            [
                (
                    r["title"],
                    f"{r['problem']} {r['action']}",
                    f"{PRIORITY.get(r['priority'], '')}"
                    + (f" · ≈ {money(r['effect_kzt_month'])} в месяц" if r["effect_kzt_month"] else ""),
                )
                for r in ins["recommendations"][:6]
            ]
        ),
    ]
    d.blocks += _advice_steps(c, 4)
    return d


def sim_doc(ctx: Ctx) -> Doc:
    sb = ctx.sandbox
    if sb is None:
        d = _doc(ctx, "Результат симуляции", "Симуляция не запущена", "SM")
        d.blocks = [
            Callout("Нет симуляции", "Запустите симуляцию в разделе «Симуляция», затем сформируйте документ.", "warn")
        ]
        return d
    r = sb.result
    sm = r["summary"]
    d = _doc(
        ctx,
        "Результат симуляции «что если»",
        f"Окно {r['start']:%d.%m %H:%M} – {r['end']:%d.%m %H:%M} · {sm['mean']['runs']} прогонов",
        "SM",
    )
    lost = sm["mean"]["lost"]
    d.blocks += [
        Heading("Итог"),
        Callout(
            sm["verdict"],
            "Линия прогнана вперёд дважды на одних и тех же случайных событиях: с введёнными "
            "событиями и без них. Разница — цена событий.",
            "bad" if lost > 0.5 else "ok",
        ),
        Kpis(
            [
                Kpi("Без событий", _n(sm["mean"]["baseline"]), "авто к концу окна", "info"),
                Kpi("С событиями", _n(sm["mean"]["scenario"]), "авто к концу окна", "info"),
                Kpi(
                    "Потеря",
                    _n(lost),
                    f"от {_n(sm['mean']['lost_low'])} до {_n(sm['mean']['lost_high'])} авто",
                    "bad" if lost > 0.5 else "ok",
                ),
                Kpi(
                    "Цена",
                    money(sm["money_kzt"]),
                    f"маржа {money(sm.get('margin_per_car'))} за авто",
                    "bad" if sm["money_kzt"] > 0 else "ok",
                ),
            ]
        ),
        Heading("Введённые события"),
        Bullets([x["title"] for x in r["actions"]]),
    ]
    sb_series, sc_series = r["series"]["baseline"], r["series"]["scenario"]
    if sb_series:
        step = max(1, len(sb_series) // 24)
        d.blocks += [
            Heading("Выпуск по времени"),
            Chart(
                "line",
                [x["t"].strftime("%H:%M") for x in sb_series][::step],
                [
                    ("Без событий", [x["cars"] for x in sb_series][::step]),
                    ("С событиями", [x["cars"] for x in sc_series][::step]),
                ],
                unit="авто нарастающим итогом",
            ),
        ]
    d.blocks += [
        Heading("Хронология"),
        Table(
            ["Время", "Событие", "Участок", "Введено вами"],
            [[e["t"].strftime("%H:%M"), e["title"], e["area"], e["user"]] for e in r["log"]],
            widths=[0.8, 4, 1.4, 1],
            align=["l", "l", "l", "l"],
            max_rows=80,
        ),
    ]
    return d


def incidents_doc(ctx: Ctx) -> Doc:
    c = ctx.c
    data = c.sandboxes.incidents(ctx.sandbox, None, None) if ctx.sandbox else c.incidents.list(None, None, 300, 0)
    items = data["items"]
    names = _area_names(c)
    workers = [i for i in items if i.get("source") == "worker"]
    d = _doc(ctx, "Журнал инцидентов", f"Последние {len(items)} инцидентов · в работе {data['active']}", "IR")
    d.blocks += [
        Kpis(
            [
                Kpi("Активных", _n(data["active"]), "открыты или в работе", "bad" if data["active"] else "ok"),
                Kpi("Сообщений с участков", _n(len(workers)), "от рабочих", "info"),
                Kpi("Простой, мин", _n(sum(i.get("downtime_min") or 0 for i in items)), "по закрытым", "info"),
                Kpi("Потери", money(data.get("cost_kzt") or 0), "оценка по марже", "warn"),
            ]
        ),
        Heading("Инциденты"),
        _incident_table(items, names),
    ]
    return d


def incident_act(ctx: Ctx, inc: dict, impact: dict | None) -> Doc:
    c = ctx.c
    names = _area_names(c)
    d = _doc(
        ctx,
        "Акт об инциденте",
        f"№ {inc['id']} · {inc['created_at']:%d.%m.%Y %H:%M} · {names.get(inc['area'] or '', 'линия')}",
        "AC",
        [("Статус", INC_STATUS.get(inc["status"], inc["status"]))],
    )
    rows = [
        ("Что случилось", inc["title"]),
        ("Тип", KIND.get(inc["kind"], inc["kind"])),
        ("Важность", INC_SEV.get(inc["severity"], inc["severity"])),
        ("Участок", names.get(inc["area"] or "", "—")),
        ("Оборудование", inc.get("equipment") or "—"),
        ("Сообщил", inc.get("reported_by") or "система (датчики модели)"),
        ("Линия остановлена", "да" if inc.get("line_stopped") else "нет"),
        ("Описание", inc.get("details") or "—"),
        ("Принял в работу", inc.get("acked_by") or "—"),
        ("Закрыт", inc["resolved_at"].strftime("%d.%m.%Y %H:%M") if inc.get("resolved_at") else "—"),
        ("Закрыл", inc.get("resolved_by") or "—"),
        ("Что сделано", inc.get("resolution") or "—"),
        ("Простой", f"{_n(inc['downtime_min'])} мин" if inc.get("downtime_min") is not None else "—"),
        ("Потери по оценке", money(inc["cost_kzt"]) if inc.get("cost_kzt") else "—"),
    ]
    d.blocks += [Heading("Сведения"), Pairs(rows)]
    if impact and impact.get("available"):
        d.blocks += [
            Heading(
                "Экспресс-анализ последствий",
                f"На {impact['now']:%H:%M}: копия линии прогнана до конца смены "
                f"{impact['runs']} раз с проблемой и без неё.",
            ),
            Callout("Вывод", impact["summary"], "bad" if impact["lost_cars"] >= 1 else "info"),
            Kpis(
                [
                    Kpi(
                        "Минута остановки линии",
                        money(impact["cost_per_min_kzt"]),
                        f"такт {_n(impact['takt_min'])} мин",
                        "warn",
                    ),
                    Kpi(
                        "Потеря к концу смены",
                        _n(impact["lost_cars"]),
                        f"авто ≈ {money(impact['lost_kzt'])}",
                        "bad" if impact["lost_cars"] >= 1 else "ok",
                    ),
                    Kpi(
                        "Прогноз смены",
                        _n(impact["plan_expected"]),
                        f"без проблемы {impact['plan_without']} · план {impact['plan']}",
                        "warn",
                    ),
                ],
                per_row=3,
            ),
        ]
        if impact["options"]:
            d.blocks += [
                Heading("Варианты действий"),
                Steps(
                    [
                        (
                            o["title"],
                            o["action"],
                            f"сохранит {_n(o['cars'])} авто · чистый эффект {money(o['net_kzt'])}",
                        )
                        for o in impact["options"]
                    ]
                ),
            ]
    d.signatures = [
        ("Начальник смены", inc.get("acked_by") or ctx.author),
        ("Мастер участка", ""),
        ("Сообщил", inc.get("reported_by") or ""),
    ]
    return d


def journal_doc(ctx: Ctx, data: dict, filters: dict) -> Doc:
    items = data["items"]
    cats = data["categories"]
    sub = f"{len(items)} записей" + (
        f" · раздел «{cats.get(filters['category'], '')}»" if filters.get("category") else ""
    )
    d = _doc(ctx, "История действий на производстве", sub, "JR")
    counts: dict[str, int] = {}
    for e in items:
        counts[e["category_name"]] = counts.get(e["category_name"], 0) + 1
    people = sorted({e["actor"] for e in items if e["actor"] != "Система"})
    d.blocks += [
        Kpis(
            [
                Kpi("Записей", _n(len(items)), "в документе", "info"),
                Kpi("Важных", _n(sum(1 for e in items if e["severity"] != "info")), "внимание и важно", "warn"),
                Kpi("Сотрудников", _n(len(people)), "действовали", "info"),
            ],
            per_row=3,
        ),
        Heading("По разделам"),
        Table(["Раздел", "Записей"], sorted([[k, v] for k, v in counts.items()], key=lambda x: -x[1]), widths=[4, 1]),
        Heading("Записи журнала", "Сначала новые. Время — местное время завода."),
        Table(
            ["Время", "Раздел", "Кто", "Событие", "Подробности"],
            [
                [
                    e["at"].strftime("%d.%m %H:%M"),
                    e["category_name"],
                    e["actor"],
                    e["title"],
                    "; ".join(f"{k}: {v}" for k, v in e["details"].items())[:220],
                ]
                for e in items
            ],
            widths=[1, 1.1, 1.5, 3, 2.4],
            align=["l"] * 5,
            tones=[
                "bad" if e["severity"] == "critical" else "warn" if e["severity"] == "warning" else None for e in items
            ],
            max_rows=500,
        ),
    ]
    return d


def ai_doc(ctx: Ctx, report_text: str) -> Doc:
    c = ctx.c
    a = ctx.sandbox.analytics if ctx.sandbox else c.analytics
    ins = a.insights()
    d = _doc(ctx, "Аналитическая записка", "Разбор ситуации по живому цеху, истории и прогнозам", "AN")
    paras = [ln.strip() for ln in report_text.split("\n") if ln.strip()]
    d.blocks += [Heading("Разбор ситуации")]
    bullets: list[str] = []
    for ln in paras:
        if ln.startswith(("•", "-", "*")) or ln[:2].rstrip(".").isdigit():
            bullets.append(ln.lstrip("•-* ").split(". ", 1)[-1] if ln[:2].rstrip(".").isdigit() else ln.lstrip("•-* "))
        else:
            if bullets:
                d.blocks.append(Bullets(bullets))
                bullets = []
            d.blocks.append(Text(ln))
    if bullets:
        d.blocks.append(Bullets(bullets))
    d.blocks += _advice_steps(c, 5)
    risks = [r for r in ins["risks"] if r["level"] == "high"][:6]
    if risks:
        d.blocks += [
            Heading("Главные риски отказов"),
            Table(
                ["Оборудование", "Вероятность за 7 дней", "Причина", "Почему"],
                [
                    [r["code"], f"{round(r['probability'] * 100)}%", r["main_reason"], "; ".join(r["factors"][:2])]
                    for r in risks
                ],
                widths=[1.3, 1.2, 1.8, 4],
                align=["l", "r", "l", "l"],
            ),
        ]
    return d


def roi_doc(ctx: Ctx, r: dict) -> Doc:
    m = r["month"]
    lo = r["losses"]
    per = r["period"]
    d = _doc(
        ctx,
        "Экономика производства",
        f"Факт за {per['days']} раб. дн. ({per['start']:%d.%m} — {per['end']:%d.%m}), пересчёт на рабочий месяц "
        f"({r['basis']['workdays_month']} дн.)",
        "EC",
    )
    d.blocks += [
        Heading("Месяц в деньгах"),
        Kpis(
            [
                Kpi("Маржинальный доход", money(m["margin_income_kzt"]), f"{_n(m['output'])} авто × маржа", "ok"),
                Kpi("Потери", money(r["losses_total_kzt"]), "недовыпуск и переделка брака", "bad"),
                Kpi("Труд и накладные на авто", money(r["cost_per_car_kzt"]), "ФОТ линии и энергия", "info"),
                Kpi("Выполнение плана", f"{_n(r['plan_pct'])}%", f"{_n(m['output'])} из {_n(m['plan'])}", "warn"),
            ],
            per_row=4,
        ),
        Pairs(
            [
                ("Маржинальный доход", money(m["margin_income_kzt"])),
                ("Фонд оплаты труда линии", "− " + money(m["payroll_kzt"])),
                ("Энергия и накладные", "− " + money(m["overhead_kzt"])),
                ("Переделка брака", "− " + money(lo["rework_kzt"])),
                ("**Операционный результат линии**", f"**{money(m['result_kzt'])}**"),
                ("Упущено из-за недовыпуска", money(lo["shortfall_kzt"])),
            ]
        ),
        Heading("Куда уходят деньги"),
        Pairs(
            [
                ("Недовыпуск против плана", f"{_n(lo['shortfall_cars'])} авто → {money(lo['shortfall_kzt'])}"),
                (
                    "из них из-за внеплановых простоев",
                    f"{_n(lo['downtime_min'])} мин, {lo['downtime_stops']} остановок → "
                    f"≈ {_n(lo['downtime_cars'])} авто, {money(lo['downtime_kzt'])}",
                ),
                ("Переделка брака", f"{_n(lo['defects'])} кузовов → {money(lo['rework_kzt'])}"),
                ("из них сверх нормы", f"{_n(lo['defects_excess'])} кузовов → {money(lo['rework_excess_kzt'])}"),
                ("Плановое обслуживание", f"{_n(lo['planned_min'])} мин"),
            ]
        ),
    ]
    if r["areas"]:
        d.blocks += [
            Heading("Потери по участкам (в месяц)"),
            Table(
                ["Участок", "Простой, мин", "Остановок", "Брак", "Простой", "Брак, ₸", "Итого"],
                [
                    [
                        x["name"],
                        x["down_min"],
                        x["stops"],
                        x["defects"],
                        money(x["downtime_kzt"]),
                        money(x["rework_kzt"]),
                        money(x["total_kzt"]),
                    ]
                    for x in r["areas"]
                ],
                widths=[1.8, 1, 0.9, 0.7, 1.2, 1.1, 1.2],
                align=["l", "r", "r", "r", "r", "r", "r"],
            ),
        ]
    if r["equipment"]:
        d.blocks += [
            Heading("Оборудование, которое стоит дороже всего"),
            Table(
                ["Оборудование", "Участок", "Простой, мин", "Остановок", "Главная причина", "В месяц"],
                [
                    [x["code"], x["area"], x["down_min"], x["stops"], x["reason"], money(x["kzt_month"])]
                    for x in r["equipment"]
                ],
                widths=[1.4, 1.2, 1, 0.9, 2.2, 1.2],
                align=["l", "l", "r", "r", "l", "r"],
            ),
        ]
    if r["daily"]:
        d.blocks += [
            Heading("Потери по дням", "Недовыпуск против суточного плана и переделка брака, млн ₸"),
            Chart(
                "bar",
                [x["day"].strftime("%d.%m") for x in r["daily"]],
                [("Потери, млн ₸", [x["loss_kzt"] / 1e6 for x in r["daily"]])],
            ),
        ]
    d.blocks += [
        Heading("Что даст устранение потерь (в месяц)"),
        Steps([(x["title"], x["text"], money(x["kzt_month"])) for x in r["potential"]]),
        Heading("Допущения", "Меняются на странице «Экономика»; документ показывает значения на момент выгрузки."),
        Pairs(
            [
                ("Маржинальный доход на автомобиль", money(r["basis"]["margin_per_car_kzt"])),
                ("Стоимость переделки брака", money(r["basis"]["rework_cost_kzt"])),
                ("Ставка рабочего", money(r["basis"]["labor_rate_kzt_h"]) + " в час"),
                ("Ставка сверхурочных", money(r["basis"]["overtime_rate_kzt_h"]) + " в час"),
                ("Рабочих на линии в смену", _n(r["basis"]["line_staff"])),
                ("Минута остановки линии", money(r["minute_kzt"]) + " маржи"),
            ]
            + [(x["label"], _n(x["value"])) for x in r["assumptions"]]
        ),
    ]
    return d


def data_doc(ctx: Ctx) -> Doc:
    c = ctx.c
    ds = c.data.dataset()
    checks = c.analytics.checks()
    params = c.params.view(c.analytics.current_defect_levels())
    d = _doc(
        ctx, "Паспорт данных и параметров линии", "Что загружено, что заметила проверка, какие параметры изменены", "DT"
    )
    by_source: dict[str, int] = {}
    for r in ds.production:
        by_source[r.source] = by_source.get(r.source, 0) + 1
    src = {
        "customer": "данные заказчика",
        "history": "история (сгенерирована)",
        "live": "живой цех",
        "import": "загружено пользователями",
    }
    days = ds.days
    d.blocks += [
        Heading("Что в базе"),
        Pairs(
            [
                ("Период", f"{days[0]:%d.%m.%Y} — {days[-1]:%d.%m.%Y}" if days else "—"),
                ("Смен по линиям", _n(len(ds.production))),
                ("Записей качества", _n(len(ds.quality))),
                ("Простоев", _n(len(ds.downtime))),
                ("План по моделям, строк", _n(len(ds.model_plan))),
            ]
            + [(f"Выпуск: {src.get(k, k)}", _n(v)) for k, v in by_source.items()]
        ),
        Heading("Проверка данных"),
    ]
    tone = {"critical": "bad", "warning": "warn"}
    for ch in checks:
        d.blocks.append(Callout(ch["title"], ch["text"], tone.get(ch["level"], "info")))
    if not checks:
        d.blocks.append(Text("Противоречий не найдено."))
    d.blocks += [
        Heading("Параметры участков", "Значение по модели завода и текущее"),
        Table(
            ["Участок", "Цикл, с", "Буфер после", "Брак, %", "Изменено"],
            [
                [
                    a["name"],
                    f"{_n(a['base']['cycle_s'])} → {_n(a['value']['cycle_s'])}"
                    if a["value"]["cycle_s"] != a["base"]["cycle_s"]
                    else _n(a["value"]["cycle_s"]),
                    _n(a["value"]["buffer"]) if a["has_buffer"] else "—",
                    _n(a["value"]["defect_pct"]) if a["has_defects"] else "—",
                    "да" if a["changed"] else "нет",
                ]
                for a in params["areas"]
            ],
            widths=[2, 1.4, 1.2, 1, 1],
        ),
        Heading("Надёжность оборудования"),
        Table(
            ["Оборудование", "Участок", "Критичное", "Наработка на отказ, ч", "Ремонт, мин"],
            [
                [
                    e["code"],
                    _area_names(c).get(e["area"]),
                    "да" if e["critical"] else "нет",
                    e["value"]["mtbf_h"],
                    e["value"]["mttr_min"],
                ]
                for e in params["equipment"]
            ],
            widths=[1.6, 1.6, 1, 1.5, 1.2],
            tones=["warn" if e["changed"] else None for e in params["equipment"]],
        ),
    ]
    return d


def builder_doc(ctx: Ctx, body: dict) -> Doc:
    d = _doc(ctx, "Проект производственной линии", body.get("name") or "Проект конструктора", "BL")
    nodes = body.get("nodes") or []
    stats = body.get("stats") or {}
    d.blocks += [
        Kpis(
            [
                Kpi("Узлов", _n(len(nodes)), "участки, буферы, склады", "info"),
                Kpi("Оборудования", _n(sum(n.get("equipment", 0) for n in nodes)), "единиц", "info"),
                Kpi(
                    "Выпуск в час",
                    _n(stats.get("per_hour")) if stats.get("per_hour") is not None else "—",
                    "по симуляции",
                    "ok",
                ),
                Kpi("Узкое место", str(stats.get("bottleneck") or "—"), "по симуляции", "warn"),
            ]
        ),
        Heading("Узлы"),
        Table(
            ["Узел", "Тип", "Цикл, с", "Параллельно", "Оборудования", "Брак, %", "Выпуск", "Загрузка, %"],
            [
                [
                    n.get("name"),
                    n.get("kind"),
                    n.get("cycle_s"),
                    n.get("parallel"),
                    n.get("equipment"),
                    n.get("defect_pct"),
                    n.get("produced"),
                    n.get("utilization"),
                ]
                for n in nodes[:300]
            ],
            widths=[2.4, 1.2, 0.9, 1, 1.1, 0.8, 0.9, 1],
        ),
    ]
    if stats:
        d.blocks += [Heading("Итоги симуляции"), Pairs([(k, str(v)) for k, v in (stats.get("summary") or {}).items()])]
    return d


def risk_dicts(risks) -> list[dict]:
    return [asdict(r) for r in risks]


def full_doc(ctx: Ctx, forecast: dict | None, roi_r: dict, journal: dict) -> Doc:
    c = ctx.c
    o = c.analytics.overview(ctx.days)
    p = o["period"]
    sections: list[tuple[str, str, Doc]] = [
        (
            "Цех и смена",
            "Состояние линии, выпуск смены, прогноз до её конца, сообщения с участков",
            floor_doc(ctx, forecast),
        ),
        ("Показатели", f"OEE, план, брак и простои против целей завода · {ctx.days} дн.", kpi_doc(ctx)),
        ("Качество", "Брак по участкам, тренд и причины", quality_doc(ctx)),
        ("Прогноз и риски", "План месяца, риск отказов оборудования, узкое место", forecast_doc(ctx)),
        ("Инциденты", "Аварии и отклонения: кто сообщил, кто принял, простой, потери", incidents_doc(ctx)),
        ("Экономика", "Доход, затраты, потери и что даст их устранение", roi_doc(ctx, roi_r)),
        ("Данные", "Откуда данные, полнота, найденные противоречия", data_doc(ctx)),
        ("История действий", "Последние действия на производстве", journal_doc(ctx, journal, {})),
    ]
    d = _doc(
        ctx, "Общий анализ производства", f"Все разделы · период {ctx.days} дн. · на {ctx.now:%d.%m.%Y %H:%M}", "GA"
    )
    checks = {x["key"]: x for x in p["checks"]}
    tone = {"ok": "ok", "warning": "warn", "critical": "bad"}

    def tile(key: str, label: str) -> Kpi | None:
        x = checks.get(key)
        if x is None:
            return None
        unit = "%" if x["unit"].strip() == "%" else ""
        return Kpi(label, f"{_n(x['value'])}{unit}", f"цель {x['op']} {_n(x['target'])}{x['unit']}", tone[x["status"]])

    tiles = [t for t in (tile("plan", "Выполнение плана"), tile("oee", "OEE"), tile("defect", "Брак")) if t]
    tiles.append(Kpi("Выпущено за период", _n(p["output"]), f"из {_n(p['plan'])} по плану", "info"))
    bad = [x for x in p["checks"] if x["status"] != "ok"]
    d.blocks += [
        Heading("Главное", "Ключевые показатели периода против целей завода."),
        Kpis(tiles, per_row=4),
        Callout(
            "Вывод",
            (
                "Не выполнены цели: "
                + "; ".join(f"{x['label'].lower()} — {_n(x['value'])}{x['unit']}" for x in bad)
                + "."
                if bad
                else "Все цели завода за период выполнены."
            ),
            "bad" if any(x["status"] == "critical" for x in bad) else ("warn" if bad else "ok"),
        ),
        Heading("Содержание"),
        Bullets([f"**{i:02d}. {title}** — {hint}" for i, (title, hint, _) in enumerate(sections, 1)]),
    ]
    seen_advice = False
    for i, (title, hint, sub) in enumerate(sections, 1):
        d.blocks.append(Section(i, title, hint))
        skip_steps = False
        for b in sub.blocks:
            if isinstance(b, Heading) and b.text.startswith("Что сделать"):
                if seen_advice:
                    skip_steps = True
                    continue
                seen_advice = True
            elif skip_steps and isinstance(b, Steps):
                skip_steps = False
                continue
            elif skip_steps and isinstance(b, Text):
                continue
            skip_steps = False
            d.blocks.append(b)
    d.signatures = [(ctx.position or "Составил", ctx.author), ("Директор по производству", "")]
    return d
