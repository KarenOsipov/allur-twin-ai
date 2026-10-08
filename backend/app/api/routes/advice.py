from __future__ import annotations

import asyncio

from fastapi import APIRouter, Query

from app.analytics.economy import economy
from app.api.deps import ContainerDep, ViewerDep

router = APIRouter(tags=["Рекомендации и экономика"])


@router.get("/advice", summary="Что сделать → что получим: действия, проверенные на модели линии")
async def advice(c: ContainerDep, _: ViewerDep, wait: bool = Query(False)) -> dict:
    if wait:
        return await asyncio.to_thread(c.advice.get, wait=True)
    return c.advice.get()


@router.get("/economics/plant", summary="Экономика производства: доход, затраты, потери и что даст их устранение")
def economics_plant(c: ContainerDep, _: ViewerDep, days: int = Query(30, ge=7, le=120)) -> dict:
    return economy(c.data.dataset(), c.plant, c.analytics.today(), c.economics.economics(), days)
