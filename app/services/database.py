"""SQLite接続管理・スキーマ・旧JSON取込。"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable

import aiosqlite

from app.services import config as cfg
from app.services import users

logger = logging.getLogger(__name__)

db: aiosqlite.Connection | None = None
dbLoop: asyncio.AbstractEventLoop | None = None
dbLock = asyncio.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS pixels(
  x INTEGER NOT NULL, y INTEGER NOT NULL,
  c TEXT NOT NULL, t TEXT NOT NULL DEFAULT 'normal', by TEXT,
  PRIMARY KEY (x, y));
CREATE INDEX IF NOT EXISTS idx_pixels_xy ON pixels(x, y);
CREATE TABLE IF NOT EXISTS users(
  token TEXT PRIMARY KEY, uid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, color TEXT NOT NULL,
  inventory TEXT NOT NULL DEFAULT '{}',
  cooldownUntil REAL NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0,
  transferCode TEXT UNIQUE, passwordHash TEXT, country TEXT,
  showCountry INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x INTEGER NOT NULL, y INTEGER NOT NULL,
  uid TEXT NOT NULL, c TEXT NOT NULL, t TEXT NOT NULL,
  at REAL NOT NULL, undone INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0, rewardInk TEXT, rewardAmount INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_history_cell ON history(x, y, at);
"""


async def migrateColumnSchemas(db: aiosqlite.Connection) -> None:
    """後付けカラムの追加 (users.transferCode/passwordHash, pixels.by)。"""
    async with db.execute("PRAGMA table_info(users)") as cur:
        userCols = {row[1] for row in await cur.fetchall()}
    if "transferCode" not in userCols:
        await db.execute("ALTER TABLE users ADD COLUMN transferCode TEXT")
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_transferCode ON users(transferCode)"
        )
    if "passwordHash" not in userCols:
        await db.execute("ALTER TABLE users ADD COLUMN passwordHash TEXT")
    async with db.execute("PRAGMA table_info(pixels)") as cur:
        pixelCols = {row[1] for row in await cur.fetchall()}
    if "by" not in pixelCols:
        await db.execute("ALTER TABLE pixels ADD COLUMN by TEXT")
    await db.commit()


async def migrateHistorySchema(db: aiosqlite.Connection) -> None:
    """履歴はUIDのみ保持 (改名対応) + undone旗。旧スキーマは移行。"""
    async with db.execute("PRAGMA table_info(history)") as cur:
        cols = {row[1] for row in await cur.fetchall()}
    if "name" in cols:
        await db.executescript(
            "CREATE TABLE history_new("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " x INTEGER NOT NULL, y INTEGER NOT NULL,"
            " uid TEXT NOT NULL, c TEXT NOT NULL, t TEXT NOT NULL,"
            " at REAL NOT NULL, undone INTEGER NOT NULL DEFAULT 0);"
            " INSERT INTO history_new(id, x, y, uid, c, t, at, undone)"
            " SELECT id, x, y, uid, c, t, at, 0 FROM history;"
            " DROP TABLE history;"
            " ALTER TABLE history_new RENAME TO history;"
            " CREATE INDEX IF NOT EXISTS idx_history_cell ON history(x, y, at);"
        )
        await db.commit()
    elif "undone" not in cols:
        await db.execute("ALTER TABLE history ADD COLUMN undone INTEGER NOT NULL DEFAULT 0")
        await db.commit()


async def migrateV1LegacyShapes(db: aiosqlite.Connection) -> None:
    """v1: バージョン管理前のDBを現行形状へ (自己検出・冪等)。"""
    await migrateColumnSchemas(db)
    await migrateHistorySchema(db)


async def migrateV2UndoRefundColumns(db: aiosqlite.Connection) -> None:
    """v2: 取り消し時の巻き戻し用に履歴へ付与記録列を追加 (既存行は0扱い)。"""
    async with db.execute("PRAGMA table_info(history)") as cur:
        cols = {row[1] for row in await cur.fetchall()}
    if "xp" not in cols:
        await db.execute("ALTER TABLE history ADD COLUMN xp INTEGER NOT NULL DEFAULT 0")
    if "rewardInk" not in cols:
        await db.execute("ALTER TABLE history ADD COLUMN rewardInk TEXT")
    if "rewardAmount" not in cols:
        await db.execute("ALTER TABLE history ADD COLUMN rewardAmount INTEGER NOT NULL DEFAULT 0")
    await db.commit()


