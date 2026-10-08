from __future__ import annotations

from dataclasses import dataclass, field
from datetime import time
from enum import StrEnum


class AreaKind(StrEnum):
    STORE = "store"
    PROCESS = "process"
    INSPECTION = "inspection"


@dataclass(frozen=True)
class FailureMode:
    reason: str
    weight: float
    mttr_min: float
    planned: bool = False


@dataclass(frozen=True)
class Equipment:
    code: str
    name: str
    kind: str
    area: str
    critical: bool
    mtbf_h: float
    modes: tuple[FailureMode, ...]
    slowdown: float = 0.0


@dataclass(frozen=True)
class Area:
    code: str
    name: str
    kind: AreaKind
    line: str | None
    cycle_s: float
    buffer_after: int
    x: float
    color_role: str = "neutral"


@dataclass(frozen=True)
class CarModel:
    code: str
    name: str
    month_plan: int
    colors: tuple[tuple[str, str, float], ...]


@dataclass(frozen=True)
class Shift:
    number: int
    start: time
    end: time
    hours: float = 8.0


@dataclass(frozen=True)
class Targets:
    oee_pct: float = 85.0
    defect_pct: float = 2.0
    critical_downtime_min_per_day: float = 60.0
    month_output: int = 5500
    shift_plan: int = 120


@dataclass(frozen=True)
class Plant:
    name: str
    areas: tuple[Area, ...]
    equipment: tuple[Equipment, ...]
    models: tuple[CarModel, ...]
    shifts: tuple[Shift, ...]
    targets: Targets = field(default_factory=Targets)
    workdays: frozenset[int] = frozenset({0, 1, 2, 3, 4, 5})

    def area(self, code: str) -> Area:
        return next(a for a in self.areas if a.code == code)

    def equipment_of(self, area: str) -> list[Equipment]:
        return [e for e in self.equipment if e.area == area]

    def eq(self, code: str) -> Equipment:
        return next(e for e in self.equipment if e.code == code)

    @property
    def process_areas(self) -> list[Area]:
        return [a for a in self.areas if a.kind != AreaKind.STORE]

    @property
    def lines(self) -> list[Area]:
        return [a for a in self.areas if a.line]

    @property
    def takt_s(self) -> float:
        return self.shifts[0].hours * 3600 / self.targets.shift_plan

    def area_by_name(self, name: str) -> Area | None:
        key = name.strip().lower()
        for a in self.areas:
            if key in (a.name.lower(), (a.line or "").lower(), a.code.lower()):
                return a
        return None


_ROBOT_MODES = (
    FailureMode("Ошибка датчика", 0.45, 25),
    FailureMode("Сбой позиционирования", 0.25, 35),
    FailureMode("Износ электрода", 0.30, 20),
)
_CONVEYOR_MODES = (
    FailureMode("Обрыв цепи", 0.55, 55),
    FailureMode("Перегрев привода", 0.30, 30),
    FailureMode("Заклинивание тележки", 0.15, 18),
)

