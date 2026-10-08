from __future__ import annotations

import logging
import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np

from app.domain.plant import Plant
from app.services.data_service import Dataset

log = logging.getLogger(__name__)

HORIZON = 7
FEATURES = (
    "days_since_last",
    "fails_30",
    "fails_90",
    "last_interval",
    "mean_interval",
    "trend",
    "shift2_share",
    "critical",
)


@dataclass
class EquipmentRisk:
    code: str
    name: str
    area: str
    critical: bool
    probability: float
    level: str
    failures_90: int
    last_failure: date | None
    days_since_last: int | None
    next_failure: date | None
    intervals: list[int]
    main_reason: str | None
    mttr_min: float | None
    factors: list[str]
    expected_loss_kzt: int
    overdue: bool = False


def _failures(ds: Dataset) -> dict[str, list[tuple[date, int, str, float]]]:
    out: dict[str, list] = defaultdict(list)
    for r in ds.downtime:
        if not r.planned and r.equipment != "Поставка":
            out[r.equipment].append((r.day, r.shift, r.reason, r.minutes))
    for v in out.values():
        v.sort()
    return out


def _features(events: list[tuple[date, int, str, float]], on: date, critical: bool) -> list[float]:
    past = [e for e in events if e[0] < on]
    days = [e[0] for e in past]
    since = (on - days[-1]).days if days else 120
    f30 = sum(1 for d in days if (on - d).days <= 30)
    f90 = sum(1 for d in days if (on - d).days <= 90)
    intervals = [(b - a).days for a, b in zip(days, days[1:], strict=False) if (b - a).days > 0]
    last_i = intervals[-1] if intervals else 90
    mean_i = sum(intervals) / len(intervals) if intervals else 90
    trend = last_i / mean_i if mean_i else 1.0
    shift2 = sum(1 for e in past if e[1] == 2) / len(past) if past else 0.0
    return [
        min(since, 120),
        f30,
        f90,
        min(last_i, 90),
        min(mean_i, 90),
        trend,
        shift2,
        float(critical),
    ]


class RiskModel:
    def __init__(self, plant: Plant) -> None:
        self.plant = plant
        self._model = None
        self._version = -1
        self.trained_on = 0
        self.positives = 0
        self.auc: float | None = None

    def fit(self, ds: Dataset) -> None:
        if self._version == ds.version and self._model is not None:
            return
        from sklearn.ensemble import GradientBoostingClassifier
        from sklearn.metrics import roc_auc_score

        failures = _failures(ds)
        days = ds.days
        if len(days) < 30:
            self._model = None
            return
        X, y, when = [], [], []
        for eq in self.plant.equipment:
            events = failures.get(eq.code, [])
            for d in days[20:-HORIZON]:
                X.append(_features(events, d, eq.critical))
                y.append(int(any(d <= e[0] < d + timedelta(days=HORIZON) for e in events)))
                when.append(d)
        X_arr, y_arr = np.array(X), np.array(y)
        self.trained_on, self.positives = len(y_arr), int(y_arr.sum())
        if self.positives < 5:
            self._model = None
            return
        cut = sorted(set(when))[int(len(set(when)) * 0.75)]
        train = np.array([w < cut for w in when])
        model = GradientBoostingClassifier(
            n_estimators=120,
            max_depth=2,
            learning_rate=0.08,
            subsample=0.9,
            random_state=0,
        )
        model.fit(X_arr[train], y_arr[train])
        test_y = y_arr[~train]
        if 0 < test_y.sum() < len(test_y):
            self.auc = round(
                float(roc_auc_score(test_y, model.predict_proba(X_arr[~train])[:, 1])),
                3,
            )
        model.fit(X_arr, y_arr)
        self._model = model
        self._version = ds.version
        log.info(
            "Модель риска отказов обучена: %d примеров, %d отказов, AUC=%s",
            len(y_arr),
            self.positives,
            self.auc,
        )

    def predict(self, ds: Dataset, today: date, margin_per_car: int) -> list[EquipmentRisk]:
        self.fit(ds)
        failures = _failures(ds)
        cars_per_min = 60 / self.plant.takt_s
        out: list[EquipmentRisk] = []
        for eq in self.plant.equipment:
            events = failures.get(eq.code, [])
            feats = _features(events, today, eq.critical)
            if self._model is not None:
                prob = float(self._model.predict_proba(np.array([feats]))[0, 1])
            else:
                prob = 1 - math.exp(-HORIZON * 16 / eq.mtbf_h)
            days = [e[0] for e in events]
            intervals, trend_days = _intervals(events)
            next_failure = _next_failure(trend_days, intervals)
            overdue = bool(next_failure and next_failure < today)
            if overdue and not _shrinking(intervals):
                next_failure = None
            if next_failure and _shrinking(intervals) and (next_failure - today).days <= HORIZON:
                prob = max(prob, 0.62 if (next_failure - today).days > 2 else 0.78)
            reasons = defaultdict(int)
            mttr = []
            for e in events:
                reasons[e[2]] += 1
                mttr.append(e[3])
            mean_mttr = sum(mttr) / len(mttr) if mttr else None
            loss = 0
            if mean_mttr:
                lost_cars = mean_mttr * cars_per_min * (1.0 if eq.critical else eq.slowdown / (1 + eq.slowdown))
                loss = int(prob * lost_cars * margin_per_car)
            out.append(
                EquipmentRisk(
                    code=eq.code,
                    name=eq.name,
                    area=eq.area,
                    critical=eq.critical,
                    probability=round(prob, 3),
                    level="high" if prob >= 0.55 else "medium" if prob >= 0.3 else "low",
                    failures_90=int(feats[2]),
                    last_failure=days[-1] if days else None,
                    days_since_last=(today - days[-1]).days if days else None,
                    next_failure=next_failure,
                    intervals=intervals[-8:],
                    main_reason=max(reasons, key=lambda k: reasons[k]) if reasons else None,
                    mttr_min=round(mean_mttr, 1) if mean_mttr else None,
                    factors=_explain(feats, intervals, events, next_failure, today),
                    expected_loss_kzt=loss,
                    overdue=overdue,
                )
            )
        out.sort(key=lambda r: (-r.probability, -r.expected_loss_kzt))
        return out

    @property
    def info(self) -> dict:
        return {
            "model": "Градиентный бустинг (scikit-learn)" if self._model is not None else "Наработка на отказ",
            "horizon_days": HORIZON,
            "trained_on": self.trained_on,
            "positives": self.positives,
            "auc": self.auc,
            "features": list(FEATURES),
        }


