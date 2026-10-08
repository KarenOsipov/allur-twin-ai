from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app import __version__
from app.api.router import api
from app.container import Container
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.logging import setup_logging

log = logging.getLogger("allur")

DESCRIPTION = """
**Цифровой двойник** сборочного производства АО «Группа компаний АЛЛЮР»: живая модель цеха, показатели против целей,
прогнозы и рекомендации ИИ, сценарии «что если».

Вход: `POST /api/v1/auth/login` с ролью и PIN → токен → кнопка **Authorize** (Bearer).
"""

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


def create_app() -> FastAPI:
    settings = get_settings()
    setup_logging(settings.log_level)
    settings.validate_for_startup()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        container = Container.build(settings)
        container.start()
        app.state.container = container
        log.info(
            "Цифровой двойник %s готов · режим %s · ассистент: %s",
            __version__,
            "демо" if settings.demo_mode else settings.environment,
            settings.llm_provider_effective,
        )
        yield
        await container.shutdown()

    app = FastAPI(
        title="Цифровой двойник завода АЛЛЮР — API",
        version=__version__,
        description=DESCRIPTION,
        lifespan=lifespan,
        docs_url=None if settings.is_production else "/api/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/api/openapi.json",
        swagger_ui_parameters={"persistAuthorization": True},
    )
    app.add_middleware(GZipMiddleware, minimum_size=2048)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Sandbox"],
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/") and not request.url.path.startswith("/api/docs"):
            for k, v in SECURITY_HEADERS.items():
                response.headers.setdefault(k, v)
        return response

    register_error_handlers(app)
    app.include_router(api)
    return app


app = create_app()
