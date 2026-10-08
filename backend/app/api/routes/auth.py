from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import select

from app.api.deps import ContainerDep, SessionDep, client_ip
from app.core.errors import AppError, ForbiddenError, TooManyRequestsError, ValidationFailed
from app.core.security import Role, create_token
from app.db.models import User
from app.schemas.requests import LoginIn, RegisterIn, SupabaseSessionIn
from app.services.user_service import public

router = APIRouter(prefix="/auth", tags=["Вход"])


@router.get("/users", summary="Сотрудники для экрана входа")
def users(c: ContainerDep) -> dict:
    return {
        "demo": c.settings.demo_mode,
        "registration": c.settings.registration_enabled,
        "areas": [{"code": a.code, "name": a.name} for a in c.plant.areas],
        "users": c.users.login_list(),
    }


@router.post("/login", summary="Вход по личному PIN")
def login(body: LoginIn, request: Request, c: ContainerDep) -> dict:
    ip = client_ip(request)
    key = f"login:{ip}"
    wait = c.login_limiter.blocked_for(key)
    if wait > 0:
        c.audit.log(
            "auth",
            "blocked",
            "Вход с адреса временно заблокирован: много неверных попыток",
            severity="critical",
            details={"ip": ip},
        )
        raise TooManyRequestsError(f"Слишком много попыток. Повторите через {int(wait) + 1} с")
    try:
        if body.login:
            who = f"логин «{body.login[:40]}»"
            user = c.users.authenticate_login(body.login, body.pin)
        elif body.user_id:
            who = f"сотрудник №{body.user_id}"
            user = c.users.authenticate(body.user_id, body.pin)
        else:
            who = "вход по PIN"
            if not body.pin.isdigit() or not 4 <= len(body.pin) <= 12:
                raise ValidationFailed("PIN-код — от 4 до 12 цифр")
            user = c.users.authenticate_pin(body.pin)
    except AppError as e:
        c.login_limiter.hit(key)
        c.audit.log(
            "auth",
            "login_failed",
            f"Неудачный вход ({who})",
            severity="warning",
            details={"ip": ip, "Причина": e.message},
        )
        raise
    c.login_limiter.reset(key)
    c.audit.log(
        "auth", "login", f"Вход: {user['name']} — {user['position'].lower()}", actor=user["name"], details={"ip": ip}
    )
    token, expires_at = create_token(
        c.settings.signing_key(),
        user_id=user["id"],
        role=Role(user["role"]),
        name=user["name"],
        position=user["position"],
        area=user["area"],
        ttl_hours=c.settings.token_ttl_hours,
    )
    supabase_auth_synced = False
    if c.supabase.is_configured and user.get("login"):
        supabase_auth_synced = c.supabase.sync_local_login(user, body.pin)
    return {
        "token": token,
        "expires_at": expires_at,
        "supabase_auth_synced": supabase_auth_synced,
        **user,
    }


@router.post("/supabase-session", summary="Проверить Supabase Auth и выдать токен приложения")
def supabase_session(body: SupabaseSessionIn, request: Request, c: ContainerDep) -> dict:
    ip = client_ip(request)
    key = f"login:{ip}"
    wait = c.login_limiter.blocked_for(key)
    if wait > 0:
        raise TooManyRequestsError(f"Слишком много попыток. Повторите через {int(wait) + 1} с")

    try:
        auth_user = c.supabase.verify_access_token(body.access_token)
        email = auth_user["email"]
        app_metadata = auth_user.get("app_metadata")
        prefix, separator, domain = email.partition("@")
        if not separator or domain != "allur.local":
            raise ForbiddenError("Для входа используйте учётную запись, заведённую администратором системы")

        with c.db.session() as db_session:
            user = db_session.scalar(select(User).where(User.login == prefix.lower()))
            if user is None or not user.active or user.status not in (None, "active"):
                raise ForbiddenError("Учётная запись не найдена, отключена или не подтверждена администратором")
            if (
                not isinstance(app_metadata, dict)
                or str(app_metadata.get("user_id")) != str(user.id)
                or app_metadata.get("role") != user.role
                or app_metadata.get("area") != user.area
            ):
                raise ForbiddenError("Учётная запись Supabase не синхронизирована с профилем сотрудника")
            identity = {
                "id": user.id,
                "name": user.name,
                "position": user.position,
                "role": user.role,
                "role_name": public(user)["role_name"],
                "area": user.area,
                "login": user.login,
                "demo_pin": None,
            }
    except AppError as e:
        c.login_limiter.hit(key)
        c.audit.log(
            "auth",
            "login_failed",
            "Неудачный вход через Supabase Auth",
            severity="warning",
            details={"ip": ip, "Причина": e.message},
        )
        raise

    c.login_limiter.reset(key)
    token, expires_at = create_token(
        c.settings.signing_key(),
        user_id=identity["id"],
        role=Role(identity["role"]),
        name=identity["name"],
        position=identity["position"],
        area=identity["area"],
        ttl_hours=c.settings.token_ttl_hours,
    )
    c.audit.log(
        "auth",
        "login",
        f"Вход через Supabase Auth: {identity['name']} — {identity['position'].lower()}",
        actor=identity["name"],
        details={"ip": ip, "login": identity["login"]},
    )
    return {"token": token, "expires_at": expires_at, **identity}


@router.post("/register", summary="Заявка на доступ: сотрудник войдёт после подтверждения администратором")
def register(body: RegisterIn, request: Request, c: ContainerDep) -> dict:
    if not c.settings.registration_enabled:
        raise ForbiddenError("Заявки на доступ отключены — обратитесь к администратору")
    ip = client_ip(request)
    key = f"register:{ip}"
    if c.register_limiter.blocked_for(key) > 0:
        raise TooManyRequestsError("Слишком много заявок с этого адреса. Попробуйте позже")
    c.register_limiter.hit(key)
    if body.area is not None and body.area not in {a.code for a in c.plant.areas}:
        raise ValidationFailed("Неизвестный участок")
    u = c.users.register(body.model_dump())
    c.audit.log(
        "users",
        "request",
        f"Заявка на доступ: {u['name']} — {u['position'].lower()} ({u['role_name'].lower()})",
        actor=u["name"],
        severity="warning",
        details={"Логин": u["login"], "Участок": u["area"], "Комментарий": u["request_note"], "ip": ip},
    )
    c.events.publish("users.request", {"id": u["id"], "name": u["name"], "role_name": u["role_name"]})
    return {
        "ok": True,
        "login": u["login"],
        "message": "Заявка отправлена. Войти можно после подтверждения администратором.",
    }


@router.get("/me", summary="Текущая сессия")
def me(session: SessionDep) -> dict:
    return {
        "id": session.user_id,
        "role": session.role.value,
        "name": session.name,
        "position": session.position,
        "area": session.area,
        "expires_at": session.expires_at,
        "permissions": session.permissions,
    }


@router.post("/logout", summary="Выход (для журнала)")
def logout(c: ContainerDep, session: SessionDep) -> dict:
    c.audit.log("auth", "logout", f"Выход: {session.name}", actor=session.name)
    return {"ok": True}
