from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app import __version__
from app.api.deps import AdminDep, ContainerDep, ViewerDep
from app.container import Container
from app.core.errors import ValidationFailed
from app.core.security import Permission, verify_token

router = APIRouter(tags=["Система"])

AUTH_TIMEOUT_S = 5


@router.get("/health", summary="Проверка, что сервер жив")
def health(c: ContainerDep) -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "demo": c.settings.demo_mode,
        "assistant": c.assistant.llm.label,
        "database": "supabase" if c.db.is_primary else "local",
        "database_fallback": c.db.state["configured"] and not c.db.is_primary,
    }


@router.get("/system/db", summary="Какая база работает: Supabase или локальная, зеркало, связь")
def db_status(c: ContainerDep, _: ViewerDep) -> dict:
    return {**c.db.status(), "counts": c.db.counts()}


@router.post("/system/db/mirror", summary="Обновить локальное зеркало Supabase сейчас")
def db_mirror(c: ContainerDep, session: AdminDep) -> dict:
    try:
        counts = c.db.mirror_now()
    except Exception as e:
        raise ValidationFailed(f"Зеркало не обновлено: {e}") from e
    c.audit.log("system", "database", f"Обновлено локальное зеркало: {sum(counts.values())} строк", actor=session.name)
    return c.db.status()


@router.post("/system/db/use-primary", summary="Вернуться на Supabase (transfer — перенести туда локальные данные)")
def db_use_primary(c: ContainerDep, session: AdminDep, transfer: bool = True) -> dict:
    try:
        out = c.db.use_primary(transfer=transfer)
    except Exception as e:
        raise ValidationFailed(str(e)) from e
    c.audit.log(
        "system",
        "database",
        f"Работа снова на {out['label']}" + (" с переносом локальных данных" if transfer else " без переноса"),
        actor=session.name,
        severity="warning",
    )
    return out


@router.websocket("/ws")
async def events(ws: WebSocket) -> None:
    c: Container = ws.app.state.container
    await ws.accept()
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=AUTH_TIMEOUT_S)
        token = json.loads(raw).get("token")
    except (TimeoutError, json.JSONDecodeError, AttributeError, WebSocketDisconnect):
        with contextlib.suppress(Exception):
            await ws.close(code=4401)
        return
    session = verify_token(token, c.settings.signing_key())
    if session is None:
        await ws.close(code=4401)
        return

    def accept(event: str, data) -> bool:
        if event.startswith("chat."):
            if not c.chat.can_read(session, (data or {}).get("channel", "")):
                return False
            return not (event == "chat.typing" and data.get("user_id") == session.user_id)
        if event == "users.request":
            return session.can(Permission.MANAGE_USERS)
        if event in ("problem.update", "problem.reported"):
            d = data or {}
            mine = d.get("reporter_id") == session.user_id or (
                d.get("reporter_id") is None and d.get("reported_by") == session.name
            )
            return mine or session.can(Permission.OPERATE)
        if event == "shift.ready":
            return session.can(Permission.OPERATE) or (data or {}).get("user_id") == session.user_id
        return True

    queue = c.events.subscribe(accept)
    if c.chat.presence.join(session.user_id):
        c.events.publish("presence", {"user_id": session.user_id, "online": True})

    async def sender() -> None:
        await ws.send_text(json.dumps({"event": "hello", "data": {"role": session.role.value}}))
        await ws.send_text(json.dumps({"event": "floor", "data": c.live.snapshot()}, ensure_ascii=False, default=str))
        while True:
            await ws.send_text(await queue.get())

    async def receiver() -> None:
        while True:
            raw = await ws.receive_text()
            if len(raw) > 500:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict) and msg.get("type") == "typing":
                c.chat.typing(session, msg.get("channel"))

    tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(BaseException):
                await t
        c.events.unsubscribe(queue)
        if c.chat.presence.leave(session.user_id):
            c.events.publish("presence", {"user_id": session.user_id, "online": False})
