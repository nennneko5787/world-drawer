"""SQLite/PostgreSQL両対応の接続管理・スキーマ・旧JSON取込。

- databaseUrl (空ならSQLite。環境変数 DATABASE_URL があればそちらが優先) が
  postgresql://... ならPostgreSQL、空なら従来どおり SQLite (data/world.db)。
- 呼び出し側は `?` プレースホルダで統一する。PostgreSQL時は $1.. に変換する。
- 書き込みは `async with tx() as t:` で行う。抜け時に自動確定し、例外時は
  ロールバックされる (従来のBEGIN後のROLLBACK漏れを構造的に防止)。
- 単発の読み書きは fetchOne/fetchAll/execute/executeMany を使う。
  SQLite時は都度接続を開閉するため、共有コネクションへの割り込みは起きない。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import random
import sqlite3
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Any

import aiosqlite

try:
    import asyncpg

    _HAS_ASYNCPG = True
except ImportError:
    asyncpg = None  # type: ignore[assignment]
    _HAS_ASYNCPG = False

from app.services import config as cfg
from app.services import users

logger = logging.getLogger(__name__)

BACKEND: str = "sqlite"
_pgPool: Any = None
_sqliteWriteLock = asyncio.Lock()

SCHEMA_VERSION_KEY = "schema_version"
LATEST_VERSION = 9

SCHEMA_SQLITE = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS pixels(
  x INTEGER NOT NULL, y INTEGER NOT NULL,
  c TEXT NOT NULL, t TEXT NOT NULL DEFAULT 'normal', by TEXT,
  coats INTEGER NOT NULL DEFAULT 1,
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

# 新規PostgreSQLは最終形を直接作る (SQLite移行ステップの再演は不要)。
_PG_SCHEMA_STMTS = [
    "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)",
    "CREATE TABLE IF NOT EXISTS pixels("
    " x INTEGER NOT NULL, y INTEGER NOT NULL,"
    " c TEXT NOT NULL, t TEXT NOT NULL DEFAULT 'normal', by TEXT,"
    " coats INTEGER NOT NULL DEFAULT 1,"
    " shieldUntil DOUBLE PRECISION NOT NULL DEFAULT 0,"
    " chalkUntil DOUBLE PRECISION NOT NULL DEFAULT 0,"
    " PRIMARY KEY (x, y))",
    "CREATE INDEX IF NOT EXISTS idx_pixels_box"
    " ON pixels(x, y, c, t, by, coats, shieldUntil, chalkUntil)",
    "CREATE INDEX IF NOT EXISTS idx_pixels_by ON pixels(by)",
    "CREATE TABLE IF NOT EXISTS users("
    " token TEXT PRIMARY KEY, uid TEXT NOT NULL UNIQUE,"
    " name TEXT NOT NULL, color TEXT NOT NULL,"
    " inventory TEXT NOT NULL DEFAULT '{}',"
    " cooldownUntil DOUBLE PRECISION NOT NULL DEFAULT 0,"
    " level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0,"
    " transferCode TEXT UNIQUE, passwordHash TEXT, country TEXT,"
    " showCountry INTEGER NOT NULL DEFAULT 1)",
    "CREATE TABLE IF NOT EXISTS history("
    " id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,"
    " x INTEGER NOT NULL, y INTEGER NOT NULL,"
    " uid TEXT NOT NULL, c TEXT NOT NULL, t TEXT NOT NULL,"
    " at DOUBLE PRECISION NOT NULL, undone INTEGER NOT NULL DEFAULT 0,"
    " xp INTEGER NOT NULL DEFAULT 0, rewardInk TEXT,"
    " rewardAmount INTEGER NOT NULL DEFAULT 0)",
    "CREATE INDEX IF NOT EXISTS idx_history_cell ON history(x, y, at)",
    "CREATE INDEX IF NOT EXISTS idx_history_uid ON history(uid)",
]


def resolveDsn() -> str:
    """環境変数 DATABASE_URL 優先、なければ config の databaseUrl。"""
    env = os.environ.get("DATABASE_URL", "").strip()
    if env:
        return env
    return (cfg.databaseUrl or "").strip()


def isPostgresDsn(dsn: str) -> bool:
    return dsn.startswith(("postgres://", "postgresql://"))


def isPostgres() -> bool:
    return BACKEND == "postgres"


def toPg(sql: str) -> str:
    """`?` を $1.. に変換 (文字列リテラル内は保持)。"""
    out: list[str] = []
    num = 0
    inStr = False
    idx = 0
    while idx < len(sql):
        ch = sql[idx]
        if inStr:
            out.append(ch)
            if ch == "'":
                if idx + 1 < len(sql) and sql[idx + 1] == "'":
                    out.append("'")
                    idx += 1
                else:
                    inStr = False
        elif ch == "'":
            inStr = True
            out.append(ch)
        elif ch == "?":
            num += 1
            out.append(f"${num}")
        else:
            out.append(ch)
        idx += 1
    return "".join(out)


def pgRowcount(status: str) -> int:
    try:
        return max(0, int(status.strip().split()[-1]))
    except (ValueError, IndexError):
        return 0


class SqliteTx:
    """SQLiteトランザクション内の操作。commit/rollbackは tx() が行う。"""

    def __init__(self, conn: aiosqlite.Connection) -> None:
        self._conn = conn

    async def fetchOne(self, sql: str, params: Sequence[Any] = ()) -> tuple[Any, ...] | None:
        async with self._conn.execute(sql, tuple(params)) as cur:
            row = await cur.fetchone()
            return tuple(row) if row is not None else None

    async def fetchAll(self, sql: str, params: Sequence[Any] = ()) -> list[tuple[Any, ...]]:
        async with self._conn.execute(sql, tuple(params)) as cur:
            return [tuple(r) for r in await cur.fetchall()]

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        async with self._conn.execute(sql, tuple(params)) as cur:
            return cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0

    async def executeMany(self, sql: str, seq: Sequence[Sequence[Any]]) -> None:
        rows = [tuple(r) for r in seq]
        if rows:
            await self._conn.executemany(sql, rows)


class PgTx:
    """PostgreSQLトランザクション内の操作。commit/rollbackは tx() が行う。"""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    async def fetchOne(self, sql: str, params: Sequence[Any] = ()) -> tuple[Any, ...] | None:
        row = await self._conn.fetchrow(toPg(sql), *params)
        return tuple(row) if row is not None else None

    async def fetchAll(self, sql: str, params: Sequence[Any] = ()) -> list[tuple[Any, ...]]:
        rows = await self._conn.fetch(toPg(sql), *params)
        return [tuple(r) for r in rows]

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        status = await self._conn.execute(toPg(sql), *params)
        return pgRowcount(status)

    async def executeMany(self, sql: str, seq: Sequence[Sequence[Any]]) -> None:
        rows = [tuple(r) for r in seq]
        if rows:
            await self._conn.executemany(toPg(sql), rows)


DbTx = SqliteTx | PgTx


async def _sqliteConnect() -> aiosqlite.Connection:
    cfg.dataDir.mkdir(exist_ok=True)
    conn = await aiosqlite.connect(str(cfg.dbFile), isolation_level=None)
    await conn.execute("PRAGMA journal_mode=WAL;")
    await conn.execute("PRAGMA synchronous=NORMAL;")
    await conn.execute("PRAGMA busy_timeout=30000;")
    return conn


def _pgPoolOrRaise() -> Any:
    if _pgPool is None:
        msg = "database not connected (call connect() first)"
        raise RuntimeError(msg)
    return _pgPool


async def fetchOne(sql: str, params: Sequence[Any] = ()) -> tuple[Any, ...] | None:
    """単発の読み取り (トランザクション不要時用)。"""
    if isPostgres():
        pool = _pgPoolOrRaise()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(toPg(sql), *params)
            return tuple(row) if row is not None else None
    conn = await _sqliteConnect()
    try:
        async with conn.execute(sql, tuple(params)) as cur:
            row = await cur.fetchone()
            return tuple(row) if row is not None else None
    finally:
        with contextlib.suppress(Exception):
            await conn.close()


async def fetchAll(sql: str, params: Sequence[Any] = ()) -> list[tuple[Any, ...]]:
    """単発の複数行読み取り (トランザクション不要時用)。"""
    if isPostgres():
        pool = _pgPoolOrRaise()
        async with pool.acquire() as conn:
            rows = await conn.fetch(toPg(sql), *params)
            return [tuple(r) for r in rows]
    conn = await _sqliteConnect()
    try:
        async with conn.execute(sql, tuple(params)) as cur:
            return [tuple(r) for r in await cur.fetchall()]
    finally:
        with contextlib.suppress(Exception):
            await conn.close()


async def execute(sql: str, params: Sequence[Any] = ()) -> int:
    """単発の書き込み。戻り値は更新行数。"""
    if isPostgres():
        pool = _pgPoolOrRaise()
        async with pool.acquire() as conn:
            return pgRowcount(await conn.execute(toPg(sql), *params))
    conn = await _sqliteConnect()
    try:
        async with conn.execute(sql, tuple(params)) as cur:
            return cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0
    finally:
        with contextlib.suppress(Exception):
            await conn.close()


async def executeMany(sql: str, seq: Sequence[Sequence[Any]]) -> None:
    """単発の複数行書き込み。"""
    rows = [tuple(r) for r in seq]
    if not rows:
        return
    if isPostgres():
        pool = _pgPoolOrRaise()
        async with pool.acquire() as conn:
            await conn.executemany(toPg(sql), rows)
        return
    conn = await _sqliteConnect()
    try:
        await conn.executemany(sql, rows)
    finally:
        with contextlib.suppress(Exception):
            await conn.close()


@contextlib.asynccontextmanager
async def tx() -> AsyncIterator[DbTx]:
    """書き込みトランザクション。抜け時確定・例外時巻き戻し。

    SQLite時はプロセス内ライトロック+BEGIN IMMEDIATEで直列化する。
    PostgreSQL時はプール接続+トランザクション (行ロックは SELECT FOR UPDATE)。
    """
    if isPostgres():
        pool = _pgPoolOrRaise()
        async with pool.acquire() as conn, conn.transaction():
            yield PgTx(conn)
        return
    async with _sqliteWriteLock:
        conn = await _sqliteConnect()
        try:
            await conn.execute("BEGIN IMMEDIATE")
            yield SqliteTx(conn)
            await conn.commit()
        except BaseException:
            with contextlib.suppress(Exception):
                await conn.rollback()
            raise
        finally:
            with contextlib.suppress(Exception):
                await conn.close()


def isTransientError(err: BaseException) -> bool:
    """再試行すべき一過性エラーか (SQLiteのBUSY・PGの直列化失敗等)。"""
    msg = str(err).lower()
    if "database is locked" in msg or "database table is locked" in msg:
        return True
    if "database is busy" in msg:
        return True
    if not _HAS_ASYNCPG:
        return False
    assert asyncpg is not None  # noqa: S101 — 上の分岐で存在保証
    return isinstance(err, (asyncpg.SerializationError, asyncpg.DeadlockDetectedError))


def isUniqueViolation(err: BaseException) -> bool:
    """一意制約違反か (同時作成の競合検出用)。"""
    if isinstance(err, (aiosqlite.IntegrityError, sqlite3.IntegrityError)):
        return True
    if not _HAS_ASYNCPG:
        return False
    assert asyncpg is not None  # noqa: S101 — 上の分岐で存在保証
    return isinstance(err, asyncpg.UniqueViolationError)


async def withRetry[T](label: str, fn: Callable[[], Awaitable[T]], *, attempts: int = 3) -> T:
    """一過性DBエラー時のみ再試行する。業務エラー (PlaceError等) は即時送出。"""
    for attempt in range(attempts):
        try:
            return await fn()
        except Exception as err:  # 判定は isTransientError に委譲
            if not isTransientError(err) or attempt + 1 >= attempts:
                raise
            delay = 0.05 * (2**attempt)
            logger.warning(
                "%s: transient db error, retry %d/%d: %s", label, attempt + 1, attempts, err
            )
            await asyncio.sleep(delay + random.uniform(0, 0.02))  # noqa: S311
    msg = f"{label}: retry exhausted"
    raise RuntimeError(msg)


async def _sqliteVersion(t: SqliteTx) -> int:
    row = await t.fetchOne("PRAGMA user_version")
    return int(row[0]) if row else 0


async def currentVersion() -> int:
    if isPostgres():
        ver = await fetchOne("SELECT value FROM meta WHERE key = ?", (SCHEMA_VERSION_KEY,))
        try:
            return int(ver[0]) if ver else 0
        except (TypeError, ValueError):
            return 0
    conn = await _sqliteConnect()
    try:
        async with conn.execute("PRAGMA user_version") as cur:
            row = await cur.fetchone()
        return int(row[0]) if row else 0
    finally:
        with contextlib.suppress(Exception):
            await conn.close()


async def _columnNames(t: SqliteTx, table: str) -> set[str]:
    rows = await t.fetchAll(f"PRAGMA table_info({table})")
    return {str(r[1]) for r in rows}


async def migrateColumnSchemas(t: SqliteTx) -> None:
    """後付けカラムの追加 (users.transferCode/passwordHash, pixels.by)。"""
    userCols = await _columnNames(t, "users")
    if "transferCode" not in userCols:
        await t.execute("ALTER TABLE users ADD COLUMN transferCode TEXT")
        await t.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_transferCode ON users(transferCode)"
        )
    if "passwordHash" not in userCols:
        await t.execute("ALTER TABLE users ADD COLUMN passwordHash TEXT")
    pixelCols = await _columnNames(t, "pixels")
    if "by" not in pixelCols:
        await t.execute("ALTER TABLE pixels ADD COLUMN by TEXT")


async def migrateHistorySchema(t: SqliteTx) -> None:
    """履歴はUIDのみ保持 (改名対応) + undone旗。旧スキーマは移行。"""
    cols = await _columnNames(t, "history")
    if "name" in cols:
        await t.execute(
            "CREATE TABLE history_new("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " x INTEGER NOT NULL, y INTEGER NOT NULL,"
            " uid TEXT NOT NULL, c TEXT NOT NULL, t TEXT NOT NULL,"
            " at REAL NOT NULL, undone INTEGER NOT NULL DEFAULT 0)"
        )
        await t.execute(
            "INSERT INTO history_new(id, x, y, uid, c, t, at, undone)"
            " SELECT id, x, y, uid, c, t, at, 0 FROM history"
        )
        await t.execute("DROP TABLE history")
        await t.execute("ALTER TABLE history_new RENAME TO history")
        await t.execute("CREATE INDEX IF NOT EXISTS idx_history_cell ON history(x, y, at)")
    elif "undone" not in cols:
        await t.execute("ALTER TABLE history ADD COLUMN undone INTEGER NOT NULL DEFAULT 0")


async def migrateV1LegacyShapes(t: SqliteTx) -> None:
    """v1: バージョン管理前のDBを現行形状へ (自己検出・冪等)。"""
    await migrateColumnSchemas(t)
    await migrateHistorySchema(t)


async def migrateV2UndoRefundColumns(t: SqliteTx) -> None:
    """v2: 取り消し時の巻き戻し用に履歴へ付与記録列を追加 (既存行は0扱い)。"""
    cols = await _columnNames(t, "history")
    if "xp" not in cols:
        await t.execute("ALTER TABLE history ADD COLUMN xp INTEGER NOT NULL DEFAULT 0")
    if "rewardInk" not in cols:
        await t.execute("ALTER TABLE history ADD COLUMN rewardInk TEXT")
    if "rewardAmount" not in cols:
        await t.execute("ALTER TABLE history ADD COLUMN rewardAmount INTEGER NOT NULL DEFAULT 0")


async def migrateV3AddCountry(t: SqliteTx) -> None:
    """v3: 国旗表示用の country 列を追加 (NULL=非表示)。"""
    if "country" not in await _columnNames(t, "users"):
        await t.execute("ALTER TABLE users ADD COLUMN country TEXT")


async def migrateV4AddShowCountry(t: SqliteTx) -> None:
    """v4: 国旗の表示切替 showCountry 列を追加 (既定表示)。"""
    if "showCountry" not in await _columnNames(t, "users"):
        await t.execute("ALTER TABLE users ADD COLUMN showCountry INTEGER NOT NULL DEFAULT 1")


async def migrateV5AddCoats(t: SqliteTx) -> None:
    """v5: ゴーストの重ね塗り段数 coats 列を追加 (既定1=従来どおり半透明)。"""
    if "coats" not in await _columnNames(t, "pixels"):
        await t.execute("ALTER TABLE pixels ADD COLUMN coats INTEGER NOT NULL DEFAULT 1")


async def migrateV6AddShield(t: SqliteTx) -> None:
    """v6: シールドの保護期限 shieldUntil 列を追加 (既定0=無保護)。"""
    if "shieldUntil" not in await _columnNames(t, "pixels"):
        await t.execute("ALTER TABLE pixels ADD COLUMN shieldUntil REAL NOT NULL DEFAULT 0")


async def migrateV7AddChalk(t: SqliteTx) -> None:
    """v7: チョークの消滅期限 chalkUntil 列を追加 (既定0=永続)。"""
    if "chalkUntil" not in await _columnNames(t, "pixels"):
        await t.execute("ALTER TABLE pixels ADD COLUMN chalkUntil REAL NOT NULL DEFAULT 0")


async def migrateV8BoxIndex(t: SqliteTx) -> None:
    """v8: 視野取得を index-only scan 化 (数倍速)。旧 idx は主キーと重なるため置換。"""
    await t.execute("DROP INDEX IF EXISTS idx_pixels_xy")
    await t.execute(
        "CREATE INDEX IF NOT EXISTS idx_pixels_box"
        " ON pixels(x, y, c, t, by, coats, shieldUntil, chalkUntil)"
    )


async def migrateV9AddMissingIndexes(t: SqliteTx) -> None:
    """v9: 巻き戻し・統合用の不足indexを追加 (history.uid, pixels.by)。

    無いと rollback/merge が全表走査になり、13MB級でも書き込みを塞ぐ。
    """
    await t.execute("CREATE INDEX IF NOT EXISTS idx_history_uid ON history(uid)")
    await t.execute("CREATE INDEX IF NOT EXISTS idx_pixels_by ON pixels(by)")


Migration = tuple[int, str, Callable[[SqliteTx], Awaitable[None]]]
MIGRATIONS: list[Migration] = [
    (1, "legacy_shapes", migrateV1LegacyShapes),
    (2, "undo_refund_columns", migrateV2UndoRefundColumns),
    (3, "add_country", migrateV3AddCountry),
    (4, "add_show_country", migrateV4AddShowCountry),
    (5, "add_coats", migrateV5AddCoats),
    (6, "add_shield", migrateV6AddShield),
    (7, "add_chalk", migrateV7AddChalk),
    (8, "box_index", migrateV8BoxIndex),
    (9, "missing_indexes", migrateV9AddMissingIndexes),
]


_MIGRATE_RETRY_WAIT = (0.0, 2.0, 5.0, 10.0, 20.0, 30.0, 30.0, 30.0, 30.0)


async def _runSqliteMigrations(t: SqliteTx) -> None:
    """未適用のマイグレーションを順に適用。Alembicの代わりの軽量実装。"""
    version = await _sqliteVersion(t)
    for target, name, fn in MIGRATIONS:
        if target <= version:
            continue
        await fn(t)
        await t.execute(f"PRAGMA user_version = {target}")
        logger.info("migrated to version %d (%s)", target, name)


async def _connectPostgres(dsn: str) -> str:
    """PostgreSQLプール確立+最終形スキーマの冪等作成。"""
    global _pgPool  # noqa: PLW0603 — 共有接続管理のため
    if not _HAS_ASYNCPG:
        msg = "databaseUrl is postgresql but asyncpg is not installed (run uv sync)"
        raise RuntimeError(msg)
    assert asyncpg is not None  # noqa: S101 — 上の分岐で存在保証
    if _pgPool is None:
        _pgPool = await asyncpg.create_pool(
            dsn, min_size=1, max_size=max(1, cfg.dbPoolSize), command_timeout=60
        )
    pool = _pgPoolOrRaise()
    async with pool.acquire() as conn:
        for stmt in _PG_SCHEMA_STMTS:
            await conn.execute(stmt)
        await conn.execute(
            "INSERT INTO meta(key, value) VALUES ('schema_version', $1)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            str(LATEST_VERSION),
        )
    logger.info("database backend: postgres")
    return "postgres"


async def _connectSqliteOnce() -> None:
    """SQLiteのスキーマ作成+移行+旧JSON取込を1回試す。BUSY時は送出して再試行させる。"""
    async with tx() as t:
        assert isinstance(t, SqliteTx)  # noqa: S101 — sqlite分岐のため
        for stmt in SCHEMA_SQLITE.strip().split(";"):
            if stmt.strip():
                await t.execute(stmt)
        await _runSqliteMigrations(t)
        await importLegacyJson(t)


async def connect() -> str:
    """起動時の接続確立+移行。戻り値は backend ("sqlite"/"postgres")。

    SQLite時はWAL設定・移行・旧JSON取込まで行う (BUSY再試行付き)。
    PostgreSQL時は最終形スキーマを冪等作成する。
    """
    global BACKEND  # noqa: PLW0603 — 共有接続管理のため
    dsn = resolveDsn()
    if isPostgresDsn(dsn):
        BACKEND = await _connectPostgres(dsn)
        return BACKEND
    BACKEND = "sqlite"
    for attempt, waitSec in enumerate(_MIGRATE_RETRY_WAIT):
        if waitSec > 0:
            logger.warning("migration busy, retrying in %.0fs (attempt %d)", waitSec, attempt + 1)
            await asyncio.sleep(waitSec)
        try:
            await _connectSqliteOnce()
        except aiosqlite.OperationalError as err:
            if not isTransientError(err):
                raise
            continue
        break
    else:
        msg = "migration still locked after retries"
        raise aiosqlite.OperationalError(msg)
    logger.info("database backend: sqlite (%s)", cfg.dbFile)
    return BACKEND


async def closeDb() -> None:
    """プールを閉じる。SQLite時は都度接続のため何もしない。"""
    global _pgPool  # noqa: PLW0603 — 共有接続管理のため
    if _pgPool is not None:
        with contextlib.suppress(Exception):
            await _pgPool.close()
        _pgPool = None


async def runMigrations() -> int:
    """分離実行用マイグレーション (`python main.py --migrate`)。

    本番デプロイ時はワーカー起動前にこれだけ先に実行する
    (停止 → pull → sync → migrate → 起動)。適用後バージョンを返す。
    起動時の自動移行はフォールバックとして残る。
    """
    await connect()
    version = await currentVersion()
    await closeDb()
    return version


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


async def importLegacyPixels(t: DbTx) -> int:
    if not cfg.canvasFile.exists():
        return 0
    try:
        data = json.loads(cfg.canvasFile.read_text(encoding="utf-8"))
    except Exception as err:  # 旧JSONの破損は警告のみで続行
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
        await t.executeMany(
            "INSERT INTO pixels(x, y, c, t, by) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(x, y) DO NOTHING",
            rows,
        )
    return len(rows)


async def importLegacyUsers(t: DbTx) -> int:
    if not cfg.usersFile.exists():
        return 0
    try:
        data = json.loads(cfg.usersFile.read_text(encoding="utf-8"))
    except Exception as err:  # 旧JSONの破損は警告のみで続行
        logger.warning("legacy import failed: %s", err)
        return 0
    rawUsers = data.get("users", {}) if isinstance(data, dict) else {}
    if not isinstance(rawUsers, dict):
        return 0
    usedUids: set[str] = set()
    for r in await t.fetchAll("SELECT uid FROM users"):
        usedUids.add(str(r[0]))
    count = 0
    for tok, val in rawUsers.items():
        parsed = parseLegacyUser(tok, val, usedUids)
        if parsed is None:
            continue
        await t.execute(
            "INSERT INTO users("
            "token, uid, name, color, inventory, cooldownUntil, level, xp)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
            parsed,
        )
        count += 1
    return count


async def importLegacyHistory(t: DbTx) -> int:
    if not cfg.historyFile.exists():
        return 0
    try:
        data = json.loads(cfg.historyFile.read_text(encoding="utf-8"))
    except Exception as err:  # 旧JSONの破損は警告のみで続行
        logger.warning("legacy import failed: %s", err)
        return 0
    rawHistory = data.get("history", {}) if isinstance(data, dict) else {}
    rows: list[tuple[int, int, str, str, str, float]] = []
    if isinstance(rawHistory, dict):
        for key, cell in rawHistory.items():
            parseLegacyHistoryCell(key, cell, rows)
    if rows:
        await t.executeMany(
            "INSERT INTO history(x, y, uid, c, t, at) VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
    return len(rows)


async def importLegacyJson(t: DbTx) -> None:
    """旧JSONがあれば初回のみ取込む (多重取込防止はmeta旗)。SQLite時のみ呼ぶ。"""
    row = await t.fetchOne("SELECT value FROM meta WHERE key = 'imported'")
    if row and row[0] == "1":
        return
    pixelCount = await importLegacyPixels(t)
    userCount = await importLegacyUsers(t)
    historyCount = await importLegacyHistory(t)
    await t.execute(
        "INSERT INTO meta(key, value) VALUES ('imported', '1')"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    if pixelCount or userCount or historyCount:
        logger.info(
            "imported legacy json: pixels=%d users=%d history=%d",
            pixelCount,
            userCount,
            historyCount,
        )


async def copySqliteToPostgres(sqliteFile: str, *, force: bool = False) -> dict[str, int]:
    """SQLiteファイルをPostgreSQLへ複写する (移行用)。

    事前にPostgreSQLへ connect() 済みであること。history.id は振り直されるが
    id順に挿入するため新旧の順序は保たれる。targetに既存行があれば中断する
    (force=Trueで全消去してから複写)。
    """
    if not isPostgres():
        msg = "copySqliteToPostgres requires postgresql backend (set DATABASE_URL)"
        raise RuntimeError(msg)
    async with tx() as t:
        counts = {}
        for table in ("users", "pixels", "history"):
            # テーブル名は上の固定リテラルのみ (外部入力は使わない)
            row = await t.fetchOne(f"SELECT COUNT(*) FROM {table}")  # noqa: S608
            counts[table] = int(row[0]) if row else 0
        if any(counts.values()) and not force:
            msg = f"target tables not empty: {counts} (use --force to overwrite)"
            raise RuntimeError(msg)
        if force and any(counts.values()):
            await t.execute("TRUNCATE history, pixels, users")
            logger.info("truncated target tables (force)")
    src = sqlite3.connect(sqliteFile)
    try:
        src.row_factory = sqlite3.Row
        userRows = src.execute(
            "SELECT token, uid, name, color, inventory, cooldownUntil, level, xp,"
            " transferCode, passwordHash, country, showCountry FROM users"
        ).fetchall()
        pixelRows = src.execute(
            "SELECT x, y, c, t, by, coats, shieldUntil, chalkUntil FROM pixels"
        ).fetchall()
        histRows = src.execute(
            "SELECT x, y, uid, c, t, at, undone, xp, rewardInk, rewardAmount"
            " FROM history ORDER BY id ASC"
        ).fetchall()
    finally:
        src.close()
    result = {"users": len(userRows), "pixels": len(pixelRows), "history": len(histRows)}
    batch = 2000
    for idx in range(0, len(userRows), batch):
        await executeMany(
            "INSERT INTO users(token, uid, name, color, inventory, cooldownUntil,"
            " level, xp, transferCode, passwordHash, country, showCountry)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
            [tuple(r) for r in userRows[idx : idx + batch]],
        )
    for idx in range(0, len(pixelRows), batch):
        await executeMany(
            "INSERT INTO pixels(x, y, c, t, by, coats, shieldUntil, chalkUntil)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(x, y) DO NOTHING",
            [tuple(r) for r in pixelRows[idx : idx + batch]],
        )
    for idx in range(0, len(histRows), batch):
        await executeMany(
            "INSERT INTO history(x, y, uid, c, t, at, undone, xp, rewardInk, rewardAmount)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [tuple(r) for r in histRows[idx : idx + batch]],
        )
    pool = _pgPoolOrRaise()
    async with pool.acquire() as conn:
        with contextlib.suppress(Exception):
            await conn.execute("VACUUM (ANALYZE) users")
        with contextlib.suppress(Exception):
            await conn.execute("VACUUM (ANALYZE) pixels")
        with contextlib.suppress(Exception):
            await conn.execute("VACUUM (ANALYZE) history")
    logger.info("copied sqlite to postgres: %s", result)
    return result
