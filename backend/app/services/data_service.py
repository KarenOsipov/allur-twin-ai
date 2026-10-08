from __future__ import annotations

import logging
import threading
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlalchemy import delete, func, select

from app.core.clock import plant_now
from app.db.base import Database
from app.db.models import (
    DowntimeRecord,
    ImportLog,
    ModelOutput,
    ModelPlan,
    ProductionRecord,
    QualityRecord,
)
from app.db.schema import ensure_equipment, ensure_model
from app.domain.plant import Plant
from app.ingest.history import generate_history
from app.ingest.tables import (
    TABLE_TITLES,
    TableKind,
    extract,
    extract_targets,
    read_document,
    read_text,
)

log = logging.getLogger(__name__)

CUSTOMER_FILE = Path(__file__).resolve().parents[1] / "seed" / "allur_case2_data.docx"
PLANNED_HINTS = ("плановое", "замена", "то ", "обслуживание")


@dataclass
class Dataset:
    production: list[ProductionRecord]
    quality: list[QualityRecord]
    downtime: list[DowntimeRecord]
    model_output: list[ModelOutput]
    model_plan: list[ModelPlan]
    version: int | str

    @property
    def days(self) -> list[date]:
        return sorted({r.day for r in self.production})

    @property
    def last_day(self) -> date | None:
        days = self.days
        return days[-1] if days else None


@dataclass
class ImportResult:
    filename: str
    tables: list[dict] = field(default_factory=list)
    targets: dict[str, float] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    review: list[dict] = field(default_factory=list)

    @property
    def total_rows(self) -> int:
        return sum(t["rows"] for t in self.tables)


