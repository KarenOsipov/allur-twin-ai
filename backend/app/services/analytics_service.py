from __future__ import annotations

import copy
import threading
from dataclasses import asdict
from datetime import date, timedelta

from app.analytics import (
    advisor,
    anomalies,
    bottleneck,
    checks,
    forecast,
    kpi,
    quality,
    risk,
    whatif,
)
from app.domain.plant import Plant
from app.services.data_service import DataService
from app.services.settings_service import SettingsService


class AnalyticsService:
    def __init__(
        self,
        plant: Plant,
        data: DataService,
        settings: SettingsService,
        today_fn,
        live_output_fn,
    ) -> None:
        self.plant = plant
        self.data = data
        self.settings = settings
        self.today = today_fn
        self.live_output = live_output_fn
        self.risk_model = risk.RiskModel(plant)
        self.params_fn = lambda: None
        self._cache: dict[tuple, object] = {}
        self._lock = threading.Lock()

    def scoped(self, data_source, live_output_fn) -> AnalyticsService:
        clone = copy.copy(self)
        clone.data = data_source
        clone.live_output = live_output_fn
        clone.risk_model = risk.RiskModel(self.plant)
        return clone

    def _cached(self, name: str, fn, *extra):
        ds = self.data.dataset()
        key = (name, ds.version, self.today(), *extra)
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        value = fn(ds)
        with self._lock:
            if len(self._cache) > 64:
                self._cache.clear()
            self._cache[key] = value
        return value

    def overview(self, days: int) -> dict:
        ds = self.data.dataset()
        today = self.today()
        last = ds.last_day or today
        end = min(last, today)
        start = end - timedelta(days=days - 1)
        prev_end = start - timedelta(days=1)
        prev_start = prev_end - timedelta(days=days - 1)
        first = min((r.day for r in ds.production), default=start)
        clipped = start < first
        start = max(start, first)
        current = kpi.period_kpis(ds, self.plant, start, end)
        previous = kpi.period_kpis(ds, self.plant, prev_start, prev_end)
        cur_days = len({r.day for r in ds.production if start <= r.day <= end})
        prev_days = len({r.day for r in ds.production if prev_start <= r.day <= prev_end})
        return {
            "period": {**current, "requested_days": days, "clipped": clipped, "work_days": cur_days},
            "previous": {
                "available": cur_days > 0 and prev_days >= 0.6 * cur_days,
                "work_days": prev_days,
                **{
                    k: previous[k]
                    for k in ("output", "plan", "plan_pct", "oee", "defect_pct", "downtime_unplanned_min")
                },
            },
            "daily": kpi.daily_series(ds, self.plant, start, end),
            "pareto_reason": kpi.downtime_pareto(ds, self.plant, start, end, "reason"),
            "pareto_equipment": kpi.downtime_pareto(ds, self.plant, start, end, "equipment"),
            "month": kpi.month_progress(ds, self.plant, today.strftime("%Y-%m")),
            "targets": asdict(self.plant.targets),
        }

    def month_forecast(self) -> dict:
        ds = self.data.dataset()
        return forecast.month_forecast(ds, self.plant, self.today(), self.live_output())

    def risks(self) -> list[risk.EquipmentRisk]:
        margin = self.settings.margin()
        return self._cached(
            "risks",
            lambda ds: self.risk_model.predict(ds, self.today(), margin),
            margin,
        )

    def quality(self) -> list[dict]:
        return self._cached("quality", lambda ds: quality.quality_analysis(ds, self.plant, self.today()))

    def anomalies(self) -> list[dict]:
        return self._cached("anomalies", lambda ds: anomalies.shift_anomalies(ds, self.plant))

    def bottleneck(self) -> dict:
        return self._cached("bottleneck", lambda ds: bottleneck.bottleneck_history(ds, self.plant))

    def checks(self) -> list[dict]:
        return self._cached("checks", lambda ds: checks.data_checks(ds, self.plant, self.today()))

    def recommendations(self) -> list[dict]:
        econ = self.settings.economics()
        recs = advisor.recommendations(
            self.plant,
            self.today(),
            self.risks(),
            self.quality(),
            self.bottleneck(),
            self.month_forecast(),
            self.checks(),
            econ["margin_per_car_kzt"],
            econ["rework_cost_kzt"],
        )
        return [r.as_dict() for r in recs]

    def current_defect_levels(self) -> dict[str, float]:
        return {q["area"]: max(q["level"], 0.3) for q in self.quality()}

    def insights(self) -> dict:
        return {
            "forecast": self.month_forecast(),
            "risks": [asdict(r) for r in self.risks()],
            "risk_model": self.risk_model.info,
            "quality": self.quality(),
            "bottleneck": self.bottleneck(),
            "anomalies": self.anomalies(),
            "recommendations": self.recommendations(),
        }

    def whatif(self, scenario: whatif.Scenario, runs: int) -> dict:
        econ = self.settings.economics()
        day = self.today() + timedelta(days=1)
        return whatif.run_whatif(
            self.plant,
            scenario,
            self.current_defect_levels(),
            econ["margin_per_car_kzt"],
            econ["rework_cost_kzt"],
            runs=runs,
            day=day,
            base=self.params_fn(),
        )

    def today_date(self) -> date:
        return self.today()
