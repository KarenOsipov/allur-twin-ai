from __future__ import annotations

import re

_DECIMAL = re.compile(r"(?<![\d.])(\d+)\.(\d{1,2})(?=\*{0,2}\s?(?:%|п\.п\.|мин|авт|ч\b|млн|тыс|раза?\b|₸))")


def ru(text: str) -> str:
    return _DECIMAL.sub(r"\1,\2", text)
