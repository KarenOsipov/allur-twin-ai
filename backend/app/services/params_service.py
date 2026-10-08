from __future__ import annotations

import copy
import threading
from dataclasses import dataclass, field

from app.core.errors import ValidationFailed
from app.db.base import Database
from app.db.models import SettingValue
from app.domain.plant import AreaKind, Plant

KEY = "line_params"
SUPPLY_DEFAULT = {"every_min": 60.0, "size": 34}


@dataclass
class SimOverrides:
    cycle_factor: dict[str, float] = field(default_factory=dict)
    buffer_override: dict[str, int] = field(default_factory=dict)
    defect_pct: dict[str, float] = field(default_factory=dict)
    mtbf_h: dict[str, float] = field(default_factory=dict)
    mttr_factor: dict[str, float] = field(default_factory=dict)
    kit_every_min: float = SUPPLY_DEFAULT["every_min"]
    kit_size: int = SUPPLY_DEFAULT["size"]


class ParamsService:
    def __init__(self, db: Database, plant: Plant) -> None:
        self.db = db
        self.plant = plant
        self._cache: dict | None = None
        self._lock = threading.Lock()
        self.listeners: list = []

    def overrides(self) -> dict:
        with self._lock:
            if self._cache is None:
                with self.db.session() as s:
                    row = s.get(SettingValue, KEY)
                    self._cache = copy.deepcopy(row.value) if row else {}
            return copy.deepcopy(self._cache)

    def _save(self, ov: dict) -> None:
        with self.db.session() as s:
            row = s.get(SettingValue, KEY)
            if row is None:
                s.add(SettingValue(key=KEY, value=ov))
            else:
                row.value = ov
        with self._lock:
            self._cache = copy.deepcopy(ov)

    def view(self, current_defects: dict[str, float]) -> dict:
        ov = self.overrides()
        a_ov = ov.get("areas", {})
        e_ov = ov.get("equipment", {})
        areas = []
        for a in self.plant.areas:
            if a.kind == AreaKind.STORE:
                continue
            o = a_ov.get(a.code, {})
            areas.append(
                {
                    "code": a.code,
                    "name": a.name,
                    "kind": a.kind.value,
                    "base": {
                        "cycle_s": a.cycle_s,
                        "buffer": a.buffer_after,
                        "defect_pct": round(current_defects.get(a.code, 0.0), 2),
                    },
                    "value": {
                        "cycle_s": o.get("cycle_s", a.cycle_s),
                        "buffer": o.get("buffer", a.buffer_after),
                        "defect_pct": o.get("defect_pct", round(current_defects.get(a.code, 0.0), 2)),
                    },
                    "changed": sorted(o),
                    "has_buffer": a.kind == AreaKind.PROCESS,
                    "has_defects": a.kind == AreaKind.PROCESS,
                }
            )
        equipment = []
        for e in self.plant.equipment:
            o = e_ov.get(e.code, {})
            mttr = round(
                sum(m.mttr_min * m.weight for m in e.modes if not m.planned)
                / max(sum(m.weight for m in e.modes if not m.planned), 1e-9)
            )
            equipment.append(
                {
                    "code": e.code,
                    "name": e.name,
                    "kind": e.kind,
                    "area": e.area,
                    "critical": e.critical,
                    "base": {"mtbf_h": e.mtbf_h, "mttr_min": mttr},
                    "value": {"mtbf_h": o.get("mtbf_h", e.mtbf_h), "mttr_min": round(mttr * o.get("mttr_factor", 1.0))},
                    "changed": sorted(o),
                }
            )
        supply = {**SUPPLY_DEFAULT, **ov.get("supply", {})}
        return {
            "areas": areas,
            "equipment": equipment,
            "supply": {"base": SUPPLY_DEFAULT, "value": supply},
            "changed": bool(ov),
        }

    def sim_overrides(self) -> SimOverrides:
        ov = self.overrides()
        out = SimOverrides()
        for code, o in ov.get("areas", {}).items():
            a = self.plant.area(code)
            if "cycle_s" in o:
                out.cycle_factor[code] = o["cycle_s"] / a.cycle_s
            if "buffer" in o:
                out.buffer_override[code] = int(o["buffer"])
            if "defect_pct" in o:
                out.defect_pct[code] = float(o["defect_pct"])
        for code, o in ov.get("equipment", {}).items():
            if "mtbf_h" in o:
                out.mtbf_h[code] = float(o["mtbf_h"])
            if "mttr_factor" in o:
                out.mttr_factor[code] = float(o["mttr_factor"])
        sup = ov.get("supply", {})
        out.kit_every_min = float(sup.get("every_min", SUPPLY_DEFAULT["every_min"]))
        out.kit_size = int(sup.get("size", SUPPLY_DEFAULT["size"]))
        return out

    def update(self, patch: dict, current_defects: dict[str, float]) -> list[dict]:
        before = self.view(current_defects)
        ov = self.overrides()
        changes: list[dict] = []
        areas = {a["code"]: a for a in before["areas"]}
        for code, values in (patch.get("areas") or {}).items():
            if code not in areas:
                raise ValidationFailed(f"Неизвестный участок: {code}")
            a = areas[code]
            o = ov.setdefault("areas", {}).setdefault(code, {})
            for k, v in values.items():
                if k not in ("cycle_s", "buffer", "defect_pct"):
                    raise ValidationFailed(f"Неизвестный параметр участка: {k}")
                if k == "buffer" and not a["has_buffer"] or k == "defect_pct" and not a["has_defects"]:
                    raise ValidationFailed(f"У участка «{a['name']}» нет параметра «{LABELS[k]}»")
                old = a["value"][k]
                if v is None:
                    o.pop(k, None)
                    new = a["base"][k]
                else:
                    new = _check(k, v, a["base"]["cycle_s"])
                    o[k] = new
                if new != old:
                    changes.append({"what": f"{a['name']}: {LABELS[k]}", "before": old, "after": new})
            if not o:
                ov["areas"].pop(code)
        eqs = {e["code"]: e for e in before["equipment"]}
        for code, values in (patch.get("equipment") or {}).items():
            if code not in eqs:
                raise ValidationFailed(f"Неизвестное оборудование: {code}")
            e = eqs[code]
            o = ov.setdefault("equipment", {}).setdefault(code, {})
            for k, v in values.items():
                if k not in ("mtbf_h", "mttr_min"):
                    raise ValidationFailed(f"Неизвестный параметр оборудования: {k}")
                old = e["value"][k]
                if v is None:
                    o.pop("mttr_factor" if k == "mttr_min" else k, None)
                    new = e["base"][k]
                elif k == "mtbf_h":
                    new = _check(k, v)
                    o["mtbf_h"] = new
                else:
                    new = _check(k, v)
                    o["mttr_factor"] = round(new / max(e["base"]["mttr_min"], 1), 4)
                if new != old:
                    changes.append({"what": f"{code}: {LABELS[k]}", "before": old, "after": new})
            if not o:
                ov["equipment"].pop(code)
        sup = patch.get("supply") or {}
        if sup:
            o = ov.setdefault("supply", {})
            for k, v in sup.items():
                if k not in ("every_min", "size"):
                    raise ValidationFailed(f"Неизвестный параметр поставки: {k}")
                old = before["supply"]["value"][k]
                if v is None:
                    o.pop(k, None)
                    new = SUPPLY_DEFAULT[k]
                else:
                    new = _check("supply_" + k, v)
                    o[k] = new
                if new != old:
                    changes.append(
                        {"what": f"Поставка комплектов: {LABELS['supply_' + k]}", "before": old, "after": new}
                    )
            if not o:
                ov.pop("supply")
        for k in ("areas", "equipment"):
            if k in ov and not ov[k]:
                ov.pop(k)
        self._save(ov)
        for fn in self.listeners:
            fn()
        return changes

    def reset(self) -> None:
        self._save({})
        for fn in self.listeners:
            fn()


LABELS = {
    "cycle_s": "время цикла, с",
    "buffer": "буфер после участка, кузовов",
    "defect_pct": "брак, %",
    "mtbf_h": "наработка на отказ, ч",
    "mttr_min": "время ремонта, мин",
    "supply_every_min": "интервал поставок, мин",
    "supply_size": "комплектов в поставке",
}
RANGES = {
    "buffer": (1, 60),
    "defect_pct": (0, 30),
    "mtbf_h": (5, 5000),
    "mttr_min": (2, 480),
    "supply_every_min": (10, 480),
    "supply_size": (1, 200),
}


def _check(k: str, v, base_cycle: float | None = None):
    try:
        x = float(v)
    except (TypeError, ValueError) as e:
        raise ValidationFailed(f"«{LABELS[k]}»: нужно число") from e
    if k == "cycle_s":
        lo, hi = round(base_cycle * 0.5), round(base_cycle * 2)
    else:
        lo, hi = RANGES[k]
    if not lo <= x <= hi:
        raise ValidationFailed(f"«{LABELS[k]}»: допустимо от {lo:g} до {hi:g}")
    if k in ("buffer", "supply_size"):
        return int(round(x))
    return round(x, 2)
