from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
from datetime import datetime, timedelta

from sqlalchemy import func, select

from app.core.clock import plant_now
from app.core.config import Settings
from app.core.errors import ForbiddenError, NotFoundError, TooManyRequestsError, UnauthorizedError, ValidationFailed
from app.core.security import ROLE_NAMES, Role, hash_pin, verify_pin, weak_pin
from app.db.base import Database
from app.db.models import SettingValue, User

DEMO_STAFF: list[dict] = [
    {
        "name": "Нуржан Ахметов",
        "position": "Администратор системы",
        "role": "admin",
        "area": None,
        "pin": "0000",
        "login": "admin",
    },
    {
        "name": "Айгерим Касымова",
        "position": "Директор по производству",
        "role": "director",
        "area": None,
        "pin": "1111",
        "login": "director",
    },
    {
        "name": "Ерлан Жумабеков",
        "position": "Начальник смены",
        "role": "supervisor",
        "area": None,
        "pin": "2222",
        "login": "smena1",
    },
    {
        "name": "Сергей Ковалёв",
        "position": "Начальник смены",
        "role": "supervisor",
        "area": None,
        "pin": "2323",
        "login": "smena2",
    },
    {
        "name": "Данияр Оспанов",
        "position": "Оператор окраски",
        "role": "worker",
        "area": "PAINT",
        "pin": "3333",
        "login": "okraska",
    },
    {
        "name": "Асель Нурланова",
        "position": "Оператор сварочной линии",
        "role": "worker",
        "area": "WELD",
        "pin": "4444",
        "login": "svarka",
    },
    {
        "name": "Тимур Беков",
        "position": "Сборщик главного конвейера",
        "role": "worker",
        "area": "ASSY",
        "pin": "5555",
        "login": "sborka",
    },
    {
        "name": "Марат Ибраев",
        "position": "Контролёр ОТК",
        "role": "worker",
        "area": "QC",
        "pin": "6666",
        "login": "otk",
    },
    {
        "name": "Бауыржан Сейтказы",
        "position": "Кладовщик склада комплектующих",
        "role": "worker",
        "area": "WH_IN",
        "pin": "7777",
        "login": "sklad",
    },
]
DEMO_BY_NAME = {s["name"]: s for s in DEMO_STAFF}
LOGIN_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,39}$")
PEPPER_KEY = "pin_pepper"
WRONG_PIN = "Неверный PIN-код"


def public(u: User, *, demo_pin: str | None = None) -> dict:
    return {
        "id": u.id,
        "name": u.name,
        "position": u.position,
        "role": u.role,
        "role_name": ROLE_NAMES[Role(u.role)],
        "area": u.area,
        "login": u.login,
        "demo_pin": demo_pin,
    }


def full(u: User) -> dict:
    return {
        **public(u),
        "status": u.status or "active",
        "request_note": u.request_note,
        "active": u.active,
        "locked_until": u.locked_until,
        "last_login": u.last_login,
        "created_at": u.created_at,
    }


def norm_login(v: str) -> str:
    return (v or "").strip().lower()