def _intervals(events) -> tuple[list[int], list[date]]:
    by_reason: dict[str, list[date]] = defaultdict(list)
    for e in events:
        by_reason[e[2]].append(e[0])
    main = max(by_reason.values(), key=len) if by_reason else []
    days = sorted(set(main)) if len(main) >= 4 else sorted({e[0] for e in events})
    return [(b - a).days for a, b in zip(days, days[1:], strict=False) if (b - a).days > 0], days


def _shrinking(intervals: list[int]) -> bool:
    if len(intervals) < 5:
        return False
    tail = intervals[-5:]
    rises = sum(1 for a, b in zip(tail, tail[1:], strict=False) if b > a * 1.1)
    return rises <= 1 and intervals[-1] <= intervals[0] / 2


def _next_failure(days: list[date], intervals: list[int]) -> date | None:
    if len(intervals) < 3:
        return None
    if _shrinking(intervals):
        tail = intervals[-4:]
        ratios = [b / a for a, b in zip(tail, tail[1:], strict=False) if a > 0]
        ratio = min(max(sum(ratios) / len(ratios), 0.6), 1.0)
        return days[-1] + timedelta(days=max(2, round(tail[-1] * ratio)))
    mean = sum(intervals) / len(intervals)
    return days[-1] + timedelta(days=max(1, round(mean)))


def _explain(
    feats: list[float],
    intervals: list[int],
    events,
    next_failure: date | None,
    today: date,
) -> list[str]:
    since, f30, f90, _, mean_i, _trend, shift2, _ = feats
    out = []
    shrinking = _shrinking(intervals)
    if shrinking:
        chain = " → ".join(str(i) for i in intervals[-7:])
        out.append(f"Интервалы между отказами сокращаются: {chain} дн.")
    if next_failure and shrinking:
        delta = (next_failure - today).days
        if delta <= 0:
            out.append("По тренду отказ уже должен был произойти — оборудование работает «в долг»")
        elif delta <= 10:
            out.append(f"По тренду следующий отказ — около {next_failure:%d.%m} (через {delta} дн.)")
    if f30 >= 3:
        out.append(f"{int(f30)} отказов за последние 30 дней")
    if len(events) >= 4 and shift2 >= 0.65:
        out.append(f"{round(shift2 * 100)}% отказов — во 2-й смене")
    if since <= 3:
        out.append(f"Последний отказ {int(since)} дн. назад")
    if not out and f90 == 0:
        out.append("За 90 дней отказов не было")
    elif not out:
        out.append(f"{int(f90)} отказов за 90 дней, средний интервал {round(mean_i)} дн.")
    return out
