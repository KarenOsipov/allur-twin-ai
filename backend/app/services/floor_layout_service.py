from __future__ import annotations

import logging
import re
import threading

from sqlalchemy import select

from app.core.clock import plant_now
from app.db.base import Database
from app.db.models import BuilderLayout, SettingValue
from app.domain.plant import AreaKind, Plant
from app.services.params_service import SUPPLY_DEFAULT, ParamsService

log = logging.getLogger(__name__)

KEY = "floor_layout"

TEMPLATE_IDS = {
    "wh_in": "WH_IN",
    "weld": "WELD",
    "paint": "PAINT",
    "assy": "ASSY",
    "qc": "QC",
    "wh_out": "WH_OUT",
}
TEMPLATE_BUFFERS = {"buf1": "WELD", "buf2": "PAINT", "buf3": "ASSY"}
TEMPLATE_DEFECT = {"WELD": 1.7, "PAINT": 3.5, "ASSY": 1.1}
NAMES = {
    "WH_IN": ("склад комплектов", "склад комплектующих", "склад компонентов"),
    "WELD": ("сварка", "участок сварки", "сварочный участок"),
    "PAINT": ("окраска", "участок окраски", "покраска", "окрасочный участок"),
    "ASSY": ("сборка", "участок сборки", "конвейер сборки", "финальная сборка"),
    "QC": ("контроль качества", "отк", "контроль"),
    "WH_OUT": ("склад готовых авто", "склад готовой продукции", "склад гп", "склад готовых автомобилей"),
}
KINDS = {
    AreaKind.PROCESS: {"station", "assembly"},
    AreaKind.INSPECTION: {"inspection", "station"},
}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower().replace("ё", "е")).strip()


def _fits(plant: Plant, code: str, kind: str) -> bool:
    a = plant.area(code)
    if a.kind == AreaKind.STORE:
        return kind == ("source" if code == plant.areas[0].code else "sink")
    return kind in KINDS[a.kind]


def map_nodes(plant: Plant, data: dict) -> dict[str, dict]:
    nodes = [n for n in data.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("data"), dict)]
    codes = {a.code for a in plant.areas}
    kind = {n["id"]: n["data"].get("kind") or n.get("type") for n in nodes}
    out: dict[str, dict] = {}
    used: set[str] = set()

    def take(nid: str, code: str) -> None:
        if nid in out or code in used or not _fits(plant, code, kind[nid]):
            return
        out[nid] = {"area": code, "role": "area"}
        used.add(code)

    for n in nodes:
        code = n["data"].get("area")
        if code in codes:
            take(n["id"], code)
    for n in nodes:
        if n["id"] in TEMPLATE_IDS:
            take(n["id"], TEMPLATE_IDS[n["id"]])
    for n in nodes:
        name = _norm(n["data"].get("name", ""))
        for code, names in NAMES.items():
            if name in names:
                take(n["id"], code)
                break

    incoming: dict[str, list[str]] = {}
    for e in data.get("edges") or []:
        if isinstance(e, dict):
            incoming.setdefault(e.get("target"), []).append(e.get("source"))
    buffered: set[str] = set()
    for n in nodes:
        if kind[n["id"]] != "buffer":
            continue
        src = incoming.get(n["id"], [])
        code = None
        if len(src) == 1 and out.get(src[0], {}).get("role") == "area":
            code = out[src[0]]["area"]
        elif n["id"] in TEMPLATE_BUFFERS:
            code = TEMPLATE_BUFFERS[n["id"]]
        if code and code not in buffered and plant.area(code).kind == AreaKind.PROCESS:
            out[n["id"]] = {"area": code, "role": "buffer"}
            buffered.add(code)
    return out


def is_standard(plant: Plant, data: dict, mapping: dict[str, dict]) -> bool:
    nodes = data.get("nodes") or []
    if len(mapping) != len(nodes):
        return False
    areas = {m["area"] for m in mapping.values() if m["role"] == "area"}
    return areas == {a.code for a in plant.areas}


