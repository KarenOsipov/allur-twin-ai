from __future__ import annotations

import asyncio
import csv
import io
import json
import re
from typing import Literal

from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import Response, StreamingResponse

from app.api.deps import AdminDep, ContainerDep, ViewerDep
from app.core.errors import ValidationFailed
from app.ingest import ai_mapping, smart
from app.ingest.tables import UnsupportedFile
from app.schemas.requests import EconomicsIn, TextImportIn
from app.services import dataset_service
from app.services.import_service import ImportService

router = APIRouter(tags=["Данные"])

ALLOWED = (".docx", ".xlsx", ".xlsm", ".csv", ".tsv", ".txt", ".json", ".xls")


@router.get("/data/checks", summary="Противоречия и риски в данных заказчика")
def checks(c: ContainerDep, _: ViewerDep) -> list[dict]:
    return c.analytics.checks()


@router.get("/data/summary", summary="Сколько и каких данных загружено")
def summary(c: ContainerDep, _: ViewerDep) -> dict:
    ds = c.data.dataset()
    by_source: dict[str, int] = {}
    for r in ds.production:
        by_source[r.source] = by_source.get(r.source, 0) + 1
    days = ds.days
    return {
        "first_day": days[0] if days else None,
        "last_day": days[-1] if days else None,
        "days": len(days),
        "rows": {
            "production": len(ds.production),
            "quality": len(ds.quality),
            "downtime": len(ds.downtime),
            "model_output": len(ds.model_output),
            "model_plan": len(ds.model_plan),
        },
        "production_by_source": by_source,
        "imports": [
            {
                "id": i.id,
                "created_at": i.created_at,
                "filename": i.filename,
                "role": i.role,
                **i.summary,
            }
            for i in c.data.imports()
        ],
    }


@router.get("/data/table/{kind}", summary="Строки таблицы (последние сверху)")
def table(
    kind: Literal["production", "quality", "downtime", "model_plan"],
    c: ContainerDep,
    _: ViewerDep,
    source: Literal["customer", "history", "live", "import"] | None = None,
    limit: int = Query(200, ge=1, le=2000),
) -> list[dict]:
    ds = c.data.dataset()
    rows = getattr(ds, kind)
    if source:
        rows = [r for r in rows if r.source == source]
    rows = list(reversed(rows))[:limit]
    cols = [col.name for col in rows[0].__table__.columns if col.name != "id"] if rows else []
    return [{k: getattr(r, k) for k in cols} for r in rows]


def _pulse(c) -> dict:
    f = c.analytics.month_forecast()
    q = {x["area"]: x["level"] for x in c.analytics.quality()}
    return {
        "forecast": f.get("expected") if f.get("available") else None,
        "probability": f.get("probability") if f.get("available") else None,
        "quality": q,
    }


def _diff(before: dict, after: dict, c) -> list[str]:
    out = []
    if before["forecast"] != after["forecast"] and after["forecast"] is not None:
        out.append(
            f"Прогноз месяца: {before['forecast']} → {after['forecast']} авто "
            f"(вероятность плана {before['probability']}% → {after['probability']}%)"
        )
    names = {a.code: a.name for a in c.plant.areas}
    for k, v in after["quality"].items():
        old = before["quality"].get(k)
        if old is not None and abs(v - old) >= 0.05:
            out.append(f"Брак {names.get(k, k).lower()} по тренду: {old:.2f}% → {v:.2f}%".replace(".", ","))
    return out


def _import_response(c, result, before: dict, session) -> dict:
    after = _pulse(c)
    c.live.calibrate(c.analytics.current_defect_levels())
    changes = _diff(before, after, c)
    c.audit.log(
        "data",
        "import",
        f"Загружено «{result.filename}»: {result.total_rows} строк",
        actor=session.name,
        severity="warning" if result.errors or any(r["level"] == "warning" for r in result.review) else "info",
        details={
            "Таблицы": ", ".join(t["title"] for t in result.tables if "title" in t),
            "Ошибок": len(result.errors),
            "Замечаний": len(result.review),
        },
    )
    return {
        "filename": result.filename,
        "tables": result.tables,
        "rows": result.total_rows,
        "targets": result.targets,
        "notes": result.notes,
        "errors": result.errors[:50],
        "review": result.review,
        "changes": changes,
    }


@router.post("/data/import", summary="Загрузить файл: .docx, .xlsx, .csv, .tsv, .txt, .json")
async def import_file(c: ContainerDep, session: AdminDep, file: UploadFile = File(...)) -> dict:
    name = re.sub(r"[^\w.\- ]", "_", file.filename or "upload")[:120]
    if not name.lower().endswith(ALLOWED):
        raise ValidationFailed("Поддерживаются .docx, .xlsx, .csv, .tsv, .txt и .json — или вставьте таблицу текстом")
    limit = c.settings.max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise ValidationFailed(f"Файл больше {c.settings.max_upload_mb} МБ")
    before = _pulse(c)
    try:
        result = await asyncio.to_thread(c.data.import_file, name, data, session.role.value)
    except UnsupportedFile as e:
        raise ValidationFailed(str(e)) from e
    except Exception as e:
        raise ValidationFailed("Не удалось прочитать файл. Проверьте, что он открывается в Word/Excel.") from e
    return _import_response(c, result, before, session)


