from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Query
from fastapi.responses import Response
from pydantic import Field

from app.analytics.economy import economy
from app.api.deps import ContainerDep, ScopeDep, ViewerDep
from app.core.errors import TooManyRequestsError
from app.reports import documents as docs
from app.reports.pdf import render
from app.schemas.requests import Strict
from app.sim.forecast import forecast_shift

router = APIRouter(prefix="/documents", tags=["Документы"])

Page = Literal["floor", "kpi", "quality", "forecast", "sim", "incidents", "journal", "ai", "roi", "data", "full"]
TITLES = {
    "floor": "Сменный отчёт",
    "kpi": "Показатели",
    "quality": "Качество",
    "forecast": "Прогноз и риски",
    "sim": "Симуляция",
    "incidents": "Журнал инцидентов",
    "journal": "История действий",
    "ai": "Аналитическая записка",
    "roi": "Экономика производства",
    "data": "Паспорт данных",
    "incident": "Акт об инциденте",
    "builder": "Проект линии",
    "full": "Общий анализ производства",
}
FILE = {
    "floor": "smennyi_otchet",
    "kpi": "pokazateli",
    "quality": "kachestvo",
    "forecast": "prognoz",
    "sim": "simulyaciya",
    "incidents": "incidenty",
    "journal": "istoriya_deistvii",
    "ai": "analiticheskaya_zapiska",
    "roi": "ekonomika_proizvodstva",
    "data": "pasport_dannyh",
    "incident": "akt_incidenta",
    "builder": "proekt_linii",
    "full": "obshchii_analiz",
}


def _limit(c, session) -> None:
    key = f"heavy:{session.user_id}"
    if c.heavy_limiter.blocked_for(key) > 0:
        raise TooManyRequestsError("Слишком много документов подряд. Подождите минуту.")
    c.heavy_limiter.hit(key)


async def _send(c, session, kind: str, doc, extra: str = "") -> Response:
    body = await asyncio.to_thread(render, doc)
    c.audit.log("export", "pdf", f"Документ «{TITLES[kind]}»{extra} (PDF) № {doc.number}", actor=session.name)
    name = f"allur_{FILE[kind]}_{doc.created or datetime.now():%Y%m%d_%H%M}.pdf"
    ru = f"Allur_{TITLES[kind]}{extra}_{doc.created or datetime.now():%d.%m.%Y_%H-%M}.pdf".replace(" ", "_")
    return Response(
        body,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=\"{name}\"; filename*=UTF-8''{quote(ru)}",
            "X-Document-Number": doc.number,
        },
    )


@router.get("/{page}.pdf", summary="Документ по разделу (PDF)")
async def page_pdf(
    page: Page,
    c: ContainerDep,
    session: ViewerDep,
    scope: ScopeDep,
    days: int = Query(7, ge=1, le=120),
    note: str | None = Query(None, max_length=300),
    category: str | None = Query(None, max_length=20),
) -> Response:
    _limit(c, session)
    ctx = docs.Ctx(c=c, author=session.name, position=session.position, sandbox=scope.sandbox, days=days, note=note)
    if page == "full":
        twin = c.live.snapshot_copy() if scope.sandbox is None else None
        fc = await asyncio.to_thread(forecast_shift, twin, c.plant.targets.shift_plan) if twin else None
        r = economy(c.data.dataset(), c.plant, c.analytics.today(), c.economics.economics(), max(days, 7))
        journal = c.audit.query(limit=25, show_private=False)
        doc = await asyncio.to_thread(docs.full_doc, ctx, fc, r, journal)
    elif page == "floor" and scope.sandbox is None:
        twin = c.live.snapshot_copy()
        fc = await asyncio.to_thread(forecast_shift, twin, c.plant.targets.shift_plan) if twin else None
        doc = await asyncio.to_thread(docs.floor_doc, ctx, fc)
    elif page in ("floor", "sim"):
        doc = await asyncio.to_thread(docs.sim_doc, ctx)
    elif page == "kpi":
        doc = await asyncio.to_thread(docs.kpi_doc, ctx)
    elif page == "quality":
        doc = await asyncio.to_thread(docs.quality_doc, ctx)
    elif page == "forecast":
        doc = await asyncio.to_thread(docs.forecast_doc, ctx)
    elif page == "incidents":
        doc = await asyncio.to_thread(docs.incidents_doc, ctx)
    elif page == "journal":
        filters = {"category": category}
        data = c.audit.query(category=category, limit=500, show_private=False)
        doc = await asyncio.to_thread(docs.journal_doc, ctx, data, filters)
    elif page == "ai":
        rep = await scope.assistant.report()
        doc = await asyncio.to_thread(docs.ai_doc, ctx, rep.text)
    elif page == "roi":
        r = economy(c.data.dataset(), c.plant, c.analytics.today(), c.economics.economics(), max(days, 7))
        doc = await asyncio.to_thread(docs.roi_doc, ctx, r)
    else:
        doc = await asyncio.to_thread(docs.data_doc, ctx)
    return await _send(c, session, page, doc)


@router.get("/incident/{incident_id}.pdf", summary="Акт об инциденте (PDF)")
async def incident_pdf(incident_id: int, c: ContainerDep, session: ViewerDep) -> Response:
    _limit(c, session)
    inc = c.incidents.get(incident_id)
    impact = None
    if inc["status"] != "resolved":
        problem = c.advice.problem_from(inc, None)
        twin = c.live.snapshot_copy()
        impact = await asyncio.to_thread(c.advice.impact, inc, problem, twin)
    ctx = docs.Ctx(c=c, author=session.name, position=session.position)
    return await _send(c, session, "incident", docs.incident_act(ctx, inc, impact), f" № {incident_id}")


class BuilderDocIn(Strict):
    name: str = Field(max_length=120)
    nodes: list[dict] = Field(default_factory=list, max_length=3000)
    stats: dict = Field(default_factory=dict)


@router.post("/builder.pdf", summary="Проект конструктора (PDF)")
async def builder_pdf(body: BuilderDocIn, c: ContainerDep, session: ViewerDep) -> Response:
    _limit(c, session)
    ctx = docs.Ctx(c=c, author=session.name, position=session.position)
    return await _send(c, session, "builder", docs.builder_doc(ctx, body.model_dump()))
