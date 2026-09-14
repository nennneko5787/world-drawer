"""管理者機能 (荒らし対応)。lookup・rollback・IP禁止。

rollback は指定 uid が最後に触ったマスを、ひとつ前の履歴状態に戻す。
他の人が上書き済みのマスは壊さない (skipped)。経験値・当選報酬も巻き戻す。
"""

from __future__ import annotations

import json
import time
from typing import Any

import aiosqlite

from app.services import config as cfg
from app.services import presence, users
from app.services.realtime import socketIps

ROLLBACK_DEFAULT_LIMIT = 1000
ROLLBACK_MAX_LIMIT = 5000


def isAdminToken(token: str) -> bool:
    tok = (token or "").strip()[:64]
    return bool(tok) and tok in set(cfg.adminTokens or [])


async def lookupUser(db: aiosqlite.Connection, uid: str) -> dict | None:
    """uid から管理表示用の安全な概要を返す (秘密情報は含めない)。"""
    uid = (uid or "").strip()[:16]
    if not uid:
        return None
    async with db.execute("SELECT token FROM users WHERE uid = ?", (uid,)) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    user = await users.fetchUser(db, row[0])
    if user is None:
        return None
    async with db.execute(
        "SELECT COUNT(DISTINCT x || ',' || y) FROM history WHERE uid = ? AND undone = 0",
        (uid,),
    ) as cur:
        touchedRow = await cur.fetchone()
    return {
        "uid": user["uid"],
        "name": user["name"],
        "color": user["color"],
        "level": user["level"],
        "xp": user["xp"],
        "inventory": dict(user["inventory"]),
        "country": user.get("country"),
        "touchedCells": int(touchedRow[0]) if touchedRow else 0,
        "lastIp": users.ipForToken(user["token"]),
        "online": user["token"] in presence.presence,
    }


async def rollbackUser(
    db: aiosqlite.Connection, uid: str, limit: int = ROLLBACK_DEFAULT_LIMIT
) -> dict:
    """uid の配置を巻き戻す。上書き済みセルは触らない。"""
    uid = (uid or "").strip()[:16]
    limit = max(1, min(ROLLBACK_MAX_LIMIT, int(limit or ROLLBACK_DEFAULT_LIMIT)))
    if not uid:
        return {"ok": False, "error": "badUid"}
    async with db.execute(
        "SELECT token, level, xp, inventory FROM users WHERE uid = ?", (uid,)
    ) as cur:
        target = await cur.fetchone()
    if target is None:
        return {"ok": False, "error": "noUser"}
    targetToken = target[0]
    async with db.execute(
        "SELECT DISTINCT x, y FROM history WHERE uid = ? AND undone = 0 LIMIT ?",
        (uid, limit + 1),
    ) as cur:
        cells = list(await cur.fetchall())
    truncated = len(cells) > limit
    events: list[dict] = []
    restored = 0
    skipped = 0
    xpTaken = 0
    rewardsTaken: dict[str, int] = {}
    for x, y in cells[:limit]:
        async with db.execute(
            "SELECT id, uid, c, t, xp, rewardInk, rewardAmount FROM history"
            " WHERE x = ? AND y = ? AND undone = 0 ORDER BY id DESC LIMIT 2",
            (x, y),
        ) as cur:
            rows = list(await cur.fetchall())
        if not rows or rows[0][1] != uid:
            skipped += 1
            continue
        (_rid, _ru, _c, _t, rxp, rink, ramount) = rows[0]
        prev = rows[1] if len(rows) > 1 else None
        await db.execute("UPDATE history SET undone = 1 WHERE id = ?", (rows[0][0],))
        if prev is None:
            await db.execute("DELETE FROM pixels WHERE x = ? AND y = ?", (x, y))
            events.append({"x": x, "y": y, "c": cfg.background, "t": "normal", "erased": True})
        else:
            await db.execute(
                "INSERT INTO pixels(x, y, c, t, by, coats) VALUES (?, ?, ?, ?, ?, 1)"
                " ON CONFLICT(x, y) DO UPDATE SET c=excluded.c, t=excluded.t,"
                " by=excluded.by, coats=excluded.coats",
                (x, y, prev[2], prev[3], prev[1]),
            )
            events.append({"x": x, "y": y, "c": prev[2], "t": prev[3], "by": prev[1], "coats": 1})
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
    await db.commit()
    entry = presence.presence.get(targetToken)
    if entry is not None:
        entry["level"] = level
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


def banIp(ip: str, seconds: float) -> dict:
    """IP禁止 (seconds<=0 で解除)。不正IPは badIp。"""
    norm = users.parseClientIp(ip)
    if norm is None:
        return {"ok": False, "error": "badIp"}
    if seconds <= 0:
        users.banIp(norm, 0)
        return {"ok": True, "ip": norm, "banned": False, "until": 0.0}
    until = users.banIp(norm, seconds)
    return {"ok": True, "ip": norm, "banned": True, "until": until}


def banStatus() -> list[dict[str, Any]]:
    now = time.time()
    out = []
    for ip, until in list(users.bannedIps.items()):
        if until <= now:
            users.bannedIps.pop(ip, None)
            continue
        out.append({"ip": ip, "until": until})
    return out


def _topHits(
    hits: dict[str, list[float]], windowSec: float, limit: int = 10
) -> list[dict[str, Any]]:
    """429切り分け用: 直近window内の試行が多いIP順。"""
    now = time.time()
    ranked = []
    for ip, arr in hits.items():
        n = sum(1 for t in arr if now - t < windowSec)
        if n > 0:
            ranked.append({"ip": ip, "n": n})
    ranked.sort(key=lambda e: e["n"], reverse=True)
    return ranked[:limit]


def statusSnapshot() -> dict[str, Any]:
    """429切り分け用の現在値 (管理者のみ)。"""
    return {
        "ok": True,
        "presence": len(presence.presence),
        "sockets": len(socketIps),
        "banned": banStatus(),
        "topPlaceIps": _topHits(users.ipPlaceHits, 60.0),
        "topSessionIps": _topHits(users.sessionHits, 3600.0),
        "config": {
            "placePerMinPerIp": cfg.placePerMinPerIp,
            "sessionPerHour": cfg.sessionPerHour,
            "requireSocketForPlace": cfg.requireSocketForPlace,
            "maxSocketsPerIp": cfg.maxSocketsPerIp,
        },
    }