async def migrateV3AddCountry(db: aiosqlite.Connection) -> None:
    """v3: 国旗表示用の country 列を追加 (NULL=非表示)。"""
    async with db.execute("PRAGMA table_info(users)") as cur:
        cols = {row[1] for row in await cur.fetchall()}
    if "country" not in cols:
        await db.execute("ALTER TABLE users ADD COLUMN country TEXT")
    await db.commit()


async def migrateV4AddShowCountry(db: aiosqlite.Connection) -> None:
    """v4: 国旗の表示切替 showCountry 列を追加 (既定表示)。"""
    async with db.execute("PRAGMA table_info(users)") as cur:
        cols = {row[1] for row in await cur.fetchall()}
    if "showCountry" not in cols:
        await db.execute("ALTER TABLE users ADD COLUMN showCountry INTEGER NOT NULL DEFAULT 1")
    await db.commit()


Migration = tuple[int, str, Callable[[aiosqlite.Connection], Awaitable[None]]]
MIGRATIONS: list[Migration] = [
    (1, "legacy_shapes", migrateV1LegacyShapes),
    (2, "undo_refund_columns", migrateV2UndoRefundColumns),
    (3, "add_country", migrateV3AddCountry),
    (4, "add_show_country", migrateV4AddShowCountry),
    # 追加時はここへ (番号は単調増加・各ステップは冪等にすること):
    # (4, "add_xxx", migrateV4AddXxx),
]


async def currentVersion(db: aiosqlite.Connection) -> int:
    async with db.execute("PRAGMA user_version") as cur:
        row = await cur.fetchone()
    return int(row[0]) if row else 0


async def migrate(db: aiosqlite.Connection) -> None:
    """未適用のマイグレーションを順に適用。Alembicの代わりの軽量実装。"""
    version = await currentVersion(db)
    for target, name, fn in MIGRATIONS:
        if target <= version:
            continue
        await fn(db)
        await db.execute(f"PRAGMA user_version = {target}")
        await db.commit()
        logger.info("migrated to version %d (%s)", target, name)


async def getDb() -> aiosqlite.Connection:
    """共有コネクションを返す (初回はスキーマ作成+移行+旧JSON取込)。"""
    global db, dbLoop  # noqa: PLW0603
    loop = asyncio.get_running_loop()
    async with dbLock:
        if db is None or dbLoop is not loop:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.close()
                db = None
            cfg.dataDir.mkdir(exist_ok=True)
            db = await aiosqlite.connect(str(cfg.dbFile))
            await db.execute("PRAGMA journal_mode=WAL;")
            await db.execute("PRAGMA synchronous=NORMAL;")
            await db.execute("PRAGMA busy_timeout=5000;")
            await db.executescript(SCHEMA)
            await db.commit()
            await migrate(db)
            await importLegacyJson(db)
            dbLoop = loop
    return db


def parseLegacyKey(key: object) -> tuple[int, int] | None:
    if not isinstance(key, str):
        return None
    try:
        xs, ys = key.split(",")
        return int(xs), int(ys)
    except ValueError:
        return None


def parseLegacyPixel(key: object, val: object) -> tuple[int, int, str, str, str | None] | None:
    coords = parseLegacyKey(key)
    if coords is None:
        return None
    if not isinstance(val, dict) or not isinstance(val.get("c"), str):
        return None
    inkType = str(val.get("t", "normal"))
    if inkType == "gold":
        inkType = "ghost"
    by = val.get("by")
    x, y = coords
    return (x, y, val["c"], inkType, by if isinstance(by, str) else None)


def parseLegacyUser(tok: object, val: object, usedUids: set[str]) -> tuple | None:
    if not isinstance(tok, str) or not tok or not isinstance(val, dict):
        return None
    inv = users.parseInventory(json.dumps(val.get("inventory", {})))
    if isinstance(val.get("inventory"), dict):
        with contextlib.suppress(TypeError, ValueError):
            inv["ghost"] += max(0, int(val["inventory"].get("gold", 0)))
    uid = val.get("uid")
    if not isinstance(uid, str) or not uid or uid in usedUids:
        uid = users.genUid(usedUids)
    usedUids.add(uid)
    try:
        level = max(1, int(val.get("level", 1)))
    except (TypeError, ValueError):
        level = 1
    try:
        xp = max(0, int(val.get("xp", 0)))
    except (TypeError, ValueError):
        xp = 0
    try:
        cooldownUntil = float(val.get("cooldownUntil", 0.0))
    except (TypeError, ValueError):
        cooldownUntil = 0.0
    return (
        tok[:64],
        uid,
        users.cleanName(str(val.get("name", "ななし"))),
        users.cleanColor(str(val.get("color", "")), "#22aa66"),
        json.dumps(inv, ensure_ascii=False),
        cooldownUntil,
        level,
        xp,
    )