ALLUR = Plant(
    name="Аллюр · Костанай",
    areas=(
        Area("WH_IN", "Склад комплектующих", AreaKind.STORE, None, 0, 40, 40),
        Area("WELD", "Сварка", AreaKind.PROCESS, "Сварка-1", 228, 6, 215),
        Area("PAINT", "Окраска", AreaKind.PROCESS, "Окраска-1", 234, 8, 410),
        Area("ASSY", "Сборка", AreaKind.PROCESS, "Сборка-1", 226, 4, 610),
        Area("QC", "Контроль качества", AreaKind.INSPECTION, None, 150, 30, 800),
        Area("WH_OUT", "Склад готовой продукции", AreaKind.STORE, None, 0, 10_000, 955),
    ),
    equipment=(
        Equipment(
            "ABB-01",
            "Робот точечной сварки ABB-01",
            "Робот",
            "WELD",
            True,
            95,
            _ROBOT_MODES,
        ),
        Equipment(
            "ABB-02",
            "Робот точечной сварки ABB-02",
            "Робот",
            "WELD",
            True,
            140,
            _ROBOT_MODES,
        ),
        Equipment(
            "ABB-03",
            "Робот дуговой сварки ABB-03",
            "Робот",
            "WELD",
            True,
            150,
            _ROBOT_MODES,
        ),
        Equipment(
            "ABB-04",
            "Робот-манипулятор ABB-04",
            "Робот",
            "WELD",
            True,
            160,
            (*_ROBOT_MODES, FailureMode("Плановое ТО", 0.0, 30, planned=True)),
        ),
        Equipment(
            "Кондуктор-01",
            "Сварочный кондуктор",
            "Оснастка",
            "WELD",
            True,
            260,
            (FailureMode("Износ фиксаторов", 1, 30),),
        ),
        Equipment(
            "Конвейер-01",
            "Конвейер кузовов в белом",
            "Конвейер",
            "WELD",
            True,
            240,
            _CONVEYOR_MODES,
        ),
        Equipment(
            "Камера-01",
            "Камера подготовки и фосфатирования",
            "Камера",
            "PAINT",
            True,
            200,
            (
                FailureMode("Отклонение химсостава", 0.6, 35),
                FailureMode("Засор форсунок", 0.4, 25),
            ),
        ),
        Equipment(
            "Камера-02",
            "Окрасочная камера",
            "Камера",
            "PAINT",
            True,
            170,
            (
                FailureMode("Замена фильтра", 0.0, 40, planned=True),
                FailureMode("Сбой подачи краски", 0.6, 30),
                FailureMode("Отказ вентиляции", 0.4, 45),
            ),
        ),
        Equipment(
            "Печь-01",
            "Печь сушки ЛКП",
            "Печь",
            "PAINT",
            True,
            300,
            (
                FailureMode("Неравномерный нагрев", 0.7, 40),
                FailureMode("Отказ горелки", 0.3, 60),
            ),
        ),
        Equipment(
            "Конвейер-02",
            "Подвесной конвейер окраски",
            "Конвейер",
            "PAINT",
            True,
            280,
            _CONVEYOR_MODES,
        ),
        Equipment(
            "Конвейер-03",
            "Главный сборочный конвейер",
            "Конвейер",
            "ASSY",
            True,
            150,
            (*_CONVEYOR_MODES, FailureMode("Плановое ТО", 0.0, 30, planned=True)),
        ),
        Equipment(
            "Гайковёрт-01",
            "Многошпиндельный гайковёрт",
            "Инструмент",
            "ASSY",
            False,
            110,
            (
                FailureMode("Ошибка момента затяжки", 0.7, 15),
                FailureMode("Отказ контроллера", 0.3, 25),
            ),
            slowdown=0.35,
        ),
        Equipment(
            "Заливка-01",
            "Станция заправки жидкостей",
            "Станция",
            "ASSY",
            False,
            180,
            (
                FailureMode("Утечка магистрали", 0.5, 30),
                FailureMode("Сбой дозатора", 0.5, 20),
            ),
            slowdown=0.5,
        ),
        Equipment(
            "Стенд-РС",
            "Стенд развал-схождения",
            "Стенд",
            "QC",
            False,
            220,
            (FailureMode("Калибровка", 1, 25),),
            slowdown=0.6,
        ),
        Equipment(
            "Стенд-ТС",
            "Тормозной стенд",
            "Стенд",
            "QC",
            False,
            260,
            (FailureMode("Сбой роликов", 1, 30),),
            slowdown=0.6,
        ),
        Equipment(
            "Дождь-01",
            "Камера дождевания",
            "Камера",
            "QC",
            False,
            400,
            (FailureMode("Засор форсунок", 1, 20),),
            slowdown=0.4,
        ),
    ),
    models=(
        CarModel(
            "ONIX",
            "Chevrolet Onix",
            2500,
            (
                ("Белый", "#F2F3F0", 0.34),
                ("Серебристый", "#B8BDC3", 0.22),
                ("Серый", "#6C727A", 0.16),
                ("Чёрный", "#202327", 0.14),
                ("Красный", "#A9242C", 0.08),
                ("Синий", "#234E86", 0.06),
            ),
        ),
        CarModel(
            "COBALT",
            "Chevrolet Cobalt",
            1800,
            (
                ("Белый", "#F2F3F0", 0.42),
                ("Серебристый", "#B8BDC3", 0.26),
                ("Чёрный", "#202327", 0.18),
                ("Бежевый", "#C9B79A", 0.14),
            ),
        ),
        CarModel(
            "J7",
            "JAC J7",
            500,
            (
                ("Белый", "#F2F3F0", 0.30),
                ("Серый", "#6C727A", 0.30),
                ("Чёрный", "#202327", 0.25),
                ("Синий", "#234E86", 0.15),
            ),
        ),
    ),
    shifts=(
        Shift(1, time(8, 0), time(16, 0)),
        Shift(2, time(16, 0), time(0, 0)),
    ),
)

KIT_STOCK_NORM = 30
