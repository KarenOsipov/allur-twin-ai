from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Callable
from typing import Any

log = logging.getLogger(__name__)


Filter = Callable[[str, Any], bool]


class EventBus:
    def __init__(self, queue_size: int = 200) -> None:
        self._subscribers: dict[asyncio.Queue[str], Filter | None] = {}
        self._queue_size = queue_size
        self._handlers: dict[str, list[Callable[[Any], None]]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def on(self, event: str, handler: Callable[[Any], None]) -> None:
        self._handlers.setdefault(event, []).append(handler)

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, accept: Filter | None = None) -> asyncio.Queue[str]:
        self._loop = asyncio.get_running_loop()
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers[q] = accept
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._subscribers.pop(q, None)

    @property
    def listeners(self) -> int:
        return len(self._subscribers)

    def publish(self, event: str, data: Any) -> None:
        for handler in self._handlers.get(event, ()):
            try:
                handler(data)
            except Exception:
                log.exception("Ошибка обработчика события %s", event)
        if not self._subscribers:
            return
        message = json.dumps(
            {"event": event, "data": data, "ts": time.time()},
            ensure_ascii=False,
            default=str,
        )
        targets = [q for q, accept in list(self._subscribers.items()) if accept is None or _safe(accept, event, data)]
        if not targets:
            return
        loop = self._loop
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if loop is None or running is loop:
            _deliver(targets, message)
        elif not loop.is_closed():
            loop.call_soon_threadsafe(_deliver, targets, message)


def _safe(accept: Filter, event: str, data: Any) -> bool:
    try:
        return accept(event, data)
    except Exception:
        log.exception("Ошибка фильтра события %s", event)
        return False


def _deliver(targets: list[asyncio.Queue[str]], message: str) -> None:
    for q in targets:
        if q.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                q.get_nowait()
        q.put_nowait(message)