def parseLegacyHistoryCell(
    key: object, cell: object, out: list[tuple[int, int, str, str, str, float]]
) -> None:
    coords = parseLegacyKey(key)
    if coords is None or not isinstance(cell, list):
        return
    x, y = coords
    for item in cell[-cfg.maxHistoryPerCell :]:
        if not isinstance(item, dict):
            continue
        try:
            at = float(item.get("at", 0.0))
        except (TypeError, ValueError):
            continue
        out.append(
            (
                x,
                y,
                str(item.get("uid", "?")),
                str(item.get("c", "#000000")),
                str(item.get("t", "normal")),
                at,
            )
        )


async def importLegacyPixels(db: aiosqlite.Connection) -> int:
    if not cfg.canvasFile.exists():
        return 0
    try:
        data = json.loads(cfg.canvasFile.read_text(encoding="utf-8"))
    except Exception as err:
        logger.warning("legacy import failed: %s", err)
        return 0
    rawPixels = data.get("pixels", {}) if isinstance(data, dict) else {}
    rows = []
    if isinstance(rawPixels, dict):
        for key, val in rawPixels.items():
            parsed = parseLegacyPixel(key, val)
            if parsed is not None:
                rows.append(parsed)
    if rows:
        await db.executemany(
            "INSERT OR IGNORE INTO pixels(x, y, c, t, by) VALUES (?, ?, ?, ?, ?)",
            rows,
        )
    return len(rows)


async def importLegacyUsers(db: aiosqlite.Connection) -> int:
    if not cfg.usersFile.exists():
        return 0
    try:
        data = json.loads(cfg.usersFile.read_text(encoding="utf-8"))
    except Exception as err:
        logger.warning("legacy import failed: %s", err)
        return 0
    rawUsers = data.get("users", {}) if isinstance(data, dict) else {}
    if not isinstance(rawUsers, dict):
        return 0
    usedUids: set[str] = set()
    async with db.execute("SELECT uid FROM users") as cur:
        async for r in cur:
            usedUids.add(r[0])
    count = 0
    for tok, val in rawUsers.items():
        parsed = parseLegacyUser(tok, val, usedUids)
        if parsed is None:
            continue
        await db.execute(
            "INSERT OR IGNORE INTO users("
            "token, uid, name, color, inventory, cooldownUntil, level, xp)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            parsed,
        )
        count += 1
    return count


async def importLegacyHistory(db: aiosqlite.Connection) -> int:
    if not cfg.historyFile.exists():
        return 0
    try:
        data = json.loads(cfg.historyFile.read_text(encoding="utf-8"))
    except Exception as err:
        logger.warning("legacy import failed: %s", err)
        return 0
    rawHistory = data.get("history", {}) if isinstance(data, dict) else {}
    rows: list[tuple[int, int, str, str, str, float]] = []
    if isinstance(rawHistory, dict):
        for key, cell in rawHistory.items():
            parseLegacyHistoryCell(key, cell, rows)
    if rows:
        await db.executemany(
            "INSERT INTO history(x, y, uid, c, t, at) VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
    return len(rows)


async def importLegacyJson(db: aiosqlite.Connection) -> None:
    """旧JSONがあれば初回のみ取込む (多重取込防止はmeta旗)。"""
    async with db.execute("SELECT value FROM meta WHERE key = 'imported'") as cur:
        row = await cur.fetchone()
    if row and row[0] == "1":
        return
    pixelCount = await importLegacyPixels(db)
    userCount = await importLegacyUsers(db)
    historyCount = await importLegacyHistory(db)
    await db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('imported', '1')")
    await db.commit()
    if pixelCount or userCount or historyCount:
        logger.info(
            "imported legacy json: pixels=%d users=%d history=%d",
            pixelCount,
            userCount,
            historyCount,
        )
