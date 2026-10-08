from __future__ import annotations

from app.core.config import Settings
from app.db.base import Database
from app.db.models import SettingValue

KEY = "economics"


class SettingsService:
    def __init__(self, db: Database, settings: Settings) -> None:
        self.db = db
        self.defaults = {
            "margin_per_car_kzt": settings.margin_per_car_kzt,
            "rework_cost_kzt": settings.rework_cost_kzt,
            "labor_rate_kzt_h": settings.labor_rate_kzt_h,
            "overtime_rate_kzt_h": settings.overtime_rate_kzt_h,
            "line_staff": 60,
            "economy": {},
        }
        self._cache: dict | None = None

    def economics(self) -> dict:
        if self._cache is None:
            with self.db.session() as s:
                row = s.get(SettingValue, KEY)
                v = dict(row.value) if row else {}
                old = v.pop("roi", None)
                if isinstance(old, dict) and not v.get("economy"):
                    v["economy"] = {k: x for k, x in old.items() if k in ("overhead_kzt_min", "downtime_line_share")}
                self._cache = {**self.defaults, **v}
        return dict(self._cache)

    def update(self, values: dict) -> dict:
        current = self.economics()
        if "economy" in values:
            values = {**values, "economy": {**current.get("economy", {}), **values["economy"]}}
        merged = {**current, **values}
        with self.db.session() as s:
            row = s.get(SettingValue, KEY)
            if row is None:
                s.add(SettingValue(key=KEY, value=merged))
            else:
                row.value = merged
        self._cache = merged
        return merged

    def margin(self) -> int:
        return int(self.economics()["margin_per_car_kzt"])

    def rework(self) -> int:
        return int(self.economics()["rework_cost_kzt"])
