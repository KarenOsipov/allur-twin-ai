from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, Query
from fastapi.responses import Response

from app.api.deps import ContainerDep, ScopeDep, ViewerDep
from app.core.clock import plant_now
from app.reports import pages
from app.services.excel import workbook
from app.sim.forecast import forecast_shift

router = APIRouter(prefix="/export", tags=["Выгрузки"])

Page = Literal["floor", "kpi", "quality", "forecast", "sim", "incidents", "data", "ai"]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get("/{page}.xlsx", summary="Данные страницы в Excel")
async def export_page(
    page: Page,
    c: ContainerDep,
    session: ViewerDep,
    scope: ScopeDep,
    days: int = Query(7, ge=1, le=120),
    note: str | None = Query(None, max_length=300),
) -> Response:
    a = scope.analytics
    sb = scope.sandbox
    if page in ("floor", "sim") and sb:
        sheets = pages.sim_sheets(sb.result) + pages.floor_sheets(sb.result["final"] or {"ready": False}, None)
    elif page in ("floor", "sim"):
        twin = c.live.snapshot_copy()
        fc = await asyncio.to_thread(forecast_shift, twin, c.plant.targets.shift_plan) if twin else None
        sheets = pages.floor_sheets(c.live.snapshot(), fc)
    elif page == "kpi":
        sheets = pages.kpi_sheets(a.overview(days))
    elif page == "quality":
        sheets = pages.quality_sheets(a.quality())
    elif page == "forecast":
        sheets = pages.forecast_sheets(a.insights())
    elif page == "incidents":
        data = c.sandboxes.incidents(sb, None, None) if sb else c.incidents.list(None, None, 2000, 0)
        sheets = pages.incident_sheets(data)
    elif page == "data":
        sheets = pages.data_sheets(c.data.dataset(), a.checks())
    else:
        report = await scope.assistant.report()
        sheets = pages.ai_sheets(report.as_dict()["text"], {**a.insights(), "risks": [asdict(r) for r in a.risks()]})

    stamp = plant_now(c.settings.tz_offset_min)
    title = pages.TITLES[page] + (f" · {days} дн." if page == "kpi" else "")
    meta = [
        ("Сформирован", f"{stamp:%d.%m.%Y %H:%M}"),
        ("Подготовил", session.name),
        ("Должность", session.position),
        ("Режим", "симуляция: " + "; ".join(x["title"] for x in sb.result["actions"]) if sb else "живой завод"),
    ]
    if note:
        meta.append(("Комментарий", note))
    body = workbook(title, meta, sheets)
    c.audit.log(
        "export",
        "xlsx",
        f"Выгрузка страницы «{pages.TITLES[page]}» в Excel",
        actor=session.name,
        details={"Комментарий": note},
    )
    name = f"allur_{page}_{stamp:%Y%m%d_%H%M}.xlsx"
    return Response(body, media_type=XLSX, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/log", summary="Отметить в журнале выгрузку PDF/PNG, сделанную в браузере")
def log_client_export(
    c: ContainerDep,
    session: ViewerDep,
    page: str = Query(max_length=40),
    fmt: Literal["pdf", "png"] = "pdf",
    note: str | None = Query(None, max_length=300),
) -> dict:
    c.audit.log(
        "export", fmt, f"Выгрузка страницы «{page}» в {fmt.upper()}", actor=session.name, details={"Комментарий": note}
    )
    return {"ok": True}