class UserService:
    def __init__(self, db: Database, settings: Settings) -> None:
        self.db = db
        self.settings = settings
        self._active: dict[int, bool] = {}
        self._hints: dict[str, str | None] = {}
        self._pepper: bytes | None = None
        self._lock = threading.Lock()

    def now(self) -> datetime:
        return plant_now(self.settings.tz_offset_min)

    def _key(self, s, secret: str) -> str:
        if self._pepper is None:
            row = s.get(SettingValue, PEPPER_KEY)
            if row is None:
                row = SettingValue(key=PEPPER_KEY, value={"v": secrets.token_hex(32)})
                s.add(row)
                s.flush()
            self._pepper = bytes.fromhex(row.value["v"])
        return hmac.new(self._pepper, secret.encode(), hashlib.sha256).hexdigest()

    def seed(self) -> None:
        with self.db.session() as s:
            if (s.scalar(select(func.count(User.id))) or 0) == 0:
                now = self.now()
                if self.settings.demo_mode:
                    admin_pin = self.settings.admin_pin_value()
                    for p in DEMO_STAFF:
                        pin = admin_pin if p["role"] == "admin" and admin_pin else p["pin"]
                        s.add(
                            User(
                                name=p["name"],
                                position=p["position"],
                                role=p["role"],
                                area=p["area"],
                                login=p["login"],
                                pin_hash=hash_pin(pin),
                                pin_key=self._key(s, pin),
                                active=True,
                                created_at=now,
                            )
                        )
                else:
                    pin = self.settings.admin_pin_value()
                    if pin:
                        s.add(
                            User(
                                name="Администратор",
                                position="Администратор системы",
                                role="admin",
                                area=None,
                                login="admin",
                                pin_hash=hash_pin(pin),
                                pin_key=self._key(s, pin),
                                active=True,
                                created_at=now,
                            )
                        )
        self._migrate()

    def _migrate(self) -> None:
        with self.db.session() as s:
            users = list(s.scalars(select(User).where((User.login.is_(None)) | (User.pin_key.is_(None)))))
            if not users:
                return
            taken = {x for x in s.scalars(select(User.login).where(User.login.is_not(None)))}
            for u in users:
                demo = DEMO_BY_NAME.get(u.name)
                if u.login is None:
                    want = demo["login"] if demo else f"user{u.id}"
                    if want in taken:
                        want = f"user{u.id}"
                    u.login = want
                    taken.add(want)
                if u.pin_key is None and demo and verify_pin(demo["pin"], u.pin_hash):
                    u.pin_key = self._key(s, demo["pin"])

    def login_list(self) -> list[dict]:
        if not self.settings.demo_mode:
            return []
        with self.db.session() as s:
            users = list(s.scalars(select(User).where(User.active.is_(True)).order_by(User.id)))
            out = []
            for u in users:
                if u.pin_hash not in self._hints:
                    demo = DEMO_BY_NAME.get(u.name)
                    pin = demo["pin"] if demo else None
                    self._hints[u.pin_hash] = pin if pin and verify_pin(pin, u.pin_hash) else None
                out.append(public(u, demo_pin=self._hints[u.pin_hash]))
        return out

    def authenticate(self, user_id: int, pin: str) -> dict:
        with self.db.session() as s:
            u = s.get(User, user_id)
            login = u.login if u else None
        if login is None:
            raise UnauthorizedError("Сотрудник не найден или отключён")
        return self.authenticate_login(login, pin)

    def authenticate_login(self, login: str, password: str) -> dict:
        now = self.now()
        error: Exception | None = None
        with self.db.session() as s:
            u = s.scalar(select(User).where(User.login == norm_login(login)))
            if u is not None and u.status in ("pending", "rejected") and verify_pin(password, u.pin_hash):
                error = ForbiddenError(
                    "Заявка на доступ ждёт подтверждения администратором"
                    if u.status == "pending"
                    else "Заявка на доступ отклонена. Обратитесь к администратору"
                )
            elif u is None or not u.active:
                verify_pin(password, _DUMMY_HASH)
                error = UnauthorizedError("Неверный логин или пароль")
            elif u.locked_until and u.locked_until > now:
                wait = int((u.locked_until - now).total_seconds() // 60) + 1
                error = TooManyRequestsError(f"Вход заблокирован после неверных попыток. Повторите через {wait} мин")
            elif not verify_pin(password, u.pin_hash):
                u.failed_attempts += 1
                left = self.settings.user_lock_attempts - u.failed_attempts
                if left <= 0:
                    u.locked_until = now + timedelta(minutes=self.settings.user_lock_minutes)
                    u.failed_attempts = 0
                    error = TooManyRequestsError(
                        f"Неверный пароль. Вход заблокирован на {self.settings.user_lock_minutes} мин"
                    )
                else:
                    error = UnauthorizedError(f"Неверный логин или пароль. Осталось попыток: {left}")
            else:
                out = self._success(s, u, password, now)
        if error is not None:
            raise error
        return out

    def authenticate_pin(self, pin: str) -> dict:
        now = self.now()
        error: Exception | None = None
        with self.db.session() as s:
            u = s.scalar(select(User).where(User.pin_key == self._key(s, pin)))
            if u is None:
                for cand in s.scalars(select(User).where(User.pin_key.is_(None), User.active.is_(True))):
                    if verify_pin(pin, cand.pin_hash):
                        u = cand
                        break
            if u is None or not u.active or not verify_pin(pin, u.pin_hash):
                error = UnauthorizedError(WRONG_PIN)
            elif u.locked_until and u.locked_until > now:
                wait = int((u.locked_until - now).total_seconds() // 60) + 1
                error = TooManyRequestsError(f"Вход заблокирован после неверных попыток. Повторите через {wait} мин")
            else:
                out = self._success(s, u, pin, now)
        if error is not None:
            raise error
        return out

    def _success(self, s, u: User, secret: str, now: datetime) -> dict:
        u.failed_attempts = 0
        u.locked_until = None
        u.last_login = now
        if u.pin_key is None:
            key = self._key(s, secret)
            if s.scalar(select(func.count(User.id)).where(User.pin_key == key)) == 0:
                u.pin_key = key
        return public(u)

    def is_active(self, user_id: int) -> bool:
        with self._lock:
            if user_id in self._active:
                return self._active[user_id]
        with self.db.session() as s:
            u = s.get(User, user_id)
            ok = bool(u and u.active)
        with self._lock:
            if len(self._active) > 1000:
                self._active.clear()
            self._active[user_id] = ok
        return ok

    def _forget(self, user_id: int) -> None:
        with self._lock:
            self._active.pop(user_id, None)

    def list(self) -> list[dict]:
        with self.db.session() as s:
            rows = s.scalars(
                select(User)
                .where((User.status.is_(None)) | (User.status != "rejected"))
                .order_by(User.active.desc(), User.role, User.name)
            )
            return [full(u) for u in rows]

    def get(self, user_id: int) -> dict:
        with self.db.session() as s:
            u = s.get(User, user_id)
            if u is None:
                raise NotFoundError("Сотрудник не найден")
            return full(u)

    def _check_secret(self, secret: str, s, exclude: int | None = None) -> str:
        digits = secret.isdigit()
        if digits:
            if not 4 <= len(secret) <= 12:
                raise ValidationFailed("PIN — от 4 до 12 цифр")
            if not self.settings.demo_mode:
                problem = weak_pin(secret)
                if problem or len(secret) < 6:
                    raise ValidationFailed(problem or "PIN — минимум 6 цифр")
        else:
            least = 6 if self.settings.demo_mode else 8
            if len(secret) < least:
                raise ValidationFailed(f"Пароль — минимум {least} символов")
            if secret.strip() != secret:
                raise ValidationFailed("Пароль не должен начинаться или заканчиваться пробелом")
        key = self._key(s, secret)
        clash = s.scalar(select(User).where(User.pin_key == key, User.active.is_(True)))
        if clash is None:
            for other in s.scalars(select(User).where(User.pin_key.is_(None), User.active.is_(True))):
                if verify_pin(secret, other.pin_hash):
                    clash = other
                    break
        if clash is not None and clash.id != exclude:
            raise ValidationFailed(
                ("Такой PIN" if digits else "Такой пароль") + " уже у другого сотрудника — выберите другой"
            )
        return key

    def _check_login(self, login: str, s, exclude: int | None = None) -> str:
        v = norm_login(login)
        if not LOGIN_RE.match(v):
            raise ValidationFailed("Логин — от 3 до 40 символов: латинские буквы, цифры, точка, дефис")
        other = s.scalar(select(User).where(User.login == v))
        if other is not None and other.id != exclude:
            raise ValidationFailed("Такой логин уже занят")
        return v

    def _free_login(self, s, name: str) -> str:
        base = _translit(name.split()[0] if name.split() else "user") or "user"
        cand, i = base, 2
        while s.scalar(select(User).where(User.login == cand)) is not None:
            cand, i = f"{base}{i}", i + 1
        return cand

    def create(self, data: dict) -> dict:
        with self.db.session() as s:
            key = self._check_secret(data["pin"], s)
            login = self._check_login(data["login"], s) if data.get("login") else self._free_login(s, data["name"])
            u = User(
                name=data["name"],
                position=data["position"],
                role=data["role"],
                area=data.get("area") if data["role"] == "worker" else None,
                login=login,
                pin_hash=hash_pin(data["pin"]),
                pin_key=key,
                active=True,
                created_at=self.now(),
            )
            if u.role == "worker" and not u.area:
                raise ValidationFailed("Для рабочего укажите участок")
            s.add(u)
            s.flush()
            return full(u)

    def register(self, data: dict) -> dict:
        if data["role"] == "admin":
            raise ValidationFailed("Роль администратора назначает только администратор")
        if data["role"] == "worker" and not data.get("area"):
            raise ValidationFailed("Для рабочего укажите участок")
        with self.db.session() as s:
            pending = s.scalar(select(func.count(User.id)).where(User.status == "pending")) or 0
            if pending >= 50:
                raise ValidationFailed("Слишком много заявок ждут проверки — попробуйте позже")
            key = self._check_secret(data["password"], s)
            login = self._check_login(data["login"], s)
            u = User(
                name=data["name"].strip(),
                position=data["position"].strip(),
                role=data["role"],
                area=data.get("area") if data["role"] == "worker" else None,
                login=login,
                pin_hash=hash_pin(data["password"]),
                pin_key=key,
                active=False,
                status="pending",
                request_note=(data.get("note") or "").strip()[:500] or None,
                created_at=self.now(),
            )
            s.add(u)
            s.flush()
            return full(u)

    def pending(self) -> int:
        with self.db.session() as s:
            return s.scalar(select(func.count(User.id)).where(User.status == "pending")) or 0

    def decide(self, user_id: int, approve: bool, changes: dict | None = None) -> dict:
        with self.db.session() as s:
            u = s.get(User, user_id)
            if u is None:
                raise NotFoundError("Заявка не найдена")
            if u.status != "pending":
                raise ValidationFailed("Заявка уже рассмотрена")
            if approve:
                for k in ("role", "position", "area"):
                    if changes and changes.get(k):
                        setattr(u, k, changes[k])
                if u.role != "worker":
                    u.area = None
                elif not u.area:
                    raise ValidationFailed("Для рабочего укажите участок")
                u.active, u.status = True, "active"
            else:
                u.active, u.status = False, "rejected"
            out = full(u)
        self._forget(user_id)
        self._hints.clear()
        return out

    def update(self, user_id: int, data: dict, *, by_user_id: int) -> dict:
        with self.db.session() as s:
            u = s.get(User, user_id)
            if u is None:
                raise NotFoundError("Сотрудник не найден")
            if user_id == by_user_id and (data.get("active") is False or data.get("role", u.role) != u.role):
                raise ForbiddenError("Нельзя отключить себя или сменить свою роль")
            for k in ("name", "position", "role", "area", "active"):
                if k in data and data[k] is not None:
                    setattr(u, k, data[k])
            if data.get("active") is True and u.status in ("pending", "rejected"):
                u.status = "active"
            if "area" in data and data["area"] is None:
                u.area = None
            if u.role != "worker":
                u.area = None
            elif not u.area:
                raise ValidationFailed("Для рабочего укажите участок")
            if data.get("login"):
                u.login = self._check_login(data["login"], s, exclude=u.id)
            if data.get("pin"):
                u.pin_key = self._check_secret(data["pin"], s, exclude=u.id)
                u.pin_hash = hash_pin(data["pin"])
                u.failed_attempts = 0
                u.locked_until = None
            if u.role != "admin" or not u.active:
                admins = s.scalar(
                    select(func.count(User.id)).where(User.role == "admin", User.active.is_(True), User.id != u.id)
                )
                if not admins:
                    raise ValidationFailed("Должен остаться хотя бы один активный администратор")
            out = full(u)
        self._forget(user_id)
        return out


_DUMMY_HASH = hash_pin(secrets.token_hex(8))

_TR = dict(
    zip(
        "абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһі",
        [
            "a",
            "b",
            "v",
            "g",
            "d",
            "e",
            "e",
            "zh",
            "z",
            "i",
            "y",
            "k",
            "l",
            "m",
            "n",
            "o",
            "p",
            "r",
            "s",
            "t",
            "u",
            "f",
            "h",
            "ts",
            "ch",
            "sh",
            "sch",
            "",
            "y",
            "",
            "e",
            "yu",
            "ya",
            "a",
            "g",
            "k",
            "n",
            "o",
            "u",
            "u",
            "h",
            "i",
        ],
        strict=True,
    )
)


def _translit(s: str) -> str:
    out = "".join(_TR.get(ch, ch) for ch in s.lower())
    out = re.sub(r"[^a-z0-9]", "", out)
    return out[:30] if len(out) >= 3 else (out + "user")[:30]
