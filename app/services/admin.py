"""管理者機能 (荒らし対応)。lookup・rollback・IP禁止。

rollback は指定 uid が最後に触ったマスを、ひとつ前の履歴状態に戻す。
他の人が上書き済みのマスは壊さない (skipped)。経験値・当選報酬も巻き戻す。
"""

from __future__ import annotations

import json
from typing import Any

from app.services import config as cfg
from app.services import database, shared, users
from app.services.database import DbTx

ROLLBACK_DEFAULT_LIMIT = 1000
ROLLBACK_MAX_LIMIT = 5000


def isAdminToken(token: str) -> bool:
    tok = (token or "").strip()[:64]
    return bool(tok) and tok in set(cfg.adminTokens or [])


async def lookupUser(uid: str) -> dict | None:
    """uid から管理表示用の安全な概要を返す (秘密情報は含めない)。"""
    uid = (uid or "").strip()[:16]
    if not uid:
        return None
    row = await database.fetchOne("SELECT token FROM users WHERE uid = ?", (uid,))
    if row is None:
        return None
    user = await database.fetchOne(
        "SELECT token, uid, name, color, inventory, cooldownUntil, level, xp,"
        " transferCode, passwordHash, country, showCountry FROM users WHERE token = ?",
        (row[0],),
    )
    if user is None:
        return None
    userDict = users.rowToUser(user)
    touchedRow = await database.fetchOne(
        "SELECT COUNT(*) FROM (SELECT DISTINCT x, y FROM history"
        " WHERE uid = ? AND undone = 0) AS t",
        (uid,),
    )
    return {
        "uid": userDict["uid"],
        "name": userDict["name"],
        "color": userDict["color"],
        "level": userDict["level"],
        "xp": userDict["xp"],
        "inventory": dict(userDict["inventory"]),
        "country": userDict.get("country"),
        "touchedCells": int(touchedRow[0]) if touchedRow else 0,
        "lastIp": await shared.lastIp(userDict["token"]),
        "online": (await shared.pget(userDict["token"])) is not None,
    }


async def rollbackUser(uid: str, limit: int = ROLLBACK_DEFAULT_LIMIT) -> dict:
    """uid の配置を巻き戻す。上書き済みセルは触らない。"""

    async def _once() -> dict:
        async with database.tx() as db:
            return await _rollbackInner(db, uid, limit)

    return await database.withRetry("rollback", _once)


async def _rollbackInner(db: DbTx, uid: str, limit: int = ROLLBACK_DEFAULT_LIMIT) -> dict:
    uid = (uid or "").strip()[:16]
    limit = max(1, min(ROLLBACK_MAX_LIMIT, int(limit or ROLLBACK_DEFAULT_LIMIT)))
    if not uid:
        return {"ok": False, "error": "badUid"}
    # 行ロックで同時巻き戻しと直列化 (SQLite時は tx() のBEGIN IMMEDIATEが担う)
    userSql = "SELECT token, level, xp, inventory FROM users WHERE uid = ?"
    if database.isPostgres():
        userSql += " FOR UPDATE"
    target = await db.fetchOne(userSql, (uid,))
    if target is None:
        return {"ok": False, "error": "noUser"}
    targetToken = target[0]
    cells = await db.fetchAll(
        "SELECT DISTINCT x, y FROM history WHERE uid = ? AND undone = 0 LIMIT ?",
        (uid, limit + 1),
    )
    truncated = len(cells) > limit
    events: list[dict] = []
    restored = 0
    skipped = 0
    xpTaken = 0
    rewardsTaken: dict[str, int] = {}
    for x, y in cells[:limit]:
        rows = await db.fetchAll(
            "SELECT id, uid, c, t, xp, rewardInk, rewardAmount FROM history"
            " WHERE x = ? AND y = ? AND undone = 0 ORDER BY id DESC LIMIT 2",
            (x, y),
        )
        if not rows or rows[0][1] != uid:
            skipped += 1
            continue
        (_rid, _ru, _c, _t, rxp, rink, ramount) = rows[0]
        prev = rows[1] if len(rows) > 1 else None
        await db.execute("UPDATE history SET undone = 1 WHERE id = ?", (rows[0][0],))
        if prev is None:
            await db.execute("DELETE FROM pixels WHERE x = ? AND y = ?", (x, y))
            events.append(
                {"x": x, "y": y, "c": cfg.background, "t": "normal", "erased": True, "s": 0, "e": 0}
            )
        else:
            await db.execute(
                "INSERT INTO pixels(x, y, c, t, by, coats, shieldUntil)"
                " VALUES (?, ?, ?, ?, ?, 1, 0)"
                " ON CONFLICT(x, y) DO UPDATE SET c=excluded.c, t=excluded.t,"
                " by=excluded.by, coats=excluded.coats, shieldUntil=0, chalkUntil=0",
                (x, y, prev[2], prev[3], prev[1]),
            )
            events.append(
                {
                    "x": x,
                    "y": y,
                    "c": prev[2],
                    "t": prev[3],
                    "by": prev[1],
                    "coats": 1,
                    "s": 0,
                    "e": 0,
                }
            )
        restored += 1
        xpTaken += int(rxp or 0)
        if rink:
            rewardsTaken[rink] = rewardsTaken.get(rink, 0) + int(ramount or 0)
    # 巻き戻し分の経験値・報酬を没収 (レベルダウンあり・0止め)
    level = users.clampLevel(target[1])
    xp = int(target[2] or 0) - xpTaken
    while xp < 0 and level > 1:
        level -= 1
        xp += users.xpNeededForLevel(level)
    xp = max(0, xp)
    inv = users.parseInventory(target[3])
    for ink, amount in rewardsTaken.items():
        inv[ink] = max(0, inv.get(ink, 0) - amount)
    await db.execute(
        "UPDATE users SET inventory = ?, level = ?, xp = ? WHERE uid = ?",
        (_dumpInventory(inv), level, xp, uid),
    )
    await shared.ptouch(targetToken, level=level)
    return {
        "ok": True,
        "uid": uid,
        "restored": restored,
        "skipped": skipped,
        "truncated": truncated,
        "xpTaken": xpTaken,
        "level": level,
        "xp": xp,
        "events": events,
    }


def _dumpInventory(inv: dict[str, int]) -> str:
    return json.dumps({k: inv.get(k, 0) for k in cfg.specialInks}, ensure_ascii=False)


async def statusSnapshot() -> dict[str, Any]:
    """429切り分け用の現在値 (管理者のみ)。"""
    return {
        "ok": True,
        "presence": await shared.pcount(),
        "sockets": await shared.liveSocketCount(),
        "banned": await shared.banList(),
        "topPlaceIps": await shared.rateTop("place", 60.0),
        "topSessionIps": await shared.rateTop("session", 3600.0),
        "redis": {"enabled": shared.useRedis(), "ok": shared.redisOk()},
        "config": {
            "placePerMinPerIp": cfg.placePerMinPerIp,
            "sessionPerHour": cfg.sessionPerHour,
            "requireSocketForPlace": cfg.requireSocketForPlace,
            "maxSocketsPerIp": cfg.maxSocketsPerIp,
            "shieldMinutes": cfg.shieldMinutes,
            "chalkMinutes": cfg.chalkMinutes,
        },
    }
