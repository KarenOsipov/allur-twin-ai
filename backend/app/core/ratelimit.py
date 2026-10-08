from __future__ import annotations

import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, attempts: int, window_s: float) -> None:
        self.attempts = attempts
        self.window_s = window_s
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _trim(self, key: str, now: float) -> deque[float]:
        hits = self._hits[key]
        while hits and now - hits[0] > self.window_s:
            hits.popleft()
        return hits

    def blocked_for(self, key: str) -> float:
        now = time.monotonic()
        hits = self._trim(key, now)
        if len(hits) < self.attempts:
            return 0.0
        return max(0.0, self.window_s - (now - hits[0]))

    def hit(self, key: str) -> None:
        self._hits[key].append(time.monotonic())

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)