class FloorLayoutService:
    def __init__(self, db: Database, plant: Plant, params: ParamsService, tz_offset_min: int) -> None:
        self.db = db
        self.plant = plant
        self.params = params
        self.tz = tz_offset_min
        self._lock = threading.Lock()
        self._syncing = False

    def active_id(self) -> int | None:
        with self.db.session() as s:
            row = s.get(SettingValue, KEY)
            return int(row.value["id"]) if row and row.value and row.value.get("id") else None

    def _set(self, value: dict) -> None:
        with self.db.session() as s:
            row = s.get(SettingValue, KEY)
            if row is None:
                s.add(SettingValue(key=KEY, value=value))
            else:
                row.value = value

    def ensure_default(self) -> None:
        with self.db.session() as s:
            if s.get(SettingValue, KEY) is not None:
                return
            x = s.scalars(
                select(BuilderLayout).where(BuilderLayout.name.like("Аллюр%")).order_by(BuilderLayout.id)
            ).first()
            s.add(SettingValue(key=KEY, value={"id": x.id if x else None, "by": "система"}))

    def current(self) -> dict:
        lid = self.active_id()
        if lid is None:
            return {"id": None}
        with self.db.session() as s:
            x = s.get(BuilderLayout, lid)
            if x is None:
                return {"id": None}
            data = x.data
            mapping = map_nodes(self.plant, data)
            return {
                "id": x.id,
                "name": x.name,
                "data": data,
                "updated_at": x.updated_at,
                "author": x.author,
                "map": mapping,
                "standard": is_standard(self.plant, data, mapping),
            }

    def activate(self, layout_id: int | None, by: str) -> None:
        self._set({"id": layout_id, "by": by, "at": plant_now(self.tz).isoformat(timespec="seconds")})

    def forget(self, layout_id: int) -> bool:
        if self.active_id() == layout_id:
            self._set({"id": None, "by": "система"})
            return True
        return False

    def params_patch(self, data: dict) -> tuple[dict, list[str]]:
        mapping = map_nodes(self.plant, data)
        nodes = {n["id"]: n["data"] for n in data.get("nodes") or [] if isinstance(n, dict)}
        notes: list[str] = []
        areas: dict[str, dict] = {}
        equipment: dict[str, dict] = {}
        supply: dict = {}
        eq_base = {e.code: e for e in self.plant.equipment}
        for nid, m in mapping.items():
            d = nodes[nid]
            a = self.plant.area(m["area"])
            if m["role"] == "buffer":
                cap = _num(d.get("capacity"))
                if cap is not None:
                    v = int(min(max(round(cap), 1), 60))
                    if v != round(cap):
                        notes.append(f"{d.get('name')}: буфер ограничен {v} мест")
                    areas.setdefault(a.code, {})["buffer"] = None if v == a.buffer_after else v
                continue
            if a.kind == AreaKind.STORE:
                rate = _num(d.get("rate_per_hour"))
                if a.code == self.plant.areas[0].code and rate is not None:
                    size = int(min(max(round(rate), 1), 200))
                    supply = {"every_min": None, "size": None if size == SUPPLY_DEFAULT["size"] else size}
                continue
            cyc = _num(d.get("cycle_s"))
            if cyc is not None:
                lo, hi = round(a.cycle_s * 0.5), round(a.cycle_s * 2)
                v = min(max(cyc, lo), hi)
                if v != cyc:
                    notes.append(f"{a.name}: цикл {cyc:g} с вне диапазона модели, взято {v:g} с")
                areas.setdefault(a.code, {})["cycle_s"] = None if abs(v - a.cycle_s) < 1e-6 else v
            if a.kind == AreaKind.PROCESS:
                dp = _num(d.get("defect_pct"))
                if dp is not None:
                    v = min(max(dp, 0.0), 30.0)
                    same = abs(v - TEMPLATE_DEFECT.get(a.code, -1)) < 1e-6
                    areas.setdefault(a.code, {})["defect_pct"] = None if same else round(v, 2)
            for spec in d.get("equipment") or []:
                if not isinstance(spec, dict) or spec.get("code") not in eq_base:
                    continue
                e = eq_base[spec["code"]]
                if e.area != a.code:
                    continue
                o: dict = {}
                mtbf = _num(spec.get("mtbf_h"))
                if mtbf is not None:
                    v = min(max(mtbf, 5), 5000)
                    o["mtbf_h"] = None if abs(v - e.mtbf_h) < 1e-6 else v
                mttr = _num(spec.get("mttr_min"))
                if mttr is not None:
                    v = min(max(mttr, 2), 480)
                    o["mttr_min"] = None if abs(v - (35 if e.critical else 25)) < 1e-6 else v
                if o:
                    equipment[e.code] = o
        patch: dict = {"areas": areas, "equipment": equipment}
        if supply:
            patch["supply"] = supply
        return patch, notes

    def apply_layout(self, data: dict, current_defects: dict[str, float]) -> tuple[list[dict], list[str]]:
        patch, notes = self.params_patch(data)
        with self._lock:
            self._syncing = True
            try:
                changes = self.params.update(patch, current_defects)
            finally:
                self._syncing = False
        return changes, notes

    def write_back(self, current_defects: dict[str, float]) -> bool:
        if self._syncing:
            return False
        lid = self.active_id()
        if lid is None:
            return False
        view = self.params.view(current_defects)
        ov = self.params.overrides()
        areas = {a["code"]: a for a in view["areas"]}
        eqs = {e["code"]: e for e in view["equipment"]}
        eq_ov = ov.get("equipment", {})
        area_ov = ov.get("areas", {})
        sup = view["supply"]["value"]
        with self.db.session() as s:
            x = s.get(BuilderLayout, lid)
            if x is None:
                return False
            data = _copy(x.data)
            mapping = map_nodes(self.plant, data)
            changed = False
            for n in data.get("nodes") or []:
                m = mapping.get(n.get("id"))
                if not m:
                    continue
                d = n["data"]
                code = m["area"]
                if m["role"] == "buffer":
                    changed |= _put(d, "capacity", areas[code]["value"]["buffer"])
                    continue
                if code == self.plant.areas[0].code:
                    changed |= _put(d, "rate_per_hour", round(sup["size"] * 60 / sup["every_min"], 1))
                    continue
                if code not in areas:
                    continue
                changed |= _put(d, "cycle_s", areas[code]["value"]["cycle_s"])
                if areas[code]["has_defects"]:
                    dp = area_ov.get(code, {}).get("defect_pct", TEMPLATE_DEFECT.get(code))
                    if dp is not None:
                        changed |= _put(d, "defect_pct", dp)
                for spec in d.get("equipment") or []:
                    e = eqs.get(spec.get("code"))
                    if not e or e["area"] != code:
                        continue
                    changed |= _put(spec, "mtbf_h", e["value"]["mtbf_h"])
                    mttr = e["value"]["mttr_min"] if "mttr_factor" in eq_ov.get(e["code"], {}) else None
                    changed |= _put(spec, "mttr_min", mttr if mttr is not None else (35 if e["critical"] else 25))
            if changed:
                x.data = data
                x.updated_at = plant_now(self.tz)
            return changed


def _num(v) -> float | None:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def _put(d: dict, k: str, v) -> bool:
    if d.get(k) == v:
        return False
    d[k] = v
    return True


def _copy(data: dict) -> dict:
    import copy

    return copy.deepcopy(data)
