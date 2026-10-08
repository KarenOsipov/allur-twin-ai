from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass, field

from app.assistant.llm import LlmClient
from app.core.config import Settings
from app.core.text import ru
from app.domain.plant import Plant
from app.services.analytics_service import AnalyticsService

log = logging.getLogger(__name__)

MAX_QUESTION = 500


@dataclass
class Answer:
    text: str
    links: list[dict] = field(default_factory=list)
    engine: str = "local"
    topic: str = "summary"
    model: str | None = None

    def as_dict(self) -> dict:
        return {
            "text": ru(self.text) if self.engine == "local" else self.text,
            "links": self.links,
            "engine": self.engine,
            "topic": self.topic,
        }


def _n(x: float) -> str:
    return f"{x:,.0f}".replace(",", " ")


def _kzt(x: float) -> str:
    if abs(x) >= 1_000_000:
        return f"{x / 1_000_000:.1f} млн ₸".replace(".", ",")
    return f"{_n(x)} ₸"


TOPICS: list[tuple[str, tuple[str, ...]]] = [
    ("recommend", ("рекоменд", "что делать", "совет", "приоритет", "что улучш")),
    ("anomaly", ("аномал", "странн", "необычн")),
    ("risk", ("риск", "слома", "отказ", "сломает", "износ", "ремонт", "обслужив")),
    ("bottleneck", ("узк", "огранич", "bottleneck", "тормоз")),
    ("quality", ("брак", "качеств", "дефект")),
    ("downtime", ("простой", "простои", "простоя", "останов", "стоял")),
    ("oee", ("oee", "оее", "эффективн")),
    ("plan", ("план", "выполн", "месяц", "успеем", "прогноз выпуск")),
    ("now", ("сейчас", "смен", "сегодня", "цех", "линия", "работает")),
    ("yesterday", ("вчера",)),
]


SIM_WORDS = ("симул", "поломк", "что будет", "событи", "сценари", "потер", "если")

REPORT_QUESTION = (
    "Сделай короткий аналитический разбор для руководителя: что происходит сейчас, "
    "главные риски на ближайшие дни и 3 конкретных действия с эффектом."
)


