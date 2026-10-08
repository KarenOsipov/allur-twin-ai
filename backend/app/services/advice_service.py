from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timedelta

from app.analytics import impact, prescriptive
from app.domain.plant import Plant
from app.services.analytics_service import AnalyticsService
from app.services.params_service import ParamsService
from app.services.settings_service import SettingsService
from app.sim.engine import EqStatus

log = logging.getLogger(__name__)


class AdviceService:
    def __init__(
        self,
        plant: Plant,
        analytics: AnalyticsService,
        params: ParamsService,
        economics: SettingsService,
        live,
    ) -> None:
        self.plant = plant
        self.analytics = analytics
        self.params = params
        self.economics = economics
        self.live = live
        self._lock = threading.Lock()
        self._key: str | None = None
        self._items: list[dict] = []
        self._computed_at: datetime | None = None
        self._computing_key: str | None = None
        self._thread: threading.Thread | None = None
        self._error: str | None = None

    def _current_key(self) -> str:
        ds = self.analytics.data.dataset()
        return json.dumps(
            [ds.version, str(self.analytics.today()), self.params.overrides(), self.economics.economics()],
            sort_keys=True,
            default=str,
        )

    def get(self, *, wait: bool = False, timeout: float = 60) -> dict:
        key = self._current_key()
        with self._lock:
            ready = self._key == key
            if not ready and self._computing_key != key:
                self._computing_key = key
                self._thread = threading.Thread(target=self._compute, args=(key,), name="advice", daemon=True)
                self._thread.start()
            t = None if ready else self._thread
        if wait and t is not None:
            t.join(timeout=timeout)
        with self._lock:
            return {
                "status": "ready" if self._key == key else "computing",
                "items": list(self._items),
                "computed_at": self._computed_at,
                "stale": self._key is not None and self._key != key,
                "error": self._error,
            }

    def _compute(self, key: str) -> None:
        try:
            ins = self.analytics.insights()
            econ = self.economics.economics()
            buffers = dict(self.live.sim.buffer_cap) if self.live.sim else {}
            cands = prescriptive.candidates(self.plant, ins, econ, buffers)
            day = self.analytics.today() + timedelta(days=1)
            while day.weekday() not in self.plant.workdays:
                day += timedelta(days=1)
            f = ins.get("forecast") or {}
            shortfall = max(0.0, f["target"] - f["p10"]) if f.get("available") else 0.0
            items = prescriptive.evaluate(
                self.plant,
                cands,
                self.analytics.current_defect_levels(),
                econ,
                day,
                self.params.sim_overrides(),
                shortfall_month=shortfall,
            )
            with self._lock:
                if self._computing_key == key:
                    self._key, self._items, self._computed_at, self._error = key, items, datetime.now(), None
                    self._computing_key = None
        except Exception:
            log.exception("Не удалось рассчитать рекомендации")
            with self._lock:
                self._error = "Не удалось рассчитать рекомендации"
                self._computing_key = None

    def problem_from(self, inc: dict, minutes: float | None) -> impact.Problem:
        sim = self.live.sim
        kind = inc["kind"] if inc["kind"] in ("equipment", "supply", "quality") else "other"
        code = inc.get("equipment")
        est = minutes
        if est is None and sim is not None and code in (sim.equipment if sim else {}):
            eq = sim.equipment[code]
            if eq.status in (EqStatus.DOWN, EqStatus.MAINT) and eq.until:
                est = max((eq.until - sim.clock).total_seconds() / 60, 1)
        if est is None and kind == "supply" and sim is not None and sim.kits_delayed_until:
            est = max((sim.kits_delayed_until - sim.clock).total_seconds() / 60, 1)
        defect = None
        if kind == "quality" and sim is not None and inc.get("area") in sim.areas:
            a = sim.areas[inc["area"]]
            now = a.defects / a.output * 100 if a.output >= 10 else 0
            defect = max(now, sim.cfg.defect_rate.get(inc["area"], 0.03) * 100 * 2.5, 6.0)
        line_stopped = bool(inc.get("line_stopped")) or (
            kind == "equipment"
            and sim is not None
            and code in sim.equipment
            and sim.equipment[code].status in (EqStatus.DOWN, EqStatus.MAINT)
        )
        return impact.Problem(
            kind=kind,
            area=inc.get("area"),
            equipment=code,
            minutes=est or 30.0,
            line_stopped=line_stopped,
            defect_pct=defect,
        )

    def impact(self, inc: dict, p: impact.Problem, twin) -> dict:
        econ = self.economics.economics()
        out = impact.analyze(
            twin,
            self.plant,
            p,
            impact.Economics(
                margin=econ["margin_per_car_kzt"],
                rework=econ["rework_cost_kzt"],
                overtime_rate=econ["overtime_rate_kzt_h"],
                line_staff=econ["line_staff"],
            ),
        )
        out["incident"] = inc
        out["problem"] = {"kind": p.kind, "minutes": round(p.minutes), "line_stopped": p.line_stopped}
        return out
