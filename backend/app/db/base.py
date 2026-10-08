from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.db.models import Base


class Database:
    def __init__(self, url: str, *, remote: bool = False) -> None:
        is_sqlite = url.startswith("sqlite")
        if is_sqlite:
            args: dict = {"check_same_thread": False}
        elif remote:
            args = {"connect_timeout": 5, "prepare_threshold": None}
        else:
            args = {"connect_timeout": 10}
        self.engine: Engine = create_engine(
            url,
            connect_args=args,
            pool_pre_ping=not is_sqlite,
            pool_recycle=300 if remote else -1,
        )
        if is_sqlite:

            @event.listens_for(self.engine, "connect")
            def _pragmas(conn, _):
                cur = conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA synchronous=NORMAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.close()

        self._factory = sessionmaker(self.engine, expire_on_commit=False)

    def create_all(self) -> None:
        Base.metadata.create_all(self.engine)

    def drop_all(self) -> None:
        Base.metadata.drop_all(self.engine)

    @contextmanager
    def session(self) -> Iterator[Session]:
        s = self._factory()
        try:
            yield s
            s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()
