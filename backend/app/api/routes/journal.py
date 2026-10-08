from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Query
from fastapi.responses import Response

from app.api.deps import ContainerDep, ViewerDep
from app.core.clock import plant_now
from app.core.security import Permission
from app.services.audit_service import CATEGORIES, SEVERITY
from app.services.excel import Sheet, workbook

router = APIRouter(prefix="/journal", tags=["Журнал"])

Category = Literal[
    "auth",
    "control",
    "incident",
    "shift",
    "simulation",
    "scenario",
    "data",
    "assistant",
    "export",
    "builder",
    "users",
    "system",
]
Severity = Literal["info", "warning", "critical"]


def _filters(category, severity, actor, q, since, until) -> dict:
    return {"category": category, "severity": severity, "actor": actor, "q": q, "since": since, "until": until}


@router.get("", summary="События: действия людей, цех, симуляции, данные, ошибки")
def journal(
    c: ContainerDep,
    session: ViewerDep,
    category: Category | None = None,
    severity: Severity | None = None,
    actor: str | None = Query(None, max_length=60),
    q: str | None = Query(None, max_length=80),
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict:
    return c.audit.query(
        **_filters(category, severity, actor, q, since, until),
        limit=limit,
        offset=offset,
        show_private=session.can(Permission.MANAGE_DATA),
    )


@router.get("/export.{fmt}", summary="Выгрузить журнал (с теми же фильтрами)")
def export(
    fmt: Literal["xlsx", "csv"],
    c: ContainerDep,
    session: ViewerDep,
    category: Category | None = None,
    severity: Severity | None = None,
    actor: str | None = Query(None, max_length=60),
    q: str | None = Query(None, max_length=80),
    since: datetime | None = None,
    until: datetime | None = None,
) -> Response:
    data = c.audit.query(
        **_filters(category, severity, actor, q, since, until),
        limit=20_000,
        show_private=session.can(Permission.MANAGE_DATA),
    )
    cols = ["Время", "Время цеха", "Категория", "Важность", "Кто", "Событие", "Подробности"]
    rows = [
        [
            e["at"],
            e["plant_time"],
            e["category_name"],
            SEVERITY.get(e["severity"], e["severity"]),
            e["actor"],
            e["title"],
            "; ".join(f"{k}: {v}" for k, v in e["details"].items()),
        ]
        for e in data["items"]
    ]
    c.audit.log("export", fmt, f"Выгрузка журнала в {fmt.upper()}: {len(rows)} записей", actor=session.name)
    stamp = plant_now(c.settings.tz_offset_min)
    name = f"allur_journal_{stamp:%Y%m%d_%H%M}.{fmt}"
    if fmt == "csv":
        buf = io.StringIO()
        buf.write("﻿")
        w = csv.writer(buf, delimiter=";")
        w.writerow(cols)
        for r in rows:
            w.writerow([_csv(v) for v in r])
        body, media = buf.getvalue().encode("utf-8"), "text/csv; charset=utf-8"
    else:
        meta = [
            ("Сформирован", f"{stamp:%d.%m.%Y %H:%M}"),
            ("Подготовил", session.name),
            ("Должность", session.position),
            ("Записей", str(len(rows))),
        ]
        if category:
            meta.append(("Категория", CATEGORIES[category]))
        body = workbook("Журнал событий", meta, [Sheet("Журнал", cols, rows)])
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


def _csv(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.strftime("%d.%m.%Y %H:%M:%S")
    s = str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@") else s
