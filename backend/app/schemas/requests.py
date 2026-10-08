from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.security import Role


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LoginIn(Strict):
    pin: str = Field(min_length=1, max_length=64)
    login: str | None = Field(default=None, min_length=1, max_length=40)
    user_id: int | None = Field(default=None, ge=1)


class UserIn(Strict):
    name: str = Field(min_length=2, max_length=80)
    position: str = Field(min_length=2, max_length=80)
    role: Role
    area: str | None = Field(default=None, max_length=16)
    login: str | None = Field(default=None, max_length=40)
    pin: str = Field(min_length=4, max_length=64)


class RegisterIn(Strict):
    name: str = Field(min_length=5, max_length=80)
    position: str = Field(min_length=2, max_length=80)
    role: Role
    area: str | None = Field(default=None, max_length=16)
    login: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=4, max_length=64)
    note: str = Field(default="", max_length=500)


class DecideIn(Strict):
    role: Role | None = None
    position: str | None = Field(default=None, min_length=2, max_length=80)
    area: str | None = Field(default=None, max_length=16)


class UserPatch(Strict):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    position: str | None = Field(default=None, min_length=2, max_length=80)
    role: Role | None = None
    area: str | None = Field(default=None, max_length=16)
    active: bool | None = None
    login: str | None = Field(default=None, max_length=40)
    pin: str | None = Field(default=None, min_length=4, max_length=64)


class SpeedIn(Strict):
    speed: float = Field(ge=0.5, le=300)


class PauseIn(Strict):
    paused: bool


class FailureIn(Strict):
    equipment: str = Field(max_length=40)
    minutes: float = Field(ge=1, le=480)
    reason: str | None = Field(default=None, max_length=80)


class RepairIn(Strict):
    equipment: str = Field(max_length=40)


class SupplyDelayIn(Strict):
    minutes: float = Field(ge=5, le=480)


class StopIn(Strict):
    equipment: str = Field(max_length=40)
    at_min: float = Field(ge=0, le=600)
    minutes: float = Field(ge=1, le=480)
    shift: int = Field(default=1, ge=1, le=2)


class ScenarioIn(Strict):
    stops: list[StopIn] = Field(default_factory=list, max_length=10)
    cycle_factor: dict[str, float] = Field(default_factory=dict)
    buffer_override: dict[str, int] = Field(default_factory=dict)
    defect_pct: dict[str, float] = Field(default_factory=dict)
    supply_delay: tuple[float, float] | None = None
    overtime_min: float = Field(default=0, ge=0, le=240)


class ScenarioRunIn(Strict):
    scenario: ScenarioIn
    runs: int = Field(default=6, ge=2, le=12)


class AskIn(Strict):
    question: str = Field(min_length=2, max_length=500)


class EconomyAssumptionsIn(Strict):
    overhead_kzt_min: float | None = Field(default=None, ge=0, le=1_000_000)
    downtime_line_share: float | None = Field(default=None, ge=0, le=1)


class EconomicsIn(Strict):
    margin_per_car_kzt: int | None = Field(default=None, ge=0, le=50_000_000)
    rework_cost_kzt: int | None = Field(default=None, ge=0, le=10_000_000)
    labor_rate_kzt_h: int | None = Field(default=None, ge=0, le=100_000)
    overtime_rate_kzt_h: int | None = Field(default=None, ge=0, le=200_000)
    line_staff: int | None = Field(default=None, ge=1, le=2000)
    economy: EconomyAssumptionsIn | None = None


class ParamsIn(Strict):
    areas: dict[str, dict[str, float | None]] = Field(default_factory=dict, max_length=20)
    equipment: dict[str, dict[str, float | None]] = Field(default_factory=dict, max_length=100)
    supply: dict[str, float | None] = Field(default_factory=dict, max_length=4)


class ProblemIn(Strict):
    kind: Literal["equipment", "supply", "quality", "safety", "other"]
    area: str | None = Field(default=None, max_length=16)
    equipment: str | None = Field(default=None, max_length=40)
    text: str = Field(default="", max_length=500)
    line_stopped: bool = False
    minutes: float = Field(default=20, ge=1, le=480)
    defect_pct: float | None = Field(default=None, ge=0, le=100)
    urgency: Literal["high", "normal", "low"] | None = None
    reasons: list[str] = Field(default_factory=list, max_length=6)
    photo_id: int | None = Field(default=None, ge=1)


class CommentIn(Strict):
    text: str = Field(min_length=1, max_length=500)


class ShiftReadyIn(Strict):
    status: Literal["ready", "absent"] = "ready"
    note: str = Field(default="", max_length=200)


class ResolveIn(Strict):
    resolution: str | None = Field(default=None, max_length=500)


class ShiftStartIn(Strict):
    staff: int | None = Field(default=None, ge=1, le=2000)
    note: str = Field(default="", max_length=500)
    plan: int | None = Field(default=None, ge=1, le=1000)
    staff_by_area: dict[str, int] | None = None
    checklist: list[str] | None = Field(default=None, max_length=30)


class ShiftPlanIn(Strict):
    plan: int = Field(ge=1, le=1000)
    supervisor: str | None = Field(default=None, max_length=80)
    staff: dict[str, int] = Field(default_factory=dict)


class ShiftSetupIn(Strict):
    shifts: dict[str, ShiftPlanIn]
    checklist: list[str] = Field(default_factory=list, max_length=20)


class ShiftCloseIn(Strict):
    note: str = Field(default="", max_length=1000)


class TextImportIn(Strict):
    text: str = Field(min_length=5, max_length=500_000)
    name: str = Field(default="вставка", max_length=80)


class SimEventIn(Strict):
    kind: Literal["failure", "supply_delay", "defects", "slowdown"]
    at_min: float = Field(default=0, ge=0, le=900)
    minutes: float = Field(default=30, ge=1, le=900)
    equipment: str | None = Field(default=None, max_length=40)
    area: str | None = Field(default=None, max_length=16)
    value: float | None = Field(default=None, ge=0, le=100)
    reason: str | None = Field(default=None, max_length=80)


class SandboxIn(Strict):
    events: list[SimEventIn] = Field(min_length=1, max_length=8)
    horizon: Literal["shift", "day"] = "shift"


class ChatIn(Strict):
    text: str = Field(min_length=1, max_length=1000)
    reply_to: int | None = Field(default=None, ge=1)


class ChatEditIn(Strict):
    text: str = Field(min_length=1, max_length=1000)


class ChatReadIn(Strict):
    last_id: int = Field(ge=0)
