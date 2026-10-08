from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from enum import StrEnum


class Role(StrEnum):
    ADMIN = "admin"
    DIRECTOR = "director"
    SUPERVISOR = "supervisor"
    WORKER = "worker"


ROLE_NAMES = {
    Role.ADMIN: "Администратор",
    Role.DIRECTOR: "Руководитель",
    Role.SUPERVISOR: "Начальник смены",
    Role.WORKER: "Рабочий",
}


class Permission(StrEnum):
    VIEW = "view"
    OPERATE = "operate"
    SHIFT = "shift"
    REPORT = "report"
    MANAGE_DATA = "manage_data"
    MANAGE_USERS = "manage_users"


GRANTS: dict[Role, frozenset[Permission]] = {
    Role.ADMIN: frozenset(Permission),
    Role.DIRECTOR: frozenset({Permission.VIEW, Permission.OPERATE, Permission.REPORT}),
    Role.SUPERVISOR: frozenset({Permission.VIEW, Permission.OPERATE, Permission.SHIFT, Permission.REPORT}),
    Role.WORKER: frozenset({Permission.VIEW, Permission.REPORT}),
}


@dataclass(frozen=True)
class Session:
    user_id: int
    role: Role
    name: str
    position: str
    area: str | None
    expires_at: int

    def can(self, permission: Permission) -> bool:
        return permission in GRANTS[self.role]

    @property
    def permissions(self) -> list[str]:
        return sorted(GRANTS[self.role])

    @property
    def sandbox_owner(self) -> str:
        return f"u{self.user_id}"

    @property
    def signature(self) -> str:
        return f"{self.name} ({self.position.lower()})" if self.position else self.name


PBKDF2_ROUNDS = 120_000


def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${_b64(salt)}${_b64(digest)}"


def verify_pin(pin: str, stored: str) -> bool:
    try:
        algo, rounds, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        calc = hashlib.pbkdf2_hmac("sha256", pin.strip().encode(), _unb64(salt), int(rounds))
    except (ValueError, TypeError):
        return False
    return secrets.compare_digest(calc, _unb64(digest))


def weak_pin(pin: str) -> str | None:
    if not pin.isdigit():
        return "PIN — только цифры"
    if len(pin) < 4:
        return "PIN — минимум 4 цифры"
    if len(set(pin)) == 1 or pin in "0123456789" or pin in "9876543210":
        return "Слишком простой PIN: одинаковые или подряд идущие цифры"
    return None


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _sign(secret: str, payload: str) -> str:
    return _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def create_token(
    secret: str, *, user_id: int, role: Role, name: str, position: str, area: str | None, ttl_hours: int
) -> tuple[str, int]:
    expires_at = int(time.time()) + ttl_hours * 3600
    body = {
        "uid": user_id,
        "role": role.value,
        "name": name,
        "pos": position,
        "area": area,
        "exp": expires_at,
        "jti": secrets.token_hex(8),
    }
    payload = _b64(json.dumps(body, ensure_ascii=False).encode())
    return f"{payload}.{_sign(secret, payload)}", expires_at


def verify_token(token: str | None, secret: str) -> Session | None:
    if not token or token.count(".") != 1 or len(token) > 2048:
        return None
    payload, sig = token.split(".", 1)
    if not secrets.compare_digest(sig, _sign(secret, payload)):
        return None
    try:
        data = json.loads(_unb64(payload))
        role = Role(data["role"])
        exp = int(data["exp"])
        uid = int(data["uid"])
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None
    if exp < time.time():
        return None
    return Session(
        user_id=uid,
        role=role,
        name=str(data.get("name", ROLE_NAMES[role])),
        position=str(data.get("pos", ROLE_NAMES[role])),
        area=data.get("area"),
        expires_at=exp,
    )
