from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime

from sqlalchemy import select

from app.core.clock import plant_now
from app.db.models import DowntimeRecord, ImportLog, ModelPlan, ProductionRecord, QualityRecord, ShiftRow
from app.db.schema import ensure_equipment, ensure_model
from app.ingest import smart
from app.ingest.smart import KIND_TITLES, KINDS, Assigned, Loaded, Resolver
from app.ingest.tables import extract_targets

PREVIEW_ADDED = 40
PREVIEW_UPDATED = 60
PREVIEW_ERRORS = 120


@dataclass
class Block:
    id: str
    sheet: int
    kind: str
    confidence: float
    origin: str
    mapping: dict[str, Assigned]
    skip: bool = False
    rows: list[dict] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class Analysis:
    filename: str
    loaded: Loaded
    profiles: list[list[smart.ColumnProfile]]
    blocks: list[Block]
    review: list[dict]
    targets: dict[str, float]
    notes: list[str]


class ImportService:
    def __init__(self, data, plant, tz_offset_min: int) -> None:
        self.data = data
        self.plant = plant
        self.tz_offset_min = tz_offset_min

    def _shifts(self) -> set[int]:
        try:
            with self.data.db.session() as s:
                nums = set(s.scalars(select(ShiftRow.number)))
        except Exception:
            nums = set()
        return nums or {sh.number for sh in self.plant.shifts}

    def prepare(self, loaded: Loaded) -> tuple[Resolver, list[list[smart.ColumnProfile]]]:
        res = Resolver(self.plant, self._shifts())
        profiles = []
        for sh in loaded.sheets:
            smart.detect_header(sh)
            profiles.append(smart.profile_columns(sh, res))
        return res, profiles

    def low_confidence_sheets(self, loaded: Loaded, profiles) -> list[int]:
        out = []
        for i, sh in enumerate(loaded.sheets):
            if not sh.rows:
                continue
            found = smart.detect_kinds(profiles[i], sh.name)
            if not found or found[0][1] < 0.6:
                out.append(i)
        return out

    def analyze(
        self,
        filename: str,
        loaded: Loaded,
        overrides: dict | None = None,
        ai_hints: dict[int, dict] | None = None,
        prepared: tuple | None = None,
    ) -> Analysis:
        overrides = overrides or {}
        ai_hints = ai_hints or {}
        res, profiles = prepared or self.prepare(loaded)
        blocks: list[Block] = []
        for i, sh in enumerate(loaded.sheets):
            cols = profiles[i]
            auto = smart.detect_kinds(cols, sh.name)
            hint = ai_hints.get(i)
            sheet_blocks: list[Block] = []
            for n, (kind, conf, mapping) in enumerate(auto):
                sheet_blocks.append(Block(f"s{i}-{n}", i, kind, conf, "rules", mapping))
            if hint and hint.get("kind") in KINDS:
                hk = hint["kind"]
                existing = next((b for b in sheet_blocks if b.kind == hk), None)
                if existing is None and (not sheet_blocks or sheet_blocks[0].confidence < 0.6):
                    m = smart.auto_map(hk, cols)
                    existing = Block(f"s{i}-{len(sheet_blocks)}", i, hk, 0.0, "ai", m)
                    sheet_blocks.append(existing)
                if existing is not None:
                    self._apply_map(existing, hint.get("map") or {}, cols, "ИИ", only_weak=True)
                    existing.origin = "ai" if existing.origin == "ai" else "rules+ai"
                    existing.confidence = max(smart.kind_confidence(hk, existing.mapping, sh.name), 0.62)
            n_auto = len(sheet_blocks)
            for bid, ov in overrides.items():
                if not isinstance(ov, dict) or not str(bid).startswith(f"s{i}-"):
                    continue
                try:
                    n = int(str(bid).split("-", 1)[1])
                except ValueError:
                    continue
                block = next((b for b in sheet_blocks if b.id == bid), None)
                kind = ov.get("kind")
                if block is None:
                    if kind not in KINDS or n < n_auto:
                        continue
                    block = Block(bid, i, kind, 0.0, "user", smart.auto_map(kind, cols))
                    sheet_blocks.append(block)
                if kind == "skip":
                    block.skip = True
                elif kind in KINDS and kind != block.kind:
                    block.kind = kind
                    block.mapping = smart.auto_map(kind, cols)
                    block.origin = "user"
                if isinstance(ov.get("map"), dict):
                    self._apply_map(block, ov["map"], cols, "вручную", only_weak=False)
                    if block.origin == "rules":
                        block.origin = "rules+user"
                block.confidence = smart.kind_confidence(block.kind, block.mapping, sh.name)
            blocks.extend(sheet_blocks)

        dated = [b for b in blocks if b.kind != "model_plan"]
        rest = [b for b in blocks if b.kind == "model_plan"]
        months: Counter = Counter()
        for b in dated + rest:
            if b.kind == "model_plan":
                default_month = (
                    months.most_common(1)[0][0] if months else plant_now(self.tz_offset_min).strftime("%Y-%m")
                )
            else:
                default_month = ""
            self._normalize(b, loaded.sheets[b.sheet], res, default_month)
            if b.kind == "model_plan" and b.mapping["month"].column is None and b.rows:
                b.notes.append(f"Колонки «Месяц» нет — план отнесён к {default_month} (по датам в других листах).")
            if not b.skip:
                for r in b.rows:
                    if "day" in r["rec"]:
                        months[r["rec"]["day"].strftime("%Y-%m")] += 1
        blocks.sort(key=lambda b: (b.sheet, b.id))
        self._diff(blocks)
        notes = []
        for sh in loaded.sheets:
            if sh.skipped_totals:
                notes.append(f"Лист «{sh.name}»: пропущено строк итогов — {sh.skipped_totals}")
        return Analysis(
            filename,
            loaded,
            profiles,
            blocks,
            self._review(blocks),
            extract_targets(loaded.text) if loaded.text else {},
            notes,
        )

    @staticmethod
    def _apply_map(block: Block, overrides: dict, cols, how: str, only_weak: bool) -> None:
        valid = {f.name for f in KINDS[block.kind]}
        for fname, col in overrides.items():
            if fname not in valid:
                continue
            cur = block.mapping.get(fname)
            if only_weak and cur and cur.column is not None and cur.confidence >= 0.75:
                continue
            if col is None or col == "" or col == -1:
                block.mapping[fname] = Assigned(None, 0.0, how)
                continue
            try:
                ci = int(col)
            except (TypeError, ValueError):
                continue
            if not 0 <= ci < len(cols):
                continue
            for other, a in block.mapping.items():
                if other != fname and a.column == ci:
                    block.mapping[other] = Assigned(None, 0.0, "")
            block.mapping[fname] = Assigned(ci, 1.0 if how == "вручную" else 0.7, how)

    def _normalize(self, b: Block, sheet: smart.Sheet, res: Resolver, default_month: str) -> None:
        b.rows, b.errors = [], []
        if b.skip:
            return
        mapping = {k: a.column for k, a in b.mapping.items()}
        factors = {k: smart.unit_factor(b.kind, k, sheet.header[a]) for k, a in mapping.items() if a is not None}
        for k, f in factors.items():
            if f == 60.0:
                b.notes.append(f"«{sheet.header[mapping[k]]}» в часах — переведено в минуты")
            elif f != 1.0 and k == "run_hours":
                b.notes.append(f"«{sheet.header[mapping[k]]}» в минутах — переведено в часы")
        missing = [f.label for f in KINDS[b.kind] if f.required and mapping.get(f.name) is None]
        one_of = smart.ONE_OF.get(b.kind)
        if one_of and all(mapping.get(n) is None for n in one_of):
            missing.append(" или ".join(smart._label(b.kind, n) for n in one_of))
        if missing:
            b.errors.append({"row": None, "message": "Не сопоставлены обязательные поля: " + ", ".join(missing)})
            return
        if b.kind in ("production", "quality", "downtime") and mapping.get("shift") is None:
            b.notes.append("Колонки «Смена» нет — строки записываются как 1-я смена.")
        seen: dict[tuple, dict] = {}
        for n, cells in sheet.rows:
            try:
                rec = smart.normalize_row(b.kind, mapping, factors, cells, res, default_month)
            except ValueError as e:
                b.errors.append({"row": n, "message": str(e)})
                continue
            key = smart.natural_key(b.kind, rec)
            prev = seen.get(key)
            if prev is not None:
                if b.kind == "downtime" and not rec.get("started_at"):
                    prev["rec"]["minutes"] = round(prev["rec"]["minutes"] + rec["minutes"], 2)
                    prev["merged"].append(n)
                    continue
                prev["status"] = "duplicate"
                prev["dup_of"] = n
            row = {"row": n, "rec": rec, "key": key, "status": "new", "merged": []}
            seen[key] = row
            b.rows.append(row)
        merged = sum(len(r["merged"]) for r in b.rows)
        if merged:
            b.notes.append(f"Повторяющиеся простои (то же оборудование, причина и смена) суммированы: {merged} строк")

    def _existing(self, kind: str) -> dict[tuple, object]:
        ds = self.data.dataset()
        out: dict[tuple, object] = {}
        if kind == "production":
            for r in ds.production:
                out.setdefault((r.day, r.shift, r.area), r)
        elif kind == "quality":
            for r in ds.quality:
                out.setdefault((r.day, r.shift, r.area), r)
        elif kind == "downtime":
            for r in ds.downtime:
                if r.started_at:
                    out.setdefault((r.day, r.shift, r.equipment, r.started_at.replace(second=0, microsecond=0)), r)
                out.setdefault((r.day, r.shift, r.equipment, r.reason.lower()), r)
        elif kind == "model_plan":
            for r in ds.model_plan:
                out.setdefault((r.month, r.model), r)
        return out

    def _diff(self, blocks: list[Block]) -> None:
        cache: dict[str, dict] = {}
        for b in blocks:
            if b.skip or b.kind not in smart.IMPORTABLE:
                continue
            existing = cache.setdefault(b.kind, self._existing(b.kind))
            for r in b.rows:
                if r["status"] == "duplicate":
                    continue
                old = existing.get(r["key"])
                if old is None:
                    r["status"] = "new"
                    continue
                changes = []
                for f in smart.COMPARE[b.kind]:
                    if f not in r["rec"]:
                        continue
                    ov, nv = getattr(old, f, None), r["rec"][f]
                    if b.kind == "downtime" and f == "reason" and not r["rec"].get("started_at"):
                        continue
                    if not _same(ov, nv):
                        changes.append({"field": f, "label": smart.FIELD_LABELS[f], "old": ov, "new": nv})
                r["changes"] = changes
                r["status"] = "update" if changes else "same"

    def _review(self, blocks: list[Block]) -> list[dict]:
        out: list[dict] = []
        today = plant_now(self.tz_offset_min).date()
        known_eq = {e.code for e in self.plant.equipment}
        ds = self.data.dataset()
        hist: dict[str, list[float]] = {}
        for q in ds.quality[-2000:]:
            if q.produced:
                hist.setdefault(q.area, []).append(q.defects / q.produced * 100)
        typical = {k: sorted(v)[len(v) // 2] for k, v in hist.items() if v}
        names = {a.code: a.name for a in self.plant.areas}

        def add(level: str, text: str) -> None:
            if len(out) < 40 and {"level": level, "text": text} not in out:
                out.append({"level": level, "text": text})

        for b in blocks:
            if b.skip:
                continue
            for row in b.rows:
                r = row["rec"]
                day = r.get("day")
                if day and day > today:
                    add("warning", f"{day:%d.%m.%Y}: дата в будущем — проверьте год")
                if day and (today - day).days > 400:
                    add("info", f"{day:%d.%m.%Y}: данные старше года — в прогнозах почти не учитываются")
                if b.kind == "production":
                    plan, fact = r["plan"], r["fact"]
                    area = names.get(r["area"], r["area"])
                    if plan and fact > plan * 1.15:
                        add(
                            "warning",
                            f"{area} {day:%d.%m}, смена {r['shift']}: факт {fact:.0f} больше плана {plan:.0f} на "
                            f"{(fact / plan - 1) * 100:.0f}% — опечатка или сверхурочные?",
                        )
                    if r.get("run_hours", 0) > 8.5:
                        add("warning", f"{area} {day:%d.%m}: {r['run_hours']:g} ч работы — больше смены")
                elif b.kind == "quality" and r["produced"]:
                    pct = r["defects"] / r["produced"] * 100
                    norm_pct = typical.get(r["area"], self.plant.targets.defect_pct)
                    if pct > max(norm_pct * 2.5, self.plant.targets.defect_pct * 2):
                        add(
                            "warning",
                            f"{names.get(r['area'], r['area'])} {day:%d.%m}: брак {pct:.1f}% — в "
                            f"{pct / max(norm_pct, 0.1):.0f} раз выше обычного ({norm_pct:.1f}%)".replace(".", ","),
                        )
                elif b.kind == "downtime":
                    if r["minutes"] > 240:
                        add(
                            "warning",
                            f"{r['equipment']} {day:%d.%m}: простой {r['minutes']:.0f} мин — дольше половины смены, "
                            "проверьте единицы (минуты, не часы)",
                        )
                    if r["equipment"] not in known_eq:
                        add(
                            "info", f"Оборудования «{r['equipment']}» нет в схеме завода — будет добавлено в справочник"
                        )
        return out

    def to_dict(self, a: Analysis) -> dict:
        names = {ar.code: ar.name for ar in self.plant.areas}
        sheets = []
        for i, sh in enumerate(a.loaded.sheets):
            sheets.append(
                {
                    "index": i,
                    "name": sh.name,
                    "header_row": sh.lines[sh.header_row] if sh.lines else sh.header_row + 1,
                    "rows": len(sh.rows),
                    "columns": [{"index": c.index, "name": c.name, "samples": c.samples} for c in a.profiles[i]],
                    "blocks": [b.id for b in a.blocks if b.sheet == i],
                }
            )
        blocks = []
        totals = Counter()
        for b in a.blocks:
            sh = a.loaded.sheets[b.sheet]
            importable = b.kind in smart.IMPORTABLE and not b.skip
            counts = Counter(r["status"] for r in b.rows)
            counts["invalid"] = sum(1 for e in b.errors if e["row"] is not None)
            if importable:
                for k in ("new", "update", "same", "invalid", "duplicate"):
                    totals[k] += counts.get(k, 0)
            fields = []
            for spec in KINDS[b.kind]:
                m = b.mapping.get(spec.name) or Assigned(None, 0.0, "")
                fields.append(
                    {
                        "name": spec.name,
                        "label": spec.label,
                        "required": spec.required or spec.name in smart.ONE_OF.get(b.kind, ()),
                        "column": m.column,
                        "column_name": sh.header[m.column] if m.column is not None else None,
                        "confidence": m.confidence,
                        "how": m.how,
                    }
                )
            notes = list(b.notes)
            if b.kind == "staff":
                notes.append(
                    "Сотрудников заводят в разделе «Сотрудники» (с PIN и ролью) — из файла они не загружаются."
                )
            blocks.append(
                {
                    "id": b.id,
                    "sheet": b.sheet,
                    "sheet_name": sh.name,
                    "kind": b.kind,
                    "kind_title": KIND_TITLES[b.kind],
                    "importable": importable,
                    "skip": b.skip,
                    "confidence": b.confidence,
                    "origin": b.origin,
                    "fields": fields,
                    "counts": {k: counts.get(k, 0) for k in ("new", "update", "same", "invalid", "duplicate")},
                    "added": [
                        {
                            "row": r["row"],
                            "key": _key_label(b.kind, r["rec"], names),
                            "values": _values(b.kind, r["rec"], names),
                        }
                        for r in b.rows
                        if r["status"] == "new"
                    ][:PREVIEW_ADDED],
                    "updated": [
                        {
                            "row": r["row"],
                            "key": _key_label(b.kind, r["rec"], names),
                            "changes": [
                                {"label": c["label"], "old": _show(c["old"], names), "new": _show(c["new"], names)}
                                for c in r["changes"]
                            ],
                        }
                        for r in b.rows
                        if r["status"] == "update"
                    ][:PREVIEW_UPDATED],
                    "errors": [{"row": e["row"], "message": e["message"]} for e in b.errors[:PREVIEW_ERRORS]]
                    + [
                        {"row": r["row"], "message": f"повтор ключа — используется строка {r['dup_of']}"}
                        for r in b.rows
                        if r["status"] == "duplicate"
                    ][:20],
                    "notes": notes,
                }
            )
        return {
            "filename": a.filename,
            "format": a.loaded.fmt,
            "sheets": sheets,
            "blocks": blocks,
            "totals": {k: totals.get(k, 0) for k in ("new", "update", "same", "invalid", "duplicate")},
            "review": a.review,
            "targets": a.targets,
            "notes": a.notes,
            "kinds": [{"value": k, "label": t, "importable": k in smart.IMPORTABLE} for k, t in KIND_TITLES.items()],
            "fields": {k: [{"name": f.name, "label": f.label} for f in specs] for k, specs in KINDS.items()},
        }

    def apply(self, a: Analysis, role: str, source: str = "import") -> dict:
        written = Counter()
        per_table: list[dict] = []
        with self.data.db.session() as s:
            for b in a.blocks:
                if b.skip or b.kind not in smart.IMPORTABLE:
                    continue
                n_new = n_upd = 0
                for r in b.rows:
                    if r["status"] not in ("new", "update"):
                        continue
                    getattr(self, f"_write_{b.kind}")(s, r["rec"], source)
                    if r["status"] == "new":
                        n_new += 1
                    else:
                        n_upd += 1
                    s.flush()
                written["new"] += n_new
                written["update"] += n_upd
                per_table.append(
                    {
                        "kind": b.kind,
                        "title": KIND_TITLES[b.kind],
                        "sheet": a.loaded.sheets[b.sheet].name,
                        "rows": n_new + n_upd,
                        "new": n_new,
                        "updated": n_upd,
                        "errors": sum(1 for e in b.errors if e["row"] is not None),
                    }
                )
            errors = [
                f"{a.loaded.sheets[b.sheet].name}, строка {e['row']}: {e['message']}"
                for b in a.blocks
                if not b.skip and b.kind in smart.IMPORTABLE
                for e in b.errors
                if e["row"] is not None
            ]
            s.add(
                ImportLog(
                    created_at=datetime.now(),
                    filename=a.filename[:200],
                    role=role,
                    summary={
                        "tables": per_table,
                        "errors": errors[:50],
                        "targets": a.targets,
                        "new": written["new"],
                        "updated": written["update"],
                    },
                )
            )
        self.data.touch()
        return {"tables": per_table, "new": written["new"], "updated": written["update"], "errors": errors}

    def _write_production(self, s, rec: dict, source: str) -> None:
        rows = list(
            s.scalars(
                select(ProductionRecord).where(
                    ProductionRecord.day == rec["day"],
                    ProductionRecord.shift == rec["shift"],
                    ProductionRecord.area == rec["area"],
                )
            )
        )
        row = rows[0] if rows else ProductionRecord(day=rec["day"], shift=rec["shift"], area=rec["area"])
        for extra in rows[1:]:
            s.delete(extra)
        row.line = self.plant.area(rec["area"]).line or rec["area"]
        row.plan = int(rec["plan"])
        row.fact = int(rec["fact"])
        if "run_hours" in rec or row.run_hours is None:
            row.run_hours = float(rec.get("run_hours", 8.0))
        if "load_pct" in rec:
            row.load_pct = rec["load_pct"]
        elif row.load_pct is None:
            row.load_pct = round(row.run_hours / 8 * 100)
        row.source = source
        if not rows:
            s.add(row)

    def _write_quality(self, s, rec: dict, source: str) -> None:
        rows = list(
            s.scalars(
                select(QualityRecord).where(
                    QualityRecord.day == rec["day"],
                    QualityRecord.shift == rec["shift"],
                    QualityRecord.area == rec["area"],
                )
            )
        )
        row = rows[0] if rows else QualityRecord(day=rec["day"], shift=rec["shift"], area=rec["area"])
        for extra in rows[1:]:
            s.delete(extra)
        row.produced = int(rec["produced"])
        row.defects = int(rec["defects"])
        row.source = source
        if not rows:
            s.add(row)

    def _write_downtime(self, s, rec: dict, source: str) -> None:
        q = select(DowntimeRecord).where(
            DowntimeRecord.day == rec["day"],
            DowntimeRecord.shift == rec["shift"],
            DowntimeRecord.equipment == rec["equipment"],
        )
        candidates = list(s.scalars(q))
        if rec.get("started_at"):
            rows = [
                r
                for r in candidates
                if r.started_at and r.started_at.replace(second=0, microsecond=0) == rec["started_at"]
            ]
        else:
            rows = [r for r in candidates if r.reason.lower() == rec["reason"].lower()]
        ensure_equipment(s, rec["equipment"], rec["area"])
        row = rows[0] if rows else DowntimeRecord(day=rec["day"], shift=rec["shift"], equipment=rec["equipment"])
        for extra in rows[1:]:
            s.delete(extra)
        row.area = rec["area"]
        row.reason = rec["reason"]
        row.minutes = float(rec["minutes"])
        row.planned = bool(rec["planned"])
        if rec.get("started_at"):
            row.started_at = rec["started_at"]
        row.source = source
        if not rows:
            s.add(row)

    def _write_model_plan(self, s, rec: dict, source: str) -> None:
        ensure_model(s, rec["model"])
        rows = list(
            s.scalars(select(ModelPlan).where(ModelPlan.month == rec["month"], ModelPlan.model == rec["model"]))
        )
        row = rows[0] if rows else ModelPlan(month=rec["month"], model=rec["model"])
        for extra in rows[1:]:
            s.delete(extra)
        row.plan = int(rec["plan"])
        row.source = source
        if not rows:
            s.add(row)


def _same(a, b) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(float(a) - float(b)) < 1e-6
    if isinstance(a, str) and isinstance(b, str):
        return a.strip().lower() == b.strip().lower()
    return a == b


def _show(v, names: dict) -> str:
    if v is None:
        return "—"
    if isinstance(v, bool):
        return "да" if v else "нет"
    if isinstance(v, float):
        return f"{v:g}".replace(".", ",")
    if isinstance(v, datetime):
        return v.strftime("%d.%m.%Y %H:%M")
    if isinstance(v, date):
        return v.strftime("%d.%m.%Y")
    if isinstance(v, str) and v in names:
        return names[v]
    return str(v)


def _key_label(kind: str, rec: dict, names: dict) -> str:
    if kind in ("production", "quality"):
        return f"{rec['day']:%d.%m.%Y} · смена {rec['shift']} · {names.get(rec['area'], rec['area'])}"
    if kind == "downtime":
        tail = f"{rec['started_at']:%H:%M}" if rec.get("started_at") else rec["reason"]
        return f"{rec['day']:%d.%m.%Y} · смена {rec['shift']} · {rec['equipment']} · {tail}"
    if kind == "model_plan":
        return f"{rec['month']} · {rec['model']}"
    return str(rec.get("name", ""))


def _values(kind: str, rec: dict, names: dict) -> dict[str, str]:
    keys = smart.COMPARE.get(kind, tuple(rec))
    return {smart.FIELD_LABELS.get(k, k): _show(rec[k], names) for k in keys if k in rec}