@router.post("/data/import-text", summary="Загрузить таблицу, вставленную текстом (из Excel, письма, мессенджера)")
async def import_text(body: TextImportIn, c: ContainerDep, session: AdminDep) -> dict:
    before = _pulse(c)
    try:
        result = await asyncio.to_thread(c.data.import_text, body.name, body.text, session.role.value)
    except UnsupportedFile as e:
        raise ValidationFailed(str(e)) from e
    return _import_response(c, result, before, session)


def _json_form(raw: str | None, what: str) -> dict:
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValidationFailed(f"Некорректные {what}") from e
    if not isinstance(obj, dict):
        raise ValidationFailed(f"Некорректные {what}")
    return obj


async def _load_upload(c, file: UploadFile | None, text: str | None, name: str | None) -> tuple[str, smart.Loaded]:
    if file is not None:
        fname = re.sub(r"[^\w.\- ]", "_", file.filename or "upload")[:120]
        if not fname.lower().endswith(ALLOWED):
            raise ValidationFailed("Поддерживаются .xlsx, .xls, .csv, .tsv, .txt, .json и .docx")
        limit = c.settings.max_upload_mb * 1024 * 1024
        data = await file.read(limit + 1)
        if len(data) > limit:
            raise ValidationFailed(f"Файл больше {c.settings.max_upload_mb} МБ")
        if not data:
            raise ValidationFailed("Файл пустой")
        loader = smart.load
        args: tuple = (fname, data)
    elif text and text.strip():
        fname = (name or "вставка из буфера")[:120]
        loader = smart.load_text
        args = (fname, text[:2_000_000])
    else:
        raise ValidationFailed("Выберите файл или вставьте таблицу")
    try:
        loaded = await asyncio.to_thread(loader, *args)
    except UnsupportedFile as e:
        raise ValidationFailed(str(e)) from e
    except Exception as e:
        raise ValidationFailed("Не удалось прочитать файл. Проверьте, что он открывается в Excel.") from e
    if not loaded.sheets:
        raise ValidationFailed("В файле нет таблиц с данными")
    return fname, loaded


def _hints(raw: dict) -> dict[int, dict]:
    out = {}
    for k, v in raw.items():
        try:
            out[int(k)] = v
        except (TypeError, ValueError):
            continue
    return out


@router.post("/data/analyze", summary="Анализ файла: тип данных, сопоставление колонок, что добавится и обновится")
async def analyze_file(
    c: ContainerDep,
    session: AdminDep,
    file: UploadFile | None = File(None),
    text: str | None = Form(None),
    name: str | None = Form(None),
    overrides: str | None = Form(None),
    ai_hints: str | None = Form(None),
    use_ai: bool = Form(True),
) -> dict:
    fname, loaded = await _load_upload(c, file, text, name)
    svc = ImportService(c.data, c.plant, c.settings.tz_offset_min)
    prepared = await asyncio.to_thread(svc.prepare, loaded)
    hints = _hints(_json_form(ai_hints, "подсказки ИИ"))
    ai_note = ""
    if use_ai and not hints:
        weak = svc.low_confidence_sheets(loaded, prepared[1])
        hints, ai_note = await ai_mapping.suggest(c.settings, c.assistant.llm.enabled, loaded.sheets, prepared[1], weak)
    analysis = await asyncio.to_thread(
        svc.analyze, fname, loaded, _json_form(overrides, "настройки сопоставления"), hints, prepared
    )
    out = svc.to_dict(analysis)
    out["ai"] = {
        "available": c.assistant.llm.enabled,
        "used": bool(hints),
        "note": ai_note,
        "hints": {str(k): v for k, v in hints.items()},
    }
    return out


@router.post("/data/apply", summary="Применить проанализированный файл: добавить и обновить строки")
async def apply_file(
    c: ContainerDep,
    session: AdminDep,
    file: UploadFile | None = File(None),
    text: str | None = Form(None),
    name: str | None = Form(None),
    overrides: str | None = Form(None),
    ai_hints: str | None = Form(None),
) -> dict:
    fname, loaded = await _load_upload(c, file, text, name)
    svc = ImportService(c.data, c.plant, c.settings.tz_offset_min)
    hints = _hints(_json_form(ai_hints, "подсказки ИИ"))
    analysis = await asyncio.to_thread(
        svc.analyze, fname, loaded, _json_form(overrides, "настройки сопоставления"), hints
    )
    before = _pulse(c)
    result = await asyncio.to_thread(svc.apply, analysis, session.role.value)
    after = _pulse(c)
    c.live.calibrate(c.analytics.current_defect_levels())
    changes = _diff(before, after, c)
    total = result["new"] + result["updated"]
    c.audit.log(
        "data",
        "import",
        f"Загружено «{fname}»: добавлено {result['new']}, обновлено {result['updated']} строк",
        actor=session.name,
        severity="warning" if result["errors"] or any(r["level"] == "warning" for r in analysis.review) else "info",
        details={
            "Таблицы": ", ".join(f"{t['title']} ({t['sheet']})" for t in result["tables"]),
            "Добавлено": result["new"],
            "Обновлено": result["updated"],
            "Ошибок": len(result["errors"]),
        },
    )
    return {
        "filename": fname,
        "rows": total,
        "new": result["new"],
        "updated": result["updated"],
        "tables": result["tables"],
        "errors": result["errors"][:50],
        "review": analysis.review,
        "changes": changes,
        "targets": analysis.targets,
    }


