from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request

from app.container import Container
from app.core.errors import ForbiddenError, UnauthorizedError
from app.core.security import Permission, Session, verify_token


def get_container(request: Request) -> Container:
    return request.app.state.container


def require_session(request: Request) -> Session:
    c: Container = request.app.state.container
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else None
    session = verify_token(token, c.settings.signing_key())
    if session is None:
        raise UnauthorizedError("Войдите в систему")
    if not c.users.is_active(session.user_id):
        raise UnauthorizedError("Пользователь заблокирован или не найден")
    return session


def requires(permission: Permission):
    def _check(session: Annotated[Session, Depends(require_session)]) -> Session:
        if not session.can(permission):
            raise ForbiddenError("Недостаточно прав для этого действия")
        return session

    return _check


def client_ip(request: Request) -> str:
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return request.client.host if request.client else "unknown"


class Scope:
    def __init__(self, c: Container, sandbox=None) -> None:
        self.sandbox = sandbox
        self.analytics = sandbox.analytics if sandbox else c.analytics
        self.assistant = sandbox.assistant if sandbox else c.assistant


def get_scope(request: Request, session: Annotated[Session, Depends(requires(Permission.VIEW))]) -> Scope:
    c: Container = request.app.state.container
    sandbox_id = request.headers.get("x-sandbox", "").strip()
    if not sandbox_id:
        return Scope(c)
    return Scope(c, c.sandboxes.get(sandbox_id[:40], session.sandbox_owner))


ContainerDep = Annotated[Container, Depends(get_container)]
ScopeDep = Annotated[Scope, Depends(get_scope)]
SessionDep = Annotated[Session, Depends(require_session)]
ViewerDep = Annotated[Session, Depends(requires(Permission.VIEW))]
OperatorDep = Annotated[Session, Depends(requires(Permission.OPERATE))]
ShiftDep = Annotated[Session, Depends(requires(Permission.SHIFT))]
ReporterDep = Annotated[Session, Depends(requires(Permission.REPORT))]
AdminDep = Annotated[Session, Depends(requires(Permission.MANAGE_DATA))]
UsersAdminDep = Annotated[Session, Depends(requires(Permission.MANAGE_USERS))]
