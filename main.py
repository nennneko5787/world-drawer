"""The world drawer - entrypoint (配線のみ。実体は app/ 配下)。

- app/routes/: ページ・REST API
- app/services/: データベース・ユーザー・キャンバス・presence・Socket.IO
- app/objects/: 設定・Pydanticモデル
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator

import socketio
from fastapi import FastAPI

from app.routes import api, pages, staticfiles
from app.services import realtime
from app.services.database import closeDb, getDb


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """起動時にDBを温め、終了時に後始末する。

    終了時の後始末をしないと aiosqlite のワーカースレッドが残留し、
    "Application shutdown complete" の後にプロセスが固まる。
    """
    await getDb()
    yield
    with contextlib.suppress(Exception):
        await realtime.sio.shutdown()
    await closeDb()


fastapi = FastAPI(title="world-drawer", lifespan=lifespan)
fastapi.include_router(staticfiles.router)
fastapi.include_router(pages.router)
fastapi.include_router(api.router)

app = socketio.ASGIApp(realtime.sio, other_asgi_app=fastapi)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
