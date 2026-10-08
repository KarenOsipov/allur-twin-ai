from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core.config import Settings
from app.core.errors import UnauthorizedError
from app.services.user_service import DEMO_STAFF

log = logging.getLogger(__name__)


def _auth_password(password: str) -> str:
    return f"Allur-{password}" if password.isdigit() and len(password) < 6 else password


class SupabaseSyncService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def is_configured(self) -> bool:
        url = self.settings.effective_supabase_url
        key = self.settings.supabase_service_role_key
        return bool(url and key and key.get_secret_value())

    def verify_access_token(self, access_token: str) -> dict[str, Any]:
        url = self.settings.effective_supabase_url
        anon_key = self.settings.effective_supabase_anon_key
        if not url or not anon_key:
            raise RuntimeError("Supabase Auth не настроен")

        try:
            response = httpx.get(
                f"{url.rstrip('/')}/auth/v1/user",
                headers={"apikey": anon_key, "Authorization": f"Bearer {access_token}"},
                timeout=8.0,
            )
        except httpx.HTTPError as e:
            log.warning("Supabase Auth: не удалось проверить access token: %s", type(e).__name__)
            raise RuntimeError("Supabase Auth временно недоступен") from e

        if response.status_code in (401, 403):
            raise UnauthorizedError("Supabase отклонил вход")
        if response.status_code != 200:
            log.warning("Supabase Auth вернул HTTP %s при проверке пользователя", response.status_code)
            raise RuntimeError("Supabase Auth временно недоступен")

        try:
            auth_user = response.json()
        except (ValueError, AttributeError) as e:
            raise RuntimeError("Supabase Auth вернул некорректный ответ") from e
        if not isinstance(auth_user, dict):
            raise RuntimeError("Supabase Auth вернул некорректный ответ")
        email = auth_user.get("email")
        if not isinstance(email, str) or not email.strip():
            raise UnauthorizedError("У аккаунта Supabase не указан email")
        return {
            "email": email.strip().lower(),
            "app_metadata": auth_user.get("app_metadata"),
        }

    def sync_local_login(self, user: dict[str, Any], password: str) -> bool:
        url = self.settings.effective_supabase_url
        key = self.settings.supabase_service_role_key
        if not url or key is None or not key.get_secret_value():
            return False

        login = str(user["login"]).strip().lower()
        email = f"{login}@allur.local"
        service_key = key.get_secret_value().strip()
        endpoint = f"{url.rstrip('/')}/auth/v1/admin/users"
        headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "email": email,
            "password": _auth_password(password),
            "email_confirm": True,
            "user_metadata": {
                "name": user["name"],
                "position": user["position"],
                "login": login,
            },
            "app_metadata": {
                "user_id": user["id"],
                "role": user["role"],
                "area": user.get("area"),
            },
        }

        try:
            with httpx.Client(timeout=8.0) as client:
                page = 1
                existing_id = None
                while True:
                    response = client.get(endpoint, headers=headers, params={"page": page, "per_page": 100})
                    response.raise_for_status()
                    data = response.json()
                    users = data.get("users", []) if isinstance(data, dict) else data
                    if not isinstance(users, list):
                        raise ValueError("Invalid Supabase Auth user list")
                    for auth_user in users:
                        if isinstance(auth_user, dict) and str(auth_user.get("email", "")).lower() == email:
                            existing_id = auth_user.get("id")
                            break
                    if existing_id or len(users) < 100:
                        break
                    page += 1

                if existing_id:
                    response = client.put(
                        f"{endpoint}/{existing_id}",
                        headers=headers,
                        json={
                            **payload,
                            "user_metadata": payload["user_metadata"],
                            "app_metadata": payload["app_metadata"],
                        },
                    )
                else:
                    response = client.post(endpoint, headers=headers, json=payload)
                response.raise_for_status()
        except (httpx.HTTPError, ValueError) as e:
            log.error(
                "Не удалось синхронизировать учётную запись %s с Supabase Auth: %s",
                login,
                type(e).__name__,
            )
            return False
        return True

    def seed_demo_users(self) -> dict[str, Any]:
        url = self.settings.effective_supabase_url
        key = self.settings.supabase_service_role_key
        if not url or not key or not key.get_secret_value():
            return {
                "ok": False,
                "error": "SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не заданы в .env",
                "created": 0,
                "updated": 0,
                "errors": ["SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не заданы в .env"],
            }

        service_key = key.get_secret_value().strip()
        base_url = url.rstrip("/")
        admin_endpoint = f"{base_url}/auth/v1/admin/users"
        headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }

        created = 0
        updated = 0
        errors = []

        with httpx.Client(timeout=10.0) as client:
            existing_by_email: dict[str, str] = {}
            try:
                res = client.get(admin_endpoint, headers=headers, params={"page": 1, "per_page": 100})
                res.raise_for_status()
                data = res.json()
                users_list = data.get("users", []) if isinstance(data, dict) else data if isinstance(data, list) else []
                for u in users_list:
                    if isinstance(u, dict) and u.get("email") and u.get("id"):
                        existing_by_email[u["email"].lower()] = u["id"]
            except (httpx.HTTPError, ValueError) as e:
                log.error("Supabase Auth: не удалось получить пользователей для синхронизации: %s", type(e).__name__)
                return {
                    "ok": False,
                    "created": 0,
                    "updated": 0,
                    "errors": [f"Не удалось получить список пользователей Supabase Auth ({type(e).__name__})"],
                }

            for i, staff in enumerate(DEMO_STAFF, start=1):
                email = f"{staff['login']}@allur.local"
                admin_pin = self.settings.admin_pin_value() if staff["role"] == "admin" else None
                password = _auth_password(admin_pin or staff["pin"])
                meta = {
                    "name": staff["name"],
                    "position": staff["position"],
                    "area": staff.get("area"),
                    "login": staff["login"],
                }
                app_meta = {"user_id": i, "role": staff["role"], "area": staff.get("area")}
                user_id = existing_by_email.get(email.lower())
                if user_id:
                    try:
                        update_payload = {
                            "password": password,
                            "user_metadata": meta,
                            "app_metadata": app_meta,
                            "email_confirm": True,
                        }
                        up_res = client.put(f"{admin_endpoint}/{user_id}", headers=headers, json=update_payload)
                        if up_res.status_code in (200, 201):
                            updated += 1
                        else:
                            errors.append(f"{staff['login']}: HTTP {up_res.status_code}")
                    except httpx.HTTPError as e:
                        errors.append(f"{staff['login']}: ошибка запроса ({type(e).__name__})")
                else:
                    try:
                        create_payload = {
                            "email": email,
                            "password": password,
                            "email_confirm": True,
                            "user_metadata": meta,
                            "app_metadata": app_meta,
                        }
                        c_res = client.post(admin_endpoint, headers=headers, json=create_payload)
                        if c_res.status_code in (200, 201):
                            created += 1
                        else:
                            errors.append(f"{staff['login']}: HTTP {c_res.status_code}")
                    except httpx.HTTPError as e:
                        errors.append(f"{staff['login']}: ошибка запроса ({type(e).__name__})")

        log.info("Supabase Auth sync: создано %d, обновлено %d, ошибок %d", created, updated, len(errors))
        return {
            "ok": len(errors) == 0,
            "created": created,
            "updated": updated,
            "errors": errors,
        }
