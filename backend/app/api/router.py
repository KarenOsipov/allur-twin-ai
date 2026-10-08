from fastapi import APIRouter

from app.api.routes import (
    advice,
    analytics,
    assistant,
    auth,
    chat,
    data,
    documents,
    export,
    floor,
    incidents,
    journal,
    layouts,
    params,
    problems,
    sandbox,
    shifts,
    system,
    users,
)

api = APIRouter(prefix="/api/v1")
for module in (
    system,
    auth,
    users,
    floor,
    shifts,
    problems,
    sandbox,
    analytics,
    advice,
    params,
    incidents,
    journal,
    export,
    documents,
    layouts,
    data,
    assistant,
    chat,
):
    api.include_router(module.router)