@router.get("/data/dataset.json", summary="Выгрузить весь набор данных проекта (для переноса)")
def dataset_export(c: ContainerDep, session: AdminDep) -> Response:
    data = dataset_service.export(c.db)
    c.audit.log(
        "export",
        "dataset",
        "Выгружен набор данных проекта",
        actor=session.name,
        details={k: v for k, v in data["counts"].items() if v},
    )
    body = json.dumps(data, ensure_ascii=False, indent=1).encode()
    return Response(
        body, media_type="application/json", headers={"Content-Disposition": 'attachment; filename="dataset.json"'}
    )


@router.post("/data/dataset", summary="Загрузить набор данных проекта (заменяет разделы из файла)")
async def dataset_import(c: ContainerDep, session: AdminDep, file: UploadFile = File(...)) -> dict:
    limit = 30 * 1024 * 1024
    raw = await file.read(limit + 1)
    if len(raw) > limit:
        raise ValidationFailed("Файл набора больше 30 МБ")
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ValidationFailed("Файл не читается как JSON") from e
    counts = await asyncio.to_thread(dataset_service.load, c.db, data)
    c.data.touch()
    c.params._cache = None
    c.economics._cache = None
    c.live.apply_params(c.params.sim_overrides())
    c.live.calibrate(c.analytics.current_defect_levels())
    c.users._active.clear()
    c.users._migrate()
    c.floor_layout.ensure_default()
    c.events.publish("floor.layout", {"id": c.floor_layout.active_id()})
    c.events.publish("params.changed", {"changes": []})
    c.audit.log(
        "data",
        "dataset",
        "Загружен набор данных проекта",
        actor=session.name,
        severity="warning",
        details={k: v for k, v in counts.items()},
    )
    return {"ok": True, "counts": counts}


@router.post("/data/reset", summary="Вернуть демо-данные к исходным")
async def reset(c: ContainerDep, session: AdminDep) -> dict:
    await asyncio.to_thread(c.data.reset, c.settings.history_days)
    c.live.calibrate(c.analytics.current_defect_levels())
    c.audit.log("data", "reset", "Данные возвращены к исходным (демо)", actor=session.name, severity="warning")
    return {"ok": True}


@router.get("/data/export/{kind}.csv", summary="Выгрузить таблицу в CSV (для Excel)")
def export(
    kind: Literal["production", "quality", "downtime"], c: ContainerDep, session: ViewerDep
) -> StreamingResponse:
    ds = c.data.dataset()
    c.audit.log("export", "csv", f"Выгрузка таблицы «{kind}» в CSV", actor=session.name)
    rows = getattr(ds, kind)
    buf = io.StringIO()
    buf.write("﻿")
    if rows:
        cols = [col.name for col in rows[0].__table__.columns if col.name != "id"]
        w = csv.writer(buf, delimiter=";")
        w.writerow(cols)
        for r in rows:
            w.writerow([_fmt(getattr(r, k)) for k in cols])
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="allur_{kind}.csv"'},
    )


def _fmt(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:g}".replace(".", ",")
    if hasattr(v, "strftime"):
        return v.strftime("%d.%m.%Y %H:%M") if hasattr(v, "hour") else v.strftime("%d.%m.%Y")
    s = str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@") else s


@router.get("/settings/economics", summary="Экономические допущения")
def get_economics(c: ContainerDep, _: ViewerDep) -> dict:
    return c.economics.economics()


@router.put("/settings/economics", summary="Изменить экономические допущения")
def put_economics(body: EconomicsIn, c: ContainerDep, session: AdminDep) -> dict:
    values = body.model_dump(exclude_none=True)
    result = c.economics.update(values)
    c.data.touch()
    names = {
        "margin_per_car_kzt": "Маржа с автомобиля, ₸",
        "rework_cost_kzt": "Стоимость переделки, ₸",
        "labor_rate_kzt_h": "Час работы, ₸",
        "overtime_rate_kzt_h": "Час сверхурочных, ₸",
        "line_staff": "Рабочих на линии",
    }
    c.audit.log(
        "data",
        "economics",
        "Изменены экономические допущения",
        actor=session.name,
        details={
            names.get(k, k): (", ".join(f"{a}: {b:g}" for a, b in v.items()) if isinstance(v, dict) else v)
            for k, v in values.items()
        },
    )
    return result
