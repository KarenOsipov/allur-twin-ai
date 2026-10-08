from __future__ import annotations

import hashlib
import re
from collections import OrderedDict
from dataclasses import dataclass

import httpx

from app.core.config import Settings
from app.core.text import ru

SYSTEM = (
    "Ты — аналитик цифрового двойника автомобильного завода «Аллюр» (Костанай). "
    "Отвечай по-русски, коротко и по делу: 2–6 предложений или короткий список с «• ». "
    "Используй только цифры из переданных данных, ничего не выдумывай. "
    "Если данных не хватает — так и скажи. В конце, если уместно, дай одно конкретное действие. "
    "Участки называй по-русски (сварка, окраска, сборка, контроль качества, склад комплектов, склад ГП) — "
    "служебные коды вроде PAINT или WELD не пиши. Оформление: без заголовков и таблиц, "
    "можно выделить главное **жирным**; десятичные числа — через запятую. "
    "Завод в Казахстане: все деньги — только в казахстанских тенге (₸), например «2,7 млн ₸» или «450 тыс ₸»; "
    "рубли, доллары и другие валюты не используй и не пересчитывай. "
    "Говори как сотрудник завода: не упоминай, что ты ИИ, языковая модель или программа, "
    "не называй модель и компанию-разработчика и не пиши дисклеймеров."
)
AREA_NAMES = {
    "WH_IN": "склад комплектов",
    "WELD": "сварка",
    "PAINT": "окраска",
    "ASSY": "сборка",
    "QC": "контроль качества",
    "WH_OUT": "склад ГП",
}
_CODE_IN_PARENS = re.compile(r"\s*\((?:" + "|".join(AREA_NAMES) + r")\)")
_CODE = re.compile(r"\b(" + "|".join(AREA_NAMES) + r")\b")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_RUB = re.compile(r"(?<=\d)(\s*(?:млн|млрд|тыс)\.?)?\s*(?:рубл(?:ей|я|ь)|руб\.?|₽|RUB\b|р\.)", re.IGNORECASE)


@dataclass(frozen=True)
class LlmReply:
    text: str
    model: str


def _area_name(m: re.Match[str]) -> str:
    name = AREA_NAMES[m.group(1)]
    before = m.string[: m.start()].rstrip(" *")
    return name[0].upper() + name[1:] if not before or before[-1] in ".!?\n•" else name


def clean(text: str) -> str:
    text = _THINK.sub("", text)
    text = _RUB.sub(lambda m: (m.group(1) or "") + " ₸", text)
    text = _CODE_IN_PARENS.sub("", text)
    text = _CODE.sub(_area_name, text)
    return ru(re.sub(r"\n{3,}", "\n\n", text).strip())


class LlmClient:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.settings = settings
        self.provider = settings.llm_provider_effective
        self._transport = transport
        self._cache: OrderedDict[str, LlmReply] = OrderedDict()

    @property
    def enabled(self) -> bool:
        return self.provider == "openrouter"

    @property
    def label(self) -> str:
        return "online" if self.enabled else "local"

    async def ask(self, question: str, context_json: str) -> LlmReply:
        key = hashlib.sha256(f"{self.provider}|{question.lower()}|{context_json}".encode()).hexdigest()
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        user = f"Данные завода (JSON):\n{context_json}\n\nВопрос: {question}"
        async with httpx.AsyncClient(timeout=self.settings.llm_timeout_s, transport=self._transport) as client:
            reply = await self._openrouter(client, user)
        if not reply.text:
            raise ValueError("пустой ответ модели")
        self._cache[key] = reply
        if len(self._cache) > 200:
            self._cache.popitem(last=False)
        return reply

    async def _openrouter(self, client: httpx.AsyncClient, user: str) -> LlmReply:
        secret = self.settings.openrouter_api_key
        assert secret is not None
        res = await client.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {secret.get_secret_value()}",
                "Content-Type": "application/json",
                "X-Title": "Allur digital twin",
            },
            json={
                "model": self.settings.openrouter_model,
                "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
                "max_tokens": 900,
                "temperature": 0.2,
            },
        )
        res.raise_for_status()
        data = res.json()
        choice = (data.get("choices") or [{}])[0]
        text = (choice.get("message") or {}).get("content") or ""
        return LlmReply(clean(text), data.get("model", self.settings.openrouter_model))
