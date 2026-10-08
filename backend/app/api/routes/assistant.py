from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import ContainerDep, ScopeDep, ViewerDep
from app.core.errors import TooManyRequestsError
from app.schemas.requests import AskIn

router = APIRouter(prefix="/assistant", tags=["ИИ-ассистент"])


@router.post("", summary="Задать вопрос о заводе")
async def ask(body: AskIn, c: ContainerDep, session: ViewerDep, scope: ScopeDep) -> dict:
    _limit(c, session)
    answer = await scope.assistant.ask(body.question)
    c.audit.log(
        "assistant",
        "ask",
        f"Вопрос: {body.question[:160]}",
        actor=session.name,
        details={"Тема": answer.topic, "Режим": "симуляция" if scope.sandbox else "живой завод"},
    )
    return answer.as_dict()


@router.post("/report", summary="Сводный разбор для страницы ИИ-анализа")
async def report(c: ContainerDep, session: ViewerDep, scope: ScopeDep) -> dict:
    _limit(c, session)
    answer = await scope.assistant.report()
    return answer.as_dict()


def _limit(c, session) -> None:
    key = f"ask:{session.user_id}"
    if c.assistant_limiter.blocked_for(key) > 0:
        c.audit.log(
            "assistant",
            "limit",
            "Слишком много вопросов подряд — ассистент ограничил частоту",
            actor=session.name,
            severity="warning",
        )
        raise TooManyRequestsError("Слишком много вопросов подряд. Подождите минуту.")
    c.assistant_limiter.hit(key)


@router.get("/suggestions", summary="Примеры вопросов")
def suggestions(scope: ScopeDep) -> list[str]:
    if scope.sandbox:
        return [
            "Что будет из-за этой поломки?",
            "Успеем ли выполнить план смены?",
            "Что сделать, чтобы потерять меньше?",
            "Где теперь узкое место?",
            "Как это скажется на плане месяца?",
        ]
    return [
        "Что происходит в цеху сейчас?",
        "Выполним ли план месяца?",
        "Почему растёт брак окраски?",
        "Что с Конвейером-03?",
        "Где узкое место?",
        "Что сделать в первую очередь?",
        "Почему вчера недовыпустили?",
    ]
