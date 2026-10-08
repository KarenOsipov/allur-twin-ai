from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from app.assistant.engine import Assistant
from app.core.clock import plant_now
from app.core.config import Settings
from app.core.events import EventBus
from app.core.ratelimit import RateLimiter
from app.db.base import Database
from app.db.failover import FailoverDatabase
from app.db.schema import prepare_database
from app.domain.plant import ALLUR, Plant
from app.services import dataset_service
from app.services.advice_service import AdviceService
from app.services.analytics_service import AnalyticsService
from app.services.audit_service import AuditService
from app.services.chat_service import ChatService
from app.services.data_service import DataService
from app.services.demo_seed import seed_demo
from app.services.floor_layout_service import FloorLayoutService
from app.services.incident_service import IncidentService
from app.services.params_service import ParamsService
from app.services.sandbox_service import SandboxService
from app.services.settings_service import SettingsService
from app.services.shift_service import ShiftService
from app.services.user_service import UserService
from app.sim.live import LiveFloor

log = logging.getLogger(__name__)


@dataclass
class Container:
    settings: Settings
    plant: Plant
    db: FailoverDatabase
    events: EventBus
    data: DataService
    economics: SettingsService
    incidents: IncidentService
    live: LiveFloor
    analytics: AnalyticsService
    assistant: Assistant
    sandboxes: SandboxService
    audit: AuditService
    users: UserService
    shifts: ShiftService
    params: ParamsService
    advice: AdviceService
    floor_layout: FloorLayoutService
    chat: ChatService
    chat_limiter: RateLimiter
    register_limiter: RateLimiter
    login_limiter: RateLimiter
    assistant_limiter: RateLimiter
    heavy_limiter: RateLimiter

    @classmethod
    def build(cls, settings: Settings) -> Container:
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        plant = ALLUR
        primary = Database(settings.primary_db_url, remote=True) if settings.primary_db_url else None
        db = FailoverDatabase(
            Database(settings.db_url),
            primary,
            check_s=settings.db_check_s,
            mirror_min=settings.db_mirror_min,
        )
        events = EventBus()
        data = DataService(db, plant, settings.tz_offset_min)
        economics = SettingsService(db, settings)
        incidents = IncidentService(db, events, economics.margin)
        shifts = ShiftService(db, plant)
        holder: dict = {}

        def shift_end(d: dict) -> None:
            data.record_shift(d)
            shifts.on_shift_end(d, holder["live"].clock)

        live = LiveFloor(
            plant,
            events,
            incidents,
            on_shift_end=shift_end,
            on_downtime=data.record_downtime,
            tz_offset_min=settings.tz_offset_min,
            speed=settings.sim_speed,
            seed=settings.sim_seed,
        )
        analytics = AnalyticsService(
            plant,
            data,
            economics,
            today_fn=lambda: live.clock.date(),
            live_output_fn=live.today_output,
        )
        holder["live"] = live
        params = ParamsService(db, plant)
        analytics.params_fn = params.sim_overrides
        params.listeners.append(lambda: live.apply_params(params.sim_overrides()))
        advice = AdviceService(plant, analytics, params, economics, live)
        assistant = Assistant(plant, analytics, live, settings)
        sandboxes = SandboxService(plant, live, data, analytics, assistant, economics)
        audit = AuditService(db, settings.tz_offset_min, events)
        audit.plant_clock = lambda: live.clock
        chat = ChatService(db, plant, events, lambda: live.clock)
        names = {a.code: a.name for a in plant.areas}

        def problem_to_chat(d: dict) -> None:
            text = f"{d.get('reported_by') or 'Рабочий'} сообщил: {d['title']}. {d.get('details') or ''}".strip()
            by = d.get("reporter_id")
            chat.system(d.get("area") or "all", text, kind="alert", ref={"incident": d["id"]}, actor_id=by)
            chat.system(
                "staff",
                f"{names.get(d.get('area') or '', 'Цех')}: {text}",
                kind="alert",
                ref={"incident": d["id"]},
                actor_id=by,
            )

        events.on("problem.reported", problem_to_chat)
        return cls(
            settings=settings,
            plant=plant,
            db=db,
            events=events,
            data=data,
            economics=economics,
            incidents=incidents,
            live=live,
            analytics=analytics,
            assistant=assistant,
            sandboxes=sandboxes,
            audit=audit,
            users=UserService(db, settings),
            shifts=shifts,
            params=params,
            advice=advice,
            floor_layout=FloorLayoutService(db, plant, params, settings.tz_offset_min),
            chat=chat,
            chat_limiter=RateLimiter(20, 30),
            register_limiter=RateLimiter(5, 3600),
            login_limiter=RateLimiter(settings.login_attempts, settings.login_window_s),
            assistant_limiter=RateLimiter(20, 60),
            heavy_limiter=RateLimiter(30, 60),
        )

    def _first_mirror(self) -> None:
        try:
            counts = self.db.mirror_now()
            log.info("Локальное зеркало базы обновлено: %s строк", sum(counts.values()))
        except Exception as e:
            log.warning("Первое зеркало базы не сделано: %s", e)

    def _db_switched(self, status: dict) -> None:
        self.data.touch()
        self.users._active.clear()
        if status["mode"] == "local" and status.get("needs_decision"):
            title = (
                f"{status['label']} снова доступен — администратор может вернуться на него"
                if status.get("primary_ok")
                else f"{status['label']} недоступен — работаем на локальной базе"
            )
        else:
            title = f"База данных: {status['active']}" + (
                f" ({status['last_error']})" if status.get("last_error") and status["mode"] == "local" else ""
            )
        self.audit.log("system", "database", title, severity="warning" if status["mode"] == "local" else "info")
        self.events.publish("db.status", status)

    def _seed_chat(self) -> None:
        path = Path(__file__).parent / "seed" / "chat.json"
        if not path.exists():
            return
        now = plant_now(self.settings.tz_offset_min)
        rows = json.loads(path.read_text(encoding="utf-8"))
        self.chat.seed_demo(
            [(r["channel"], now - timedelta(minutes=r["minutes_ago"]), r["author"], r["text"]) for r in rows]
        )

    def _wait_local_db(self, timeout_s: float = 90) -> None:
        import time

        from app.db.failover import ping

        deadline = time.monotonic() + timeout_s
        while not ping(self.db.local):
            if time.monotonic() > deadline:
                raise RuntimeError("Локальная база данных не отвечает — проверьте сервис db: docker compose logs db")
            log.warning("Жду локальную базу данных…")
            time.sleep(2)

    def start(self) -> None:
        self.db.prepare = lambda d: prepare_database(d, self.plant)
        self._wait_local_db()
        self.db.connect()
        if self.db.primary is not None:
            prepare_database(self.db.local, self.plant)
        prepare_database(self.db, self.plant)
        first_start = self.data.is_empty()
        self.data.seed_if_empty(self.settings.history_days)
        self.users.seed()
        if first_start:
            loaded = dataset_service.load_seed_file(self.db)
            if loaded:
                self.data.touch()
            elif self.settings.demo_mode:
                today = plant_now(self.settings.tz_offset_min).date()
                seed_demo(self.db, self.plant, today, self.economics.margin())
        if self.settings.demo_mode:
            self._seed_chat()
        self.floor_layout.ensure_default()
        self.db.on_switch.append(self._db_switched)
        if self.db.is_primary:
            threading.Thread(target=self._first_mirror, name="db-mirror", daemon=True).start()
        self.db.start()
        now = plant_now(self.settings.tz_offset_min)
        self.data.purge_live_day(now.date())
        self.incidents.purge_auto_since(datetime.combine(now.date(), self.plant.shifts[0].start))
        self.live.calibrate(self.analytics.current_defect_levels())
        self.live.apply_params(self.params.sim_overrides())
        self.live.start()
        self.audit.attach(self.events)
        self.audit.purge_older(self.settings.journal_keep_days)
        self.audit.log(
            "system",
            "start",
            "Сервер запущен",
            details={"Режим": "демо" if self.settings.demo_mode else self.settings.environment},
        )
        if self.settings.advice_autostart:
            self.advice.get()

    async def shutdown(self) -> None:
        await self.live.stop()
        self.db.stop()
