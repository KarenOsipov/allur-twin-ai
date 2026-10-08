from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger(__name__)


class AppError(Exception):
    status = 400
    code = "bad_request"

    def __init__(self, message: str, details: object | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class NotFoundError(AppError):
    status, code = 404, "not_found"


class UnauthorizedError(AppError):
    status, code = 401, "unauthorized"


class ForbiddenError(AppError):
    status, code = 403, "forbidden"


class TooManyRequestsError(AppError):
    status, code = 429, "too_many_requests"


class ValidationFailed(AppError):
    status, code = 422, "validation_failed"


def _body(code: str, message: str, details: object | None = None) -> dict:
    return {"error": {"code": code, "message": message, "details": details}}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        if exc.status == 403:
            audit = getattr(getattr(request.app.state, "container", None), "audit", None)
            if audit is not None:
                audit.log(
                    "auth", "forbidden", f"Отказано в доступе: {request.method} {request.url.path}", severity="warning"
                )
        return JSONResponse(_body(exc.code, exc.message, exc.details), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [{"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]
        return JSONResponse(
            _body("validation_failed", "Проверьте введённые данные", details),
            status_code=422,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        message = exc.detail if isinstance(exc.detail, str) else "Ошибка запроса"
        return JSONResponse(_body("http_error", message), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("Необработанная ошибка на %s %s", request.method, request.url.path)
        audit = getattr(getattr(request.app.state, "container", None), "audit", None)
        if audit is not None:
            audit.log(
                "system",
                "error",
                f"Ошибка сервера: {request.method} {request.url.path}",
                severity="critical",
                details={"Тип": type(exc).__name__},
            )
        return JSONResponse(
            _body("internal", "Внутренняя ошибка сервера. Подробности — в логах."),
            status_code=500,
        )