class DataService:
    def __init__(self, db: Database, plant: Plant, tz_offset_min: int) -> None:
        self.db = db
        self.plant = plant
        self.tz_offset_min = tz_offset_min
        self._version = 0
        self._cache: Dataset | None = None
        self._lock = threading.Lock()

    def touch(self) -> None:
        with self._lock:
            self._version += 1
            self._cache = None

    def dataset(self) -> Dataset:
        with self._lock:
            if self._cache is not None:
                return self._cache
            with self.db.session() as s:
                ds = Dataset(
                    production=list(s.scalars(select(ProductionRecord).order_by(ProductionRecord.day))),
                    quality=list(s.scalars(select(QualityRecord).order_by(QualityRecord.day))),
                    downtime=list(s.scalars(select(DowntimeRecord).order_by(DowntimeRecord.day))),
                    model_output=list(s.scalars(select(ModelOutput).order_by(ModelOutput.day))),
                    model_plan=list(s.scalars(select(ModelPlan))),
                    version=self._version,
                )
            self._cache = ds
            return ds

    def is_empty(self) -> bool:
        with self.db.session() as s:
            return not (s.scalar(select(func.count(ProductionRecord.id))) or 0)

    def seed_if_empty(self, history_days: int, seed: int = 7) -> None:
        with self.db.session() as s:
            has_data = s.scalar(select(func.count(ProductionRecord.id))) or 0
        if has_data:
            return
        today = plant_now(self.tz_offset_min).date()
        log.info(
            "Первый запуск: генерирую историю за %d дней и загружаю данные заказчика",
            history_days,
        )
        self._write_history(today - timedelta(days=1), history_days, seed)
        if CUSTOMER_FILE.exists():
            result = self.import_file(
                CUSTOMER_FILE.name,
                CUSTOMER_FILE.read_bytes(),
                role="system",
                source="customer",
            )
            log.info(
                "Данные заказчика: %d строк, %s",
                result.total_rows,
                "; ".join(result.notes) or "без замечаний",
            )
        self.touch()

    def reset(self, history_days: int, seed: int = 7) -> None:
        with self.db.session() as s:
            for model in (
                ProductionRecord,
                QualityRecord,
                DowntimeRecord,
                ModelOutput,
                ModelPlan,
                ImportLog,
            ):
                s.execute(delete(model))
        self.touch()
        self.seed_if_empty(history_days, seed)

    def _write_history(self, end_day: date, days: int, seed: int) -> None:
        h = generate_history(self.plant, end_day, days, seed)
        with self.db.session() as s:
            s.add_all(ProductionRecord(**r) for r in h.production)
            s.add_all(QualityRecord(**r) for r in h.quality)
            s.add_all(DowntimeRecord(**r) for r in h.downtime)
            s.add_all(ModelOutput(**r) for r in h.model_output)

    def import_file(self, filename: str, data: bytes, role: str, source: str = "import") -> ImportResult:
        return self.import_document(filename, read_document(filename, data), role, source)

    def import_text(self, name: str, text: str, role: str) -> ImportResult:
        return self.import_document(name, read_text(name, text), role, "import")

    def import_document(self, filename: str, doc, role: str, source: str = "import") -> ImportResult:
        result = ImportResult(filename=filename)
        result.targets = extract_targets(doc.text) if doc.text else {}
        parsed = [p for p in (extract(t) for t in doc.tables) if p is not None]
        if not parsed:
            result.errors.append(
                "Не нашли знакомых таблиц. Нужны колонки как у заказчика: «Дата, Линия, План, Факт…», "
                "«Дата, Участок, Оборудование, Причина…», «Модель, План…» или «Дата, Участок, Выпущено, Брак…»."
            )
            return result

        month = self._infer_month(parsed)
        result.review = self.review(parsed)
        with self.db.session() as s:
            for table in parsed:
                rows, skipped = 0, list(table.errors)
                for rec in table.records:
                    try:
                        if table.kind == TableKind.PRODUCTION:
                            self._upsert_production(s, rec, source)
                        elif table.kind == TableKind.QUALITY:
                            self._upsert_quality(s, rec, source)
                        elif table.kind == TableKind.DOWNTIME:
                            self._upsert_downtime(s, rec, source)
                        else:
                            self._upsert_plan(s, rec, month, source)
                        rows += 1
                    except ValueError as e:
                        skipped.append(str(e))
                result.tables.append(
                    {
                        "kind": table.kind.value,
                        "title": TABLE_TITLES[table.kind],
                        "rows": rows,
                    }
                )
                result.errors.extend(f"{TABLE_TITLES[table.kind]}: {e}" for e in skipped)
            has_daily = any(t.kind in (TableKind.PRODUCTION, TableKind.QUALITY, TableKind.DOWNTIME) for t in parsed)
            if has_daily and not any("shift" in r for t in parsed for r in t.records):
                result.notes.append(
                    "В таблицах нет номера смены. План 120 и время работы до 8 ч соответствуют одной смене, "
                    "поэтому строки записаны как 1-я смена."
                )
            if any(t.kind == TableKind.MODEL_PLAN for t in parsed):
                result.notes.append(f"План по моделям отнесён к месяцу {month} (по датам в других таблицах).")
            s.add(
                ImportLog(
                    created_at=datetime.now(),
                    filename=filename[:200],
                    role=role,
                    summary={
                        "tables": result.tables,
                        "errors": result.errors[:50],
                        "targets": result.targets,
                    },
                )
            )
        self.touch()
        return result

    def review(self, parsed) -> list[dict]:
        out: list[dict] = []
        today = plant_now(self.tz_offset_min).date()
        known_eq = {e.code for e in self.plant.equipment} | {"Поставка"}
        ds = self.dataset()
        hist: dict[str, list[float]] = {}
        for q in ds.quality:
            if q.produced:
                hist.setdefault(q.area, []).append(q.defects / q.produced * 100)
        typical = {k: sorted(v)[len(v) // 2] for k, v in hist.items() if v}

        def add(level: str, text: str) -> None:
            if len(out) < 40:
                out.append({"level": level, "text": text})

        for t in parsed:
            for r in t.records:
                day = r.get("day")
                if day and day > today:
                    add("warning", f"{day:%d.%m.%Y}: дата в будущем — проверьте год")
                if day and (today - day).days > 400:
                    add("info", f"{day:%d.%m.%Y}: данные старше года — в прогнозах почти не учитываются")
                if t.kind == TableKind.PRODUCTION:
                    plan, fact = r.get("plan", 0), r.get("fact", 0)
                    if plan and fact > plan * 1.15:
                        add(
                            "warning",
                            f"{r['line']} {day:%d.%m}: факт {fact:.0f} больше плана {plan:.0f} на "
                            f"{(fact / plan - 1) * 100:.0f}% — опечатка или сверхурочные?",
                        )
                    if r.get("run_hours", 0) > 8.5:
                        add("warning", f"{r['line']} {day:%d.%m}: {r['run_hours']:g} ч работы — больше смены")
                    if plan and fact < plan * 0.6:
                        add(
                            "info",
                            f"{r['line']} {day:%d.%m}: выполнено {fact / plan * 100:.0f}% плана — "
                            "система отметит смену как аномальную",
                        )
                elif t.kind == TableKind.QUALITY:
                    prod, dfc = r.get("produced", 0), r.get("defects", 0)
                    if prod:
                        pct = dfc / prod * 100
                        area = self.plant.area_by_name(r["area"])
                        norm = typical.get(area.code if area else "", self.plant.targets.defect_pct)
                        if pct > max(norm * 2.5, self.plant.targets.defect_pct * 2):
                            add(
                                "warning",
                                f"{r['area']} {day:%d.%m}: брак {pct:.1f}% — в {pct / max(norm, 0.1):.0f} раз "
                                f"выше обычного ({norm:.1f}%)".replace(".", ","),
                            )
                elif t.kind == TableKind.DOWNTIME:
                    if r.get("minutes", 0) > 240:
                        add(
                            "warning",
                            f"{r['equipment']} {day:%d.%m}: простой {r['minutes']:.0f} мин — дольше половины "
                            "смены, проверьте единицы (минуты, не часы)",
                        )
                    if r.get("equipment") not in known_eq:
                        add("info", f"Оборудование «{r['equipment']}» нет в схеме завода — добавлено в справочник")
        return out

    def _infer_month(self, parsed) -> str:
        months = Counter(
            r["day"].strftime("%Y-%m")
            for t in parsed
            if t.kind != TableKind.MODEL_PLAN
            for r in t.records
            if "day" in r
        )
        if months:
            return months.most_common(1)[0][0]
        return plant_now(self.tz_offset_min).strftime("%Y-%m")

    def _area_code(self, name: str) -> str:
        area = self.plant.area_by_name(name)
        if area is None:
            raise ValueError(f"участок «{name}» не найден в схеме завода")
        return area.code

    def _upsert_production(self, s, rec: dict, source: str) -> None:
        area = self._area_code(rec["line"])
        shift = int(rec.get("shift") or 1)
        s.execute(
            delete(ProductionRecord).where(
                ProductionRecord.day == rec["day"],
                ProductionRecord.shift == shift,
                ProductionRecord.area == area,
            )
        )
        run = float(rec.get("run_hours") or 8.0)
        s.add(
            ProductionRecord(
                day=rec["day"],
                shift=shift,
                area=area,
                line=self.plant.area(area).line or rec["line"],
                plan=int(rec["plan"]),
                fact=int(rec["fact"]),
                run_hours=run,
                load_pct=rec.get("load_pct", round(run / 8 * 100)),
                source=source,
            )
        )

    def _upsert_quality(self, s, rec: dict, source: str) -> None:
        area = self._area_code(rec["area"])
        shift = int(rec.get("shift") or 1)
        if rec["defects"] > rec["produced"]:
            raise ValueError(f"{rec['day']:%d.%m.%Y} {rec['area']}: брака больше, чем выпущено")
        s.execute(
            delete(QualityRecord).where(
                QualityRecord.day == rec["day"],
                QualityRecord.shift == shift,
                QualityRecord.area == area,
            )
        )
        s.add(
            QualityRecord(
                day=rec["day"],
                shift=shift,
                area=area,
                produced=int(rec["produced"]),
                defects=int(rec["defects"]),
                source=source,
            )
        )

    def _upsert_downtime(self, s, rec: dict, source: str) -> None:
        area = self._area_code(rec["area"])
        shift = int(rec.get("shift") or 1)
        reason = rec["reason"]
        s.execute(
            delete(DowntimeRecord).where(
                DowntimeRecord.day == rec["day"],
                DowntimeRecord.equipment == rec["equipment"],
                DowntimeRecord.reason == reason,
            )
        )
        planned = any(h in (reason.lower() + " ") for h in PLANNED_HINTS)
        ensure_equipment(s, rec["equipment"], area)
        s.add(
            DowntimeRecord(
                day=rec["day"],
                shift=shift,
                area=area,
                equipment=rec["equipment"],
                reason=reason,
                minutes=float(rec["minutes"]),
                planned=planned,
                source=source,
            )
        )

    def _upsert_plan(self, s, rec: dict, month: str, source: str) -> None:
        ensure_model(s, rec["model"])
        s.execute(delete(ModelPlan).where(ModelPlan.month == month, ModelPlan.model == rec["model"]))
        s.add(ModelPlan(month=month, model=rec["model"], plan=int(rec["plan"]), source=source))

    def imports(self, limit: int = 20) -> list[ImportLog]:
        with self.db.session() as s:
            return list(s.scalars(select(ImportLog).order_by(ImportLog.id.desc()).limit(limit)))

    def record_shift(self, summary: dict) -> None:
        day: date = summary["day"]
        shift: int = summary["shift"]
        plan = self.plant.targets.shift_plan
        with self.db.session() as s:
            already = s.scalar(
                select(ProductionRecord.id)
                .where(ProductionRecord.day == day, ProductionRecord.shift == shift, ProductionRecord.source == "live")
                .limit(1)
            )
            for area in self.plant.lines:
                a = summary["areas"][area.code]
                run_h = round(a["run_s"] / 3600 + (a["starved_s"] + a["blocked_s"]) / 3600, 1)
                for model in (ProductionRecord, QualityRecord):
                    s.execute(
                        delete(model).where(
                            model.day == day,
                            model.shift == shift,
                            model.area == area.code,
                        )
                    )
                s.add(
                    ProductionRecord(
                        day=day,
                        shift=shift,
                        area=area.code,
                        line=area.line,
                        plan=plan,
                        fact=a["output"],
                        run_hours=min(run_h, 8.0),
                        load_pct=round(min(run_h, 8.0) / 8 * 100),
                        source="live",
                    )
                )
                s.add(
                    QualityRecord(
                        day=day,
                        shift=shift,
                        area=area.code,
                        produced=a["output"],
                        defects=a["defects"],
                        source="live",
                    )
                )
            for model_name, qty in ({} if already else summary["models"]).items():
                ensure_model(s, model_name)
                row = s.scalar(select(ModelOutput).where(ModelOutput.day == day, ModelOutput.model == model_name))
                if row is None:
                    s.add(ModelOutput(day=day, model=model_name, qty=qty, source="live"))
                else:
                    row.qty += qty
        self.touch()

    def purge_live_day(self, day: date) -> None:
        with self.db.session() as s:
            s.execute(delete(DowntimeRecord).where(DowntimeRecord.day == day, DowntimeRecord.source == "live"))
        self.touch()

    def record_downtime(self, day: date, shift: int, data: dict) -> None:
        with self.db.session() as s:
            started = data.get("started_at")
            if started is not None and s.scalar(
                select(DowntimeRecord.id).where(
                    DowntimeRecord.equipment == data["equipment"],
                    DowntimeRecord.started_at == started,
                )
            ):
                return
            ensure_equipment(s, data["equipment"], data["area"])
            s.add(
                DowntimeRecord(
                    day=day,
                    shift=shift,
                    area=data["area"],
                    equipment=data["equipment"],
                    reason=data["reason"] or "Отказ",
                    minutes=round(float(data["minutes"]), 1),
                    planned=bool(data.get("planned")),
                    started_at=data.get("started_at"),
                    source="live",
                )
            )
        self.touch()