class Assistant:
    def __init__(
        self, plant: Plant, analytics: AnalyticsService, live, settings: Settings, llm: LlmClient | None = None
    ) -> None:
        self.llm = llm or LlmClient(settings)
        self.plant = plant
        self.analytics = analytics
        self.live = live
        self.settings = settings
        self.sandbox: dict | None = None

    def scoped(self, analytics: AnalyticsService, live, sandbox: dict) -> Assistant:
        clone = copy.copy(self)
        clone.analytics = analytics
        clone.live = live
        clone.sandbox = sandbox
        return clone

    async def ask(self, question: str) -> Answer:
        q = question.strip()[:MAX_QUESTION]
        local = self._local(q)
        if not self.llm.enabled:
            return local
        try:
            text, model = await self._llm(q)
            return Answer(text=text, links=local.links, engine="llm", topic=local.topic, model=model)
        except Exception as e:
            log.warning("LLM недоступна (%s), отвечаю локально", type(e).__name__)
            return local

    def _topic(self, q: str) -> str:
        low = q.lower()
        codes = [e.code for e in self.plant.equipment if e.code.lower() in low]
        if codes:
            return "equipment:" + codes[0]
        for topic, keys in TOPICS:
            if any(k in low for k in keys):
                return topic
        return "summary"

    def _local(self, q: str) -> Answer:
        topic = self._topic(q)
        low = q.lower()
        if self.sandbox and (topic in ("summary", "now") or any(k in low for k in SIM_WORDS)):
            ans = self._simulation()
            ans.topic = "simulation"
            return ans
        handler = {
            "plan": self._plan,
            "oee": self._oee,
            "quality": self._quality,
            "downtime": self._downtime,
            "bottleneck": self._bottleneck,
            "risk": self._risk,
            "now": self._now,
            "recommend": self._recommend,
            "anomaly": self._anomaly,
            "yesterday": self._yesterday,
        }.get(topic)
        if topic.startswith("equipment:"):
            ans = self._equipment(topic.split(":", 1)[1])
        elif handler:
            ans = handler()
        else:
            ans = self._summary()
        ans.topic = topic
        return ans

    def _plan(self) -> Answer:
        f = self.analytics.month_forecast()
        m = self.analytics.overview(7)["month"]
        if not f.get("available"):
            return Answer("Недостаточно данных для прогноза плана.")
        verdict = "План будет выполнен" if f["probability"] >= 70 else "Есть риск не выполнить план"
        lines = [
            f"{verdict}: прогноз {_n(f['expected'])} автомобилей при цели {_n(f['target'])} "
            f"(вероятность {f['probability']}%, коридор {_n(f['p10'])}–{_n(f['p90'])}).",
            f"• Выпущено с начала месяца: {_n(f['fact_to_date'])}, осталось {f['workdays_left']} рабочих дн.",
            f"• Текущий темп {f['daily_rate']} авт./сутки, для плана нужно "
            f"{f['need_daily'] if f['need_daily'] is not None else '—'}.",
        ]
        if m["models_plan_total"] < m["target"]:
            lines.append(
                f"• Внимание: план по моделям — {_n(m['models_plan_total'])}, это на "
                f"{_n(m['target'] - m['models_plan_total'])} меньше цели. Остаток не распределён по моделям."
            )
        return Answer("\n".join(lines), [{"label": "Прогноз", "to": "/app/forecast"}])

    def _oee(self) -> Answer:
        p = self.analytics.overview(7)["period"]
        lines = [f"OEE за 7 дней — {p['oee']}% (цель ≥ {self.plant.targets.oee_pct:.0f}%)."]
        for line in p["lines"]:
            weakest = min(("availability", "performance", "quality"), key=lambda k: line[k])
            names = {
                "availability": "доступность",
                "performance": "производительность",
                "quality": "качество",
            }
            lines.append(f"• {line['line']}: {line['oee']}% — слабее всего {names[weakest]} ({line[weakest]}%)")
        return Answer("\n".join(lines), [{"label": "Показатели", "to": "/app/kpi"}])

    def _quality(self) -> Answer:
        qs = self.analytics.quality()
        bad = [q for q in qs if q["status"] != "ok"]
        if not bad:
            return Answer(
                "Брак на всех участках в норме (≤ 2%).",
                [{"label": "Качество", "to": "/app/quality"}],
            )
        lines = []
        for q in bad:
            lines.append(
                f"{q['name']}: брак {q['level']:.1f}% при норме {q['target']:.0f}%, "
                f"выше нормы {q['days_over']} дн. подряд, "
                f"тренд {q['slope_week']:+.2f} п.п. в неделю."
            )
            lines += [f"• {c['text']}" for c in q["causes"][:4]]
        ok = [q["name"] for q in qs if q["status"] == "ok"]
        if ok:
            lines.append(f"В норме: {', '.join(ok)}.")
        return Answer("\n".join(lines), [{"label": "Качество", "to": "/app/quality"}])

    def _downtime(self) -> Answer:
        o = self.analytics.overview(7)
        p = o["period"]
        lines = [
            f"Внеплановые простои за 7 дней: {_n(p['downtime_unplanned_min'])} мин, "
            f"плановые — {_n(p['downtime_planned_min'])} мин."
        ]
        unpl = [r for r in o["pareto_reason"] if not r.get("planned")]
        tot = sum(r["minutes"] for r in unpl) or 1
        for r in unpl[:4]:
            share = str(round(r["minutes"] / tot * 100, 1)).replace(".", ",")
            lines.append(f"• {r['key']}: {_n(r['minutes'])} мин ({share}%), {', '.join(r['equipment'][:3])}")
        if p["critical_downtime_breaches"]:
            b = p["critical_downtime_breaches"][-1]
            lines.append(f"Превышение лимита 60 мин/сут: {b['equipment']} — {b['minutes']} мин ({b['day']:%d.%m}).")
        return Answer("\n".join(lines), [{"label": "Показатели", "to": "/app/kpi"}])

    def _bottleneck(self) -> Answer:
        b = self.analytics.bottleneck()
        if not b.get("shifts") or not b.get("lines"):
            return Answer(
                "Пока нет закрытых смен с данными по всем линиям — узкое место определить не из чего.",
                [{"label": "Показатели", "to": "/app/kpi"}],
            )
        c = next(x for x in b["lines"] if x["area"] == b["constraint"])
        snap = self.live.snapshot()
        now = snap.get("kpi", {}).get("bottleneck") if snap.get("ready") else None
        lines = [
            f"Узкое место — {c['name'].lower()}: ограничивала выпуск в {c['share']}% из последних {b['shifts']} смен.",
            f"• Годная мощность {c['good_capacity_per_shift']} авт./смену при плане {self.plant.targets.shift_plan}.",
        ]
        for x in b["lines"]:
            if x["area"] != c["area"]:
                lines.append(f"• {x['name']}: {x['good_capacity_per_shift']} авт./смену")
        if now:
            lines.append(f"Прямо сейчас в цехе ограничивает: {self.plant.area(now).name.lower()}.")
        return Answer("\n".join(lines), [{"label": "Сценарии", "to": "/app/scenarios"}])

    def _risk(self) -> Answer:
        rs = [r for r in self.analytics.risks() if r.level != "low"][:4]
        if not rs:
            return Answer("Высокого риска отказов нет.")
        lines = ["Риск отказа в ближайшие 7 дней:"]
        for r in rs:
            when = (
                f", ожидается около {r.next_failure:%d.%m}"
                if r.next_failure and r.next_failure >= self.analytics.today()
                else ""
            )
            lines.append(f"• {r.code} — {round(r.probability * 100)}%{when}. {r.factors[0] if r.factors else ''}")
        return Answer("\n".join(lines), [{"label": "Прогноз", "to": "/app/forecast"}])

    def _equipment(self, code: str) -> Answer:
        r = next((x for x in self.analytics.risks() if x.code == code), None)
        eq = self.plant.eq(code)
        snap = self.live.snapshot()
        state = next((e for e in snap.get("equipment", []) if e["code"] == code), None)
        status = {
            "run": "работает",
            "idle": "ждёт",
            "down": "в отказе",
            "maint": "на обслуживании",
            "off": "выключено",
        }
        lines = [f"{eq.name} ({code}), участок «{self.plant.area(eq.area).name}»."]
        if state:
            extra = f": {state['reason'].lower()}" if state.get("reason") else ""
            lines.append(f"• Сейчас: {status.get(state['status'], state['status'])}{extra}")
        if r:
            lines.append(f"• Риск отказа за 7 дней: {round(r.probability * 100)}%, отказов за 90 дней: {r.failures_90}")
            lines += [f"• {f}" for f in r.factors[:3]]
            if r.mttr_min:
                lines.append(f"• Среднее восстановление {r.mttr_min:.0f} мин, главная причина — «{r.main_reason}»")
        return Answer("\n".join(lines), [{"label": "Цех", "to": "/app"}])

    def _now(self) -> Answer:
        s = self.live.snapshot()
        if not s.get("ready") or not s["working"]:
            return Answer("Сейчас нерабочее время: смены идут 08:00–16:00 и 16:00–24:00, пн–сб.")
        k = s["kpi"]
        down = [e for e in s["equipment"] if e["status"] in ("down", "maint")]
        lines = [
            f"Смена {s['shift']['number']}, время цеха {s['clock']:%H:%M}. Выпущено {k['finished']} "
            f"при плане на этот час {k['plan_to_now']} (план смены {k['shift_plan']}).",
        ]
        if k.get("forecast_shift"):
            lines.append(f"• Прогноз на конец смены: {k['forecast_shift']} автомобилей")
        lines.append(f"• Брак в смене: {k['defect_pct']:.1f}%")
        if down:
            lines.append("• Стоит: " + ", ".join(f"{e['code']} ({(e['reason'] or '').lower()})" for e in down))
        else:
            lines.append("• Всё оборудование работает")
        if k.get("bottleneck"):
            lines.append(f"• Ограничивает выпуск: {self.plant.area(k['bottleneck']).name.lower()}")
        return Answer("\n".join(lines), [{"label": "Цех", "to": "/app"}])

    def _recommend(self) -> Answer:
        recs = self.analytics.recommendations()[:4]
        lines = ["Что сделать в первую очередь:"]
        for i, r in enumerate(recs, 1):
            effect = f" Эффект ~{_kzt(r['effect_kzt_month'])}/мес." if r["effect_kzt_month"] else ""
            lines.append(f"{i}. {r['title']}. {r['action']}{effect}")
        return Answer(
            "\n".join(lines),
            [{"label": "Прогноз и рекомендации", "to": "/app/forecast"}],
        )

    def _anomaly(self) -> Answer:
        an = self.analytics.anomalies()[:4]
        if not an:
            return Answer("Аномальных смен не найдено.")
        lines = ["Смены, не похожие на обычные:"]
        for a in an:
            lines.append(f"• {a['day']:%d.%m}, смена {a['shift']}: {'; '.join(a['drivers'])}")
        return Answer("\n".join(lines), [{"label": "Прогноз", "to": "/app/forecast"}])

    def _yesterday(self) -> Answer:
        ds = self.analytics.data.dataset()
        today = self.analytics.today()
        days = [d for d in ds.days if d < today]
        if not days:
            return Answer("Данных за прошлые дни нет.")
        d = days[-1]
        from app.analytics.kpi import downtime_pareto, period_kpis

        p = period_kpis(ds, self.plant, d, d)
        pareto = downtime_pareto(ds, self.plant, d, d)
        target = self.plant.targets.shift_plan * len(self.plant.shifts)
        lines = [f"{d:%d.%m}: выпущено {p['output']} из {target} (OEE {p['oee']}%, брак {p['defect_pct']:.1f}%)."]
        if p["output"] < target:
            lines.append(f"Недовыпуск {target - p['output']} авт. Основные потери:")
        lines += [f"• {r['key']} — {r['minutes']} мин ({', '.join(r['equipment'])})" for r in pareto[:3]]
        worst = min(p["lines"], key=lambda x: x["oee"])
        lines.append(f"• Слабее всего {worst['line']}: OEE {worst['oee']}%, брак {worst['defect_pct']:.1f}%")
        return Answer("\n".join(lines), [{"label": "Показатели", "to": "/app/kpi"}])

    def _summary(self) -> Answer:
        p = self.analytics.overview(7)["period"]
        f = self.analytics.month_forecast()
        recs = self.analytics.recommendations()[:3]
        lines = [
            f"За 7 дней: {_n(p['output'])} автомобилей ({p['plan_pct']}% плана смен), "
            f"OEE {p['oee']}%, брак {p['defect_pct']:.1f}%.",
        ]
        if f.get("available"):
            lines.append(f"Прогноз месяца: {_n(f['expected'])} из {_n(f['target'])} (вероятность {f['probability']}%).")
        lines.append("Главное:")
        lines += [f"• {r['title']}" for r in recs]
        lines.append(
            "Спросите, например: «почему растёт брак окраски?», «что с Конвейером-03?», «что если добавить смену?»"
        )
        return Answer("\n".join(lines), [{"label": "Прогноз", "to": "/app/forecast"}])

    def _simulation(self) -> Answer:
        sb = self.sandbox or {}
        sm = sb["summary"]
        lines = ["Симуляция: " + "; ".join(a["title"] for a in sb["actions"]) + ".", sm["verdict"]]
        lines.append(
            f"• Простой критичного оборудования: {sm['downtime_min']['scenario']} мин "
            f"(без событий — {sm['downtime_min']['baseline']} мин)"
        )
        if sm["defects"]["extra"] > 0.5:
            lines.append(f"• Лишний брак: около {round(sm['defects']['extra'])} кузовов")
        downs = [e for e in sb["log"] if e["kind"] == "down" and not e.get("user")]
        if downs:
            lines.append(f"• В этом прогоне случились и другие отказы: {', '.join(e['title'] for e in downs[:3])}")
        lines.append(
            "Совет: ремонт критичного оборудования — в первую очередь; буфер перед узким местом не опустошать."
        )
        return Answer("\n".join(lines), [{"label": "Цех", "to": "/app"}])

    async def report(self) -> Answer:
        local = self._report()
        if not self.llm.enabled:
            return local
        try:
            text, model = await self._llm(REPORT_QUESTION)
            return Answer(text=text, links=local.links, engine="llm", topic="report", model=model)
        except Exception as e:
            log.warning("LLM недоступна для разбора (%s), отвечаю локально", type(e).__name__)
            return local

    def _report(self) -> Answer:
        p = self.analytics.overview(7)["period"]
        f = self.analytics.month_forecast()
        recs = self.analytics.recommendations()[:3]
        risks = [r for r in self.analytics.risks() if r.level != "low"][:3]
        snap = self.live.snapshot()
        lines: list[str] = []
        if self.sandbox:
            lines.append("**Симуляция.** " + self.sandbox["summary"]["verdict"])
        if snap.get("ready") and snap.get("working"):
            k = snap["kpi"]
            head = "**К концу симуляции.**" if self.sandbox else "**Сейчас.**"
            lines.append(
                f"{head} Смена {snap['shift']['number']}: {k['finished']} авто при плане к этому часу "
                f"{k['plan_to_now']}, брак {k['defect_pct']}%."
            )
        lines.append(
            f"**Неделя.** {_n(p['output'])} авто ({p['plan_pct']}% плана смен), OEE {p['oee']}%, "
            f"брак {p['defect_pct']:.1f}%."
        )
        if f.get("available"):
            lines.append(
                f"**Месяц.** Прогноз {_n(f['expected'])} из {_n(f['target'])}, вероятность {f['probability']}%."
            )
        if risks:
            lines.append("**Риски:**")
            lines += [f"• {r.code}: отказ с вероятностью {round(r.probability * 100)}% за 7 дней" for r in risks]
        if recs:
            lines.append("**Что сделать:**")
            lines += [f"{i}. {r['title']}" for i, r in enumerate(recs, 1)]
        return Answer("\n".join(lines), [{"label": "Прогноз и риски", "to": "/app/forecast"}], topic="report")

    def _context(self) -> dict:
        o = self.analytics.overview(7)
        snap = self.live.snapshot()
        return {
            "завод": self.plant.name,
            "цели": o["targets"],
            "показатели_7_дней": {
                k: o["period"][k]
                for k in (
                    "output",
                    "plan",
                    "oee",
                    "defect_pct",
                    "downtime_unplanned_min",
                )
            },
            "линии": o["period"]["lines"],
            "простои_парето": o["pareto_reason"][:6],
            "план_месяца": o["month"],
            "прогноз_месяца": {k: v for k, v in self.analytics.month_forecast().items() if k != "series"},
            "риски_оборудования": [
                {
                    "code": r.code,
                    "prob": r.probability,
                    "next": r.next_failure,
                    "factors": r.factors,
                }
                for r in self.analytics.risks()[:6]
            ],
            "качество": [
                {k: q[k] for k in ("name", "level", "slope_week", "days_over", "causes")}
                for q in self.analytics.quality()
            ],
            "узкое_место": self.analytics.bottleneck(),
            "рекомендации": self.analytics.recommendations()[:5],
            "цех_сейчас": snap.get("kpi") if snap.get("ready") else None,
            "время_цеха": snap.get("clock"),
            **({"симуляция": self._sim_context()} if self.sandbox else {}),
        }

    def _sim_context(self) -> dict:
        sb = self.sandbox or {}
        return {
            "пояснение": "Пользователь в режиме симуляции: показатели выше посчитаны так, будто смена прошла "
            "по симуляции. Отвечай про последствия введённых событий.",
            "введённые_события": [a["title"] for a in sb["actions"]],
            "окно": {"с": sb["start"], "до": sb["end"]},
            "итог": sb["summary"],
            "хронология": [e["title"] for e in sb["log"][:20]],
        }

    async def _llm(self, q: str) -> tuple[str, str]:
        context = json.dumps(self._context(), ensure_ascii=False, default=str)
        reply = await self.llm.ask(q, context)
        return reply.text, reply.model
