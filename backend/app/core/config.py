from __future__ import annotations

import logging
import os
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Цифровой двойник завода АЛЛЮР"
    environment: str = "local"
    demo_mode: bool = True
    log_level: str = "INFO"

    secret_key: SecretStr | None = None
    admin_pin: SecretStr | None = None
    token_ttl_hours: int = 12
    login_attempts: int = 8
    login_window_s: int = 300
    user_lock_attempts: int = 5
    user_lock_minutes: int = 5

    data_dir: Path = Path("./data")
    database_url: str | None = None
    supabase_db_url: SecretStr | None = None
    db_check_s: float = 20
    db_mirror_min: float = 5

    sim_speed: float = 1.0
    sim_seed: int | None = None
    history_days: int = 97
    tz_offset_min: int = 300

    margin_per_car_kzt: int = 450_000
    rework_cost_kzt: int = 60_000
    labor_rate_kzt_h: int = 3_500
    overtime_rate_kzt_h: int = 5_250

    llm_provider: str = "auto"
    openrouter_api_key: SecretStr | None = None
    openrouter_model: str = "dots-studio/dots-3-note-preview:free"
    llm_timeout_s: float = 40.0

    advice_autostart: bool = True

    registration_enabled: bool = True

    journal_keep_days: int = 365

    max_upload_mb: int = 5

    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173", "http://localhost:8080"])

    @property
    def db_url(self) -> str:
        if not self.database_url:
            return f"sqlite:///{(self.data_dir / 'allur.db').resolve()}"
        for prefix in ("postgresql://", "postgres://"):
            if self.database_url.startswith(prefix):
                return "postgresql+psycopg://" + self.database_url[len(prefix) :]
        return self.database_url

    @property
    def primary_db_url(self) -> str | None:
        raw = self.supabase_db_url.get_secret_value().strip() if self.supabase_db_url else ""
        if not raw:
            return None
        for prefix in ("postgresql://", "postgres://", "postgresql+psycopg://"):
            if raw.startswith(prefix):
                raw = "postgresql+psycopg://" + raw[len(prefix) :]
                break
        local = any(h in raw for h in ("@localhost", "@127.0.0.1", "@db:"))
        if "sslmode=" not in raw and not local:
            raw += ("&" if "?" in raw else "?") + "sslmode=require"
        return raw

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def llm_provider_effective(self) -> str:
        def has(k: SecretStr | None) -> bool:
            return k is not None and bool(k.get_secret_value())

        if self.llm_provider.lower() in ("auto", "openrouter") and has(self.openrouter_api_key):
            return "openrouter"
        return "local"

    @property
    def llm_enabled(self) -> bool:
        return self.llm_provider_effective != "local"

    def admin_pin_value(self) -> str | None:
        if self.admin_pin is not None and self.admin_pin.get_secret_value():
            return self.admin_pin.get_secret_value()
        return None

    def signing_key(self) -> str:
        if self.secret_key is not None and self.secret_key.get_secret_value():
            return self.secret_key.get_secret_value()
        return _persisted_secret(self.data_dir)

    def validate_for_startup(self) -> None:
        if not self.is_production:
            return
        problems = []
        if self.demo_mode:
            problems.append("DEMO_MODE должен быть false")
        if self.secret_key is None or len(self.secret_key.get_secret_value()) < 32:
            problems.append("SECRET_KEY — минимум 32 символа")
        pin = self.admin_pin_value()
        if pin is None or len(pin) < 6:
            problems.append("ADMIN_PIN — минимум 6 цифр")
        if "allur_local_dev" in (self.database_url or ""):
            problems.append("POSTGRES_PASSWORD — задайте свой пароль базы")
        if problems:
            raise RuntimeError("Небезопасная конфигурация production: " + "; ".join(problems))


def _persisted_secret(data_dir: Path) -> str:
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / ".secret_key"
    if path.exists():
        return path.read_text().strip()
    key = secrets.token_urlsafe(48)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(key)
    log.info("Создан ключ подписи токенов: %s", path)
    return key


@lru_cache
def get_settings() -> Settings:
    return Settings()
