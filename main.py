"""pixDraw - entrypoint (配線のみ。実体は app/ 配下)。

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
from app.services import database, realtime, shared
from app.services.database import closeDb


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """起動時にDBへ接続し、終了時に後始末する。"""
    await database.connect()
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
    await database.connect()
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
    parser.add_argument(
        "--copy-sqlite-to-pg",
        action="store_true",
        help="SQLiteファイルをPostgreSQLへ複写して終了"
        " (DATABASE_URL/databaseUrlがPostgreSQLの場合のみ)",
    )
    parser.add_argument(
        "--sqlite-file",
        default="",
        help="複写元のSQLiteファイル (既定は data/world.db)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="--copy-sqlite-to-pg時: 複写先に既存行があっても全消去して複写",
    )
    args = parser.parse_args()
    if args.migrate:
        import logging

        from app.services.database import runMigrations

        logging.basicConfig(level=logging.INFO, format="%(message)s")
        version = asyncio.run(runMigrations())
        logging.getLogger("world-drawer.migrate").info("migrations applied (version %d)", version)
    elif args.copy_sqlite_to_pg:
        import logging
        from pathlib import Path

        from app.services import config as cfg
        from app.services.database import copySqliteToPostgres

        logging.basicConfig(level=logging.INFO, format="%(message)s")
        src = args.sqlite_file.strip() or str(cfg.dbFile)
        if not Path(src).exists():
            msg = f"sqlite file not found: {src}"
            raise SystemExit(msg)

        async def _copy() -> dict[str, int]:
            await database.connect()
            try:
                return await copySqliteToPostgres(src, force=args.force)
            finally:
                await closeDb()

        result = asyncio.run(_copy())
        logging.getLogger("world-drawer.migrate").info("copied sqlite to postgres: %s", result)
    else:
        uvicorn.run(app, host="127.0.0.1", port=8000)
