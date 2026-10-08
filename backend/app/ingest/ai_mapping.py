from __future__ import annotations

import asyncio
import json
import logging
import re

import httpx

from app.assistant.llm import OPENROUTER_URL
from app.core.config import Settings
from app.ingest.smart import IMPORTABLE, KIND_TITLES, KINDS, ColumnProfile, Sheet

log = logging.getLogger(__name__)

PROMPT = (
    "Ты сопоставляешь колонки таблицы завода с полями базы. Типы данных:\n{kinds}\n"
    "Ответь ТОЛЬКО JSON без пояснений: "
    '{{"kind": "<тип или none>", "map": {{"<поле>": <номер колонки с 0 или null>}}}}.\n'
    "Лист «{title}». Колонки (номер: заголовок — примеры значений):\n{cols}"
)
TIMEOUT_S = 12.0


def _kinds_text() -> str:
    lines = []
    for k in IMPORTABLE:
        fields = ", ".join(f"{f.name} ({f.label}{', обяз.' if f.required else ''})" for f in KINDS[k])
        lines.append(f"- {k}: {KIND_TITLES[k]}; поля: {fields}")
    return "\n".join(lines)


def build_prompt(sheet: Sheet, cols: list[ColumnProfile]) -> str:
    rows = "\n".join(f"{c.index}: {c.name} — {', '.join(c.samples[:4]) or 'пусто'}" for c in cols[:40])
    return PROMPT.format(kinds=_kinds_text(), title=sheet.name[:60], cols=rows)


def parse_reply(text: str, n_cols: int) -> dict | None:
    m = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    kind = obj.get("kind")
    if kind not in IMPORTABLE:
        return None
    valid = {f.name for f in KINDS[kind]}
    mapping = {}
    for k, v in (obj.get("map") or {}).items():
        if k in valid and isinstance(v, int) and not isinstance(v, bool) and 0 <= v < n_cols:
            mapping[k] = v
    return {"kind": kind, "map": mapping} if mapping else None


async def _ask(settings: Settings, prompt: str, transport: httpx.AsyncBaseTransport | None) -> str:
    secret = settings.openrouter_api_key
    if secret is None:
        return ""
    async with httpx.AsyncClient(timeout=min(settings.llm_timeout_s, TIMEOUT_S), transport=transport) as client:
        res = await client.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {secret.get_secret_value()}",
                "Content-Type": "application/json",
                "X-Title": "Allur digital twin",
            },
            json={
                "model": settings.openrouter_model,
                "messages": [
                    {"role": "system", "content": "Ты помощник по разбору таблиц. Отвечай только валидным JSON."},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": 400,
                "temperature": 0,
            },
        )
        res.raise_for_status()
        data = res.json()
    choice = (data.get("choices") or [{}])[0]
    return (choice.get("message") or {}).get("content") or ""


async def suggest(
    settings: Settings,
    enabled: bool,
    sheets: list[Sheet],
    profiles: list[list[ColumnProfile]],
    indices: list[int],
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[dict[int, dict], str]:
    if not indices:
        return {}, ""
    if not enabled:
        return {}, "ИИ-подсказки выключены (нет ключа) — сопоставление выполнено по правилам"

    async def one(i: int) -> tuple[int, dict | None]:
        try:
            text = await asyncio.wait_for(_ask(settings, build_prompt(sheets[i], profiles[i]), transport), TIMEOUT_S)
        except Exception as e:
            log.info("ИИ-сопоставление листа %s не удалось: %s", i, e)
            return i, None
        return i, parse_reply(text, len(profiles[i]))

    results = await asyncio.gather(*(one(i) for i in indices[:6]))
    hints = {i: h for i, h in results if h}
    if hints:
        return hints, f"ИИ предложил сопоставление для листов: {len(hints)}"
    return {}, "ИИ не ответил вовремя — сопоставление выполнено по правилам"
