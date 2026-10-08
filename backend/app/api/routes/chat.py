from __future__ import annotations

from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import Response

from app.api.deps import ContainerDep, SessionDep
from app.core.errors import TooManyRequestsError, ValidationFailed
from app.schemas.requests import ChatEditIn, ChatIn, ChatReadIn
from app.services.chat_service import dm_id

router = APIRouter(prefix="/chat", tags=["Чат"])

MAX_PHOTO = 6 * 1024 * 1024
MAGIC = {b"\xff\xd8\xff": "image/jpeg", b"\x89PNG\r\n\x1a\n": "image/png", b"RIFF": "image/webp"}


def _limit(c, session) -> None:
    key = f"chat:{session.user_id}"
    if c.chat_limiter.blocked_for(key) > 0:
        raise TooManyRequestsError("Слишком много сообщений подряд — подождите немного")
    c.chat_limiter.hit(key)


@router.get("", summary="Мои каналы и личные переписки: последнее сообщение, непрочитанные")
def channels(c: ContainerDep, session: SessionDep) -> list[dict]:
    return c.chat.visible(session)


@router.get("/people", summary="Коллеги для личных сообщений и кто сейчас в сети")
def people(c: ContainerDep, session: SessionDep) -> list[dict]:
    return c.chat.people(session)


@router.get("/dm/{user_id}", summary="Канал личной переписки с сотрудником")
def dm(user_id: int, c: ContainerDep, session: SessionDep) -> dict:
    if user_id == session.user_id:
        raise ValidationFailed("Нельзя написать самому себе")
    channel = dm_id(session.user_id, user_id)
    c.chat.history(session, channel, limit=1)
    return {"channel": channel}


@router.get("/files/{file_id}", summary="Фото из чата")
def photo(file_id: int, c: ContainerDep, session: SessionDep) -> Response:
    data, mime = c.chat.photo(session, file_id)
    return Response(data, media_type=mime, headers={"Cache-Control": "private, max-age=86400"})


@router.patch("/messages/{msg_id}", summary="Исправить своё сообщение")
def edit(msg_id: int, body: ChatEditIn, c: ContainerDep, session: SessionDep) -> dict:
    return c.chat.edit(session, msg_id, body.text)


@router.delete("/messages/{msg_id}", summary="Удалить своё сообщение")
def remove(msg_id: int, c: ContainerDep, session: SessionDep) -> dict:
    return c.chat.remove(session, msg_id)


@router.get("/{channel}", summary="Сообщения канала (по 60, листать назад — before)")
def history(
    channel: str,
    c: ContainerDep,
    session: SessionDep,
    before: int | None = Query(None, ge=1),
    limit: int = Query(60, ge=1, le=200),
) -> list[dict]:
    return c.chat.history(session, channel, before, limit)


@router.post("/{channel}", summary="Написать в канал (можно ответом на сообщение)")
def post(channel: str, body: ChatIn, c: ContainerDep, session: SessionDep) -> dict:
    _limit(c, session)
    return c.chat.post(session, channel, body.text, body.reply_to)


@router.post("/{channel}/photo", summary="Отправить фото (снимок поломки) с подписью")
async def post_photo(
    channel: str,
    c: ContainerDep,
    session: SessionDep,
    file: UploadFile = File(...),
    text: str = Form("", max_length=1000),
    reply_to: int | None = Form(None),
    width: int | None = Form(None, ge=1, le=10000),
    height: int | None = Form(None, ge=1, le=10000),
) -> dict:
    _limit(c, session)
    data = await file.read(MAX_PHOTO + 1)
    if len(data) > MAX_PHOTO:
        raise ValidationFailed("Фото больше 6 МБ")
    mime = next((m for sig, m in MAGIC.items() if data.startswith(sig)), None)
    if mime is None or (mime == "image/webp" and data[8:12] != b"WEBP"):
        raise ValidationFailed("Можно отправить только фото: JPEG, PNG или WebP")
    photo = {"data": data, "mime": mime, "width": width, "height": height}
    return c.chat.post(session, channel, text, reply_to, photo)


@router.post("/{channel}/read", summary="Отметить прочитанным")
def read(channel: str, body: ChatReadIn, c: ContainerDep, session: SessionDep) -> dict:
    return c.chat.read(session, channel, body.last_id)
