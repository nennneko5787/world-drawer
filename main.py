"""The world drawer - entrypoint (配線のみ。実体は app/ 配下)。

- app/routes/: ページ・REST API
- app/services/: データベース・ユーザー・キャンバス・presence・Socket.IO
- app/objects/: 設定・Pydanticモデル
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
from collections.abc import AsyncIterator

import socketio
from fastapi import FastAPI
from starlette.middleware.gzip import GZipMiddleware

from app.routes import api, pages, staticfiles
from app.services import realtime, shared
from app.services.database import closeDb, getDb


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """起動時にDBを温め、終了時に後始末する。

    終了時の後始末をしないと aiosqlite のワーカースレッドが残留し、
    "Application shutdown complete" の後にプロセスが固まる。
    """
    await getDb()
    await shared.connect()
    yield
    with contextlib.suppress(Exception):
        await realtime.sio.shutdown()
    await shared.close()
    await closeDb()


fastapi = FastAPI(title="world-drawer", lifespan=lifespan)
# APIのJSON (視野取得などMB級) を圧縮。WS・静的配信には影響しない
fastapi.add_middleware(GZipMiddleware, minimum_size=1000)
fastapi.include_router(staticfiles.router)
fastapi.include_router(pages.router)
fastapi.include_router(api.router)

app = socketio.ASGIApp(realtime.sio, other_asgi_app=fastapi)


async def _wsStartup() -> None:
    await getDb()
    await shared.connect()


async def _wsShutdown() -> None:
    with contextlib.suppress(Exception):
        await realtime.sio.shutdown()
    await shared.close()
    await closeDb()


# 分離運用向け: WS専用とAPI+ページ。nginxで /socket.io/*→ws、/static/*→直配信、
# その他→api に振り分ける。単体・結合運用は app のまま
ws_app = socketio.ASGIApp(realtime.sio, on_startup=_wsStartup, on_shutdown=_wsShutdown)
api_app = fastapi

if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="world-drawer")
    parser.add_argument(
        "--migrate",
        action="store_true",
        help="DBマイグレーションのみ実行して終了 (本番デプロイ時は再起動前に実行)",
    )
    args = parser.parse_args()
    if args.migrate:
        import logging

        from app.services.database import runMigrations

        logging.basicConfig(level=logging.INFO, format="%(message)s")
        version = asyncio.run(runMigrations())
        logging.getLogger("world-drawer.migrate").info("migrations applied (version %d)", version)
    else:
        uvicorn.run(app, host="127.0.0.1", port=8000)
