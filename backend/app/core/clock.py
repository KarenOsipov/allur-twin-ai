from __future__ import annotations

from datetime import UTC, datetime, timedelta


def plant_now(tz_offset_min: int) -> datetime:
    return (datetime.now(UTC) + timedelta(minutes=tz_offset_min)).replace(tzinfo=None)
