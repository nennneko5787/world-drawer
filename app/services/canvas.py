"""キャンバス操作 (配置・プロフィール・照会)。トランザクション境界は各関数内。"""

from __future__ import annotations

import json
import random
import time
from typing import Any

import aiosqlite

from app.objects.requests import PlaceInput, UndoBody
from app.services import config as cfg
from app.services import presence, users
from app.services.database import dbLock, getDb


def inBounds(x: int, y: int) -> bool:
    return -cfg.coordLimit <= x <= cfg.coordLimit and -cfg.coordLimit <= y <= cfg.coordLimit


def rollReward() -> tuple[str, int] | None:
    # ゲーム内ガチャであり秘密情報ではない
    if random.random() >= cfg.rewardChance:  # noqa: S311
        return None
    ink = random.choice(list(cfg.specialInks.keys()))  # noqa: S311
    amount = random.randint(cfg.rewardMin, cfg.rewardMax)  # noqa: S311
    return ink, amount


IP_BUCKET_WINDOW_SEC = 60.0
HISTORY_PRUNE_CHANCE = 0.05


class PlaceError(Exception):
    """配置失敗。result をそのまま呼び出し元へ返す。"""

    def __init__(self, result: dict) -> None:
        super().__init__()
        self.result = result


async def checkCooldown(user: dict, level: int, now: float) -> None:
    remain = max(0.0, float(user.get("cooldownUntil", 0.0)) - now)
    if remain > 0:
        raise PlaceError(
            {
                "ok": False,
                "error": "cooldown",
                "remaining": round(remain, 2),
                "cooldownUntil": user["cooldownUntil"],
                "cooldown": users.cooldownForLevel(level),
                "level": level,
                "xp": int(user.get("xp", 0)),
                "xpNeeded": users.xpNeededForLevel(level),
            }
        )


async def checkRadius(db: aiosqlite.Connection, token: str, level: int, x: int, y: int) -> None:
    # 荒らし対策1: 低レベルは既存ピクセル/他プレイヤーの半径内のみ
    if level >= cfg.trustedLevel:
        return
    async with db.execute("SELECT COUNT(*) FROM pixels") as cur:
        totalPixels = await fetchFirstInt(cur)
    if totalPixels == 0:
        return
    if await nearPixel(db, x, y):
        return
    if nearOtherPresence(token, x, y):
        return
    raise PlaceError({"ok": False, "error": "tooFar", "radius": cfg.placeRadius})


MAX_GHOST_COATS = 5  # ゴーストの重ね塗り上限 (不透明度は 1-0.5/coats)


def isHexColor(value: object) -> bool:
    """#rrggbb 形式か (焼き付け土台の安全確認用)。"""
    return isinstance(value, str) and users.HEX_COLOR.match(value) is not None


def blendHex(over: str, under: str, alpha: float = 0.5) -> str:
    """2色の16進カラーを alpha 合成する (ゴーストの混色用)。"""
    o = over.lstrip("#")
    u = under.lstrip("#")
    mixed = (
        round(int(o[i : i + 2], 16) * alpha + int(u[i : i + 2], 16) * (1.0 - alpha))
        for i in (0, 2, 4)
    )
    return "#{:02x}{:02x}{:02x}".format(*mixed)


def splitInkParts(value: str | None) -> set[str]:
    """t 列の正準形 ("ghost+glow") を特殊インク集合に。通常・不明な型は空集合。"""
    if not value or value == "normal":
        return set()
    parts = set(value.split("+"))
    if not parts <= set(cfg.specialInks):
        return set()
    return parts


def resolveGlowPlacement(color: str, existing: Any | None) -> tuple[str, str, int]:
    """発光の配置内容 (発光色を置き換え、発光を付与。他インクは維持)。"""
    if not users.HEX_COLOR.match(color or ""):
        raise PlaceError({"ok": False, "error": "badColor"})
    if existing is None:
        return color.lower(), "glow", 1
    _baseC, baseT, rawCoats = existing
    parts = splitInkParts(baseT) | {"glow"}
    coats = 1 if rawCoats is None else int(rawCoats)
    return color.lower(), "+".join(sorted(parts)), coats


def resolveRainbowPlacement(existing: Any | None) -> tuple[str, str, int]:
    """虹色の配置内容 (表示はアニメ色相のため保存色は維持。新規は仮置き)。"""
    if existing is None:
        return "#ff0000", "rainbow", 1
    baseC, baseT, rawCoats = existing
    parts = splitInkParts(baseT) | {"rainbow"}
    coats = 1 if rawCoats is None else int(rawCoats)
    return baseC, "+".join(sorted(parts)), coats


def resolveGhostPlacement(color: str, existing: Any | None) -> tuple[str, str, int]:
    """ゴーストの配置内容。

    - 空き: 半透明で置く (coats=1)
    - 既存ゴースト: 色を置き換え、不透明度を深める (上限あり。焼き付け済みは再混合)
    - 虹色表示中: 色は維持し、ゴースト効果のみ付与
    - 静止色の土台 (通常・発光) に混ぜて焼き付ける (coats=0=不透明描画)
    """
    if not users.HEX_COLOR.match(color or ""):
        raise PlaceError({"ok": False, "error": "badColor"})
    chosen = color.lower()
    if existing is None:
        return chosen, "ghost", 1
    baseC, baseT, rawCoats = existing
    # coats=0 は混色済み。None (想定外) は1扱い。0 を or で潰さないよう注意
    baseCoats = 1 if rawCoats is None else int(rawCoats)
    parts = splitInkParts(baseT)
    if "ghost" in parts:
        if baseCoats <= 0:
            base = baseC if isHexColor(baseC) else cfg.background
            return blendHex(chosen, base), "+".join(sorted(parts)), 0
        keep = chosen if "rainbow" not in parts else baseC
        return keep, "+".join(sorted(parts)), min(MAX_GHOST_COATS, baseCoats + 1)
    parts.add("ghost")
    if "rainbow" in splitInkParts(baseT):
        return baseC, "+".join(sorted(parts)), 1
    base = baseC if isHexColor(baseC) else cfg.background
    return blendHex(chosen, base), "+".join(sorted(parts)), 0


async def writePixel(
    db: aiosqlite.Connection, place: PlaceInput, ink: str, inv: dict, user: dict
) -> tuple[dict, str, str]:
    x, y, color = place.x, place.y, place.color
    if ink == "erase":
        await db.execute("DELETE FROM pixels WHERE x = ? AND y = ?", (x, y))
        applied = {"c": cfg.background, "t": "normal", "erased": True}
        return applied, cfg.background, "erase"
    if ink == "normal":
        if not users.HEX_COLOR.match(color or ""):
            raise PlaceError({"ok": False, "error": "badColor"})
        await db.execute(
            "INSERT INTO pixels(x, y, c, t, by, coats) VALUES (?, ?, ?, 'normal', ?, 1)"
            " ON CONFLICT(x, y) DO UPDATE SET c=excluded.c, t=excluded.t,"
            " by=excluded.by, coats=excluded.coats",
            (x, y, color.lower(), user["uid"]),
        )
        return {"c": color.lower(), "t": "normal", "coats": 1}, color.lower(), "normal"
    if inv.get(ink, 0) <= 0:
        raise PlaceError({"ok": False, "error": "noInk", "inventory": dict(inv)})
    if ink not in cfg.specialInks:
        raise PlaceError({"ok": False, "error": "unknownInk"})
    async with db.execute("SELECT c, t, coats FROM pixels WHERE x = ? AND y = ?", (x, y)) as cur:
        existing = await cur.fetchone()
    if ink == "glow":
        storeColor, storeT, coats = resolveGlowPlacement(color, existing)
    elif ink == "rainbow":
        storeColor, storeT, coats = resolveRainbowPlacement(existing)
    else:
        storeColor, storeT, coats = resolveGhostPlacement(color, existing)
    await db.execute(
        "INSERT INTO pixels(x, y, c, t, by, coats) VALUES (?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(x, y) DO UPDATE SET c=excluded.c, t=excluded.t,"
        " by=excluded.by, coats=excluded.coats",
        (x, y, storeColor, storeT, user["uid"], coats),
    )
    inv[ink] -= 1
    return {"c": storeColor, "t": storeT, "coats": coats}, storeColor, ink


def consumeIpBucket(ip: str, now: float) -> None:
    # 荒らし対策2: IP共有の配置上限 (成功分のみ計数)
    if not ip or ip == "unknown":
        return
    arr = [t for t in users.ipPlaceHits.get(ip, []) if now - t < IP_BUCKET_WINDOW_SEC]
    if len(arr) >= cfg.placePerMinPerIp:
        users.ipPlaceHits[ip] = arr
        raise PlaceError({"ok": False, "error": "ipBusy"})
    arr.append(now)
    users.ipPlaceHits[ip] = arr


async def pruneHistoryCells(db: aiosqlite.Connection) -> None:
    async with db.execute("SELECT COUNT(*) FROM (SELECT DISTINCT x, y FROM history)") as cur:
        cellCount = await fetchFirstInt(cur)
    overflow = cellCount - cfg.maxHistoryCells
    if overflow <= 0:
        return
    await db.execute(
        "DELETE FROM history WHERE id IN ("
        " SELECT h.id FROM history h JOIN"
        " (SELECT x AS cx, y AS cy FROM history"
        " GROUP BY x, y ORDER BY MAX(at) ASC LIMIT ?) old"
        " ON h.x = old.cx AND h.y = old.cy)",
        (overflow,),
    )


async def executePlace(
    db: aiosqlite.Connection, place: PlaceInput, ip: str, now: float, countryCode: str | None = None
) -> dict:
    token = place.token
    x, y = place.x, place.y
    ink = place.ink or place.inkType or "normal"
    user = await users.ensureUser(db, token, users.defaultNameFor(place.lang, ""))
    level = users.clampLevel(user.get("level", 1))
    await checkCooldown(user, level, now)
    await checkRadius(db, token, level, x, y)
    inv = user["inventory"]
    applied, histColor, histInk = await writePixel(db, place, ink, inv, user)
    consumeIpBucket(ip, now)
    cooldownUntil = now + users.cooldownForLevel(level)

    # 経験値付与とレベルアップ (上限なし。複数段上がりに対応。必要値>=1のため必ず停止)
    xp = int(user.get("xp", 0)) + cfg.xpPerPlace
    leveledUp = False
    while xp >= users.xpNeededForLevel(level):
        xp -= users.xpNeededForLevel(level)
        level += 1
        leveledUp = True

    reward = rollReward()
    if reward is not None:
        gotInk, amount = reward
        inv[gotInk] = inv.get(gotInk, 0) + amount

    newCountry = countryCode or user.get("country")
    await db.execute(
        "UPDATE users SET inventory = ?, cooldownUntil = ?, level = ?, xp = ?, country = ?"
        " WHERE token = ?",
        (json.dumps(inv, ensure_ascii=False), cooldownUntil, level, xp, newCountry, token),
    )
    await db.execute(
        "INSERT INTO history(x, y, uid, c, t, at, xp, rewardInk, rewardAmount)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            x,
            y,
            user["uid"],
            histColor,
            histInk,
            now,
            cfg.xpPerPlace,
            reward[0] if reward else None,
            reward[1] if reward else 0,
        ),
    )
    await db.execute(
        "DELETE FROM history WHERE x = ? AND y = ? AND id NOT IN"
        " (SELECT id FROM history WHERE x = ? AND y = ? ORDER BY at DESC, id DESC LIMIT ?)",
        (x, y, x, y, cfg.maxHistoryPerCell),
    )
    # セル数上限の整理は低頻度で (毎回COUNT走査しない)
    if random.random() < HISTORY_PRUNE_CHANCE:  # noqa: S311 — ゲーム内整理の間引きであり秘密情報ではない
        await pruneHistoryCells(db)
    await db.commit()

    return {
        "ok": True,
        "x": x,
        "y": y,
        "pixel": applied,
        "by": user["uid"],
        "cooldownUntil": cooldownUntil,
        "cooldown": users.cooldownForLevel(level),
        "inventory": dict(inv),
        "reward": {"ink": reward[0], "amount": reward[1]} if reward else None,
        "level": level,
        "xp": xp,
        "xpNeeded": users.xpNeededForLevel(level),
        "leveledUp": leveledUp,
    }


UNDO_WINDOW_SEC = 3.0


def normalizeUndoPrev(
    prevC: str, prevT: str, *, prevEmpty: bool, prevCoats: int = 1
) -> tuple[bool, str, str, int]:
    if prevEmpty:
        return True, cfg.background, "normal", 1
    # prevT は単体 ("glow") または重ねがけ正準形 ("ghost+glow")
    parts = (prevT or "").split("+")
    allowed = {"normal", *cfg.specialInks}
    if not parts or any(p not in allowed for p in parts):
        raise PlaceError({"ok": False, "error": "badPrev"})
    if "normal" in parts and len(parts) > 1:
        raise PlaceError({"ok": False, "error": "badPrev"})
    if not users.HEX_COLOR.match(prevC or ""):
        raise PlaceError({"ok": False, "error": "badPrev"})
    try:
        coats = max(0, min(MAX_GHOST_COATS, int(prevCoats)))
    except (TypeError, ValueError):
        raise PlaceError({"ok": False, "error": "badPrev"}) from None
    return False, prevC.lower(), prevT, coats


async def fetchUndoLast(db: aiosqlite.Connection, x: int, y: int) -> Any | None:
    async with db.execute(
        "SELECT id, uid, c, t, at, undone, xp, rewardInk, rewardAmount FROM history"
        " WHERE x = ? AND y = ? ORDER BY id DESC LIMIT 1",
        (x, y),
    ) as cur:
        return await cur.fetchone()


def checkUndoFresh(last: Any, user: dict, now: float) -> None:
    _lastId, lastUid, _c, _t, lastAt, lastUndone, *_rest = last
    if lastUid != user["uid"] or lastUndone or now - float(lastAt) > UNDO_WINDOW_SEC:
        raise PlaceError({"ok": False, "error": "tooLate"})


async def checkUndoCurrent(db: aiosqlite.Connection, body: UndoBody, last: Any) -> None:
    _lastId, _uid, lastC, lastT, _at, _undone, *_rest = last
    async with db.execute("SELECT c, t FROM pixels WHERE x = ? AND y = ?", (body.x, body.y)) as cur:
        current = await cur.fetchone()
    if lastT == "erase":
        if current is not None:
            raise PlaceError({"ok": False, "error": "changed"})
    elif current is None or current[0] != lastC or current[1] != lastT:
        raise PlaceError({"ok": False, "error": "changed"})


async def checkUndoPrev(db: aiosqlite.Connection, body: UndoBody, lastId: int) -> None:
    # 無効化済み(undone)の行は存在しなかったものとして扱う
    async with db.execute(
        "SELECT c, t FROM history WHERE x = ? AND y = ? AND id < ? AND undone = 0"
        " ORDER BY id DESC LIMIT 1",
        (body.x, body.y, lastId),
    ) as cur:
        older = await cur.fetchone()
    if older is None or older[1] == "erase":
        # 以前が空 (未配置 or 消去済み) の場合のみ prevEmpty を許可
        if not body.prevEmpty:
            raise PlaceError({"ok": False, "error": "badPrev"})
    elif body.prevEmpty or body.prevC.lower() != older[0] or body.prevT != older[1]:
        raise PlaceError({"ok": False, "error": "badPrev"})


async def restoreUndoPixel(db: aiosqlite.Connection, body: UndoBody, user: dict) -> dict:
    if body.prevEmpty:
        await db.execute("DELETE FROM pixels WHERE x = ? AND y = ?", (body.x, body.y))
        return {"c": cfg.background, "t": "normal", "erased": True}
    await db.execute(
        "INSERT INTO pixels(x, y, c, t, by, coats) VALUES (?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(x, y) DO UPDATE SET c=excluded.c, t=excluded.t, coats=excluded.coats",
        (body.x, body.y, body.prevC.lower(), body.prevT, user["uid"], body.prevCoats),
    )
    return {"c": body.prevC.lower(), "t": body.prevT, "coats": body.prevCoats}


async def finalizeUndo(
    db: aiosqlite.Connection,
    token: str,
    user: dict,
    last: Any,
    *,
    countryCode: str | None = None,
) -> tuple[dict, int, int]:
    lastId, _uid, _c, lastT, _at, _undone, xpGrant, rewardInk, rewardAmount = last
    await db.execute("UPDATE history SET undone = 1 WHERE id = ?", (lastId,))
    inv = user["inventory"]
    if lastT in cfg.specialInks:
        inv[lastT] = inv.get(lastT, 0) + 1
    # 巻き戻し: 経験値 (レベルダウンあり) と当選報酬。使用済み分は枯渇時に0止め
    level = users.clampLevel(user.get("level", 1))
    xp = int(user.get("xp", 0)) - int(xpGrant or 0)
    while xp < 0 and level > 1:
        level -= 1
        xp += users.xpNeededForLevel(level)
    xp = max(0, xp)
    if rewardInk:
        inv[rewardInk] = max(0, inv.get(rewardInk, 0) - int(rewardAmount or 0))
    newCountry = countryCode or user.get("country")
    await db.execute(
        "UPDATE users SET inventory = ?, cooldownUntil = ?, level = ?, xp = ?, country = ?"
        " WHERE token = ?",
        (json.dumps(inv, ensure_ascii=False), user["cooldownUntil"], level, xp, newCountry, token),
    )
    await db.commit()
    return inv, level, xp


async def executeUndo(
    db: aiosqlite.Connection, body: UndoBody, token: str, now: float, countryCode: str | None = None
) -> dict:
    user = await users.fetchUser(db, token)
    if user is None:
        raise PlaceError({"ok": False, "error": "noUndo"})
    last = await fetchUndoLast(db, body.x, body.y)
    if last is None:
        raise PlaceError({"ok": False, "error": "noUndo"})
    checkUndoFresh(last, user, now)
    await checkUndoCurrent(db, body, last)
    await checkUndoPrev(db, body, last[0])
    applied = await restoreUndoPixel(db, body, user)
    inv, level, xp = await finalizeUndo(db, token, user, last, countryCode=countryCode)
    return {
        "ok": True,
        "x": body.x,
        "y": body.y,
        "pixel": applied,
        "by": user["uid"],
        "inventory": dict(inv),
        "cooldownUntil": user["cooldownUntil"],
        "level": level,
        "xp": xp,
        "xpNeeded": users.xpNeededForLevel(level),
    }


async def undoPlace(body: UndoBody, country: str | None = None) -> dict:
    """直前3秒以内の自分の配置を取り消す。経験値・当選報酬も巻き戻し、使用インクのみ返却。"""
    token = (body.token or "").strip()[:64]
    if not token:
        return {"ok": False, "error": "missingToken"}
    if not inBounds(body.x, body.y):
        return {"ok": False, "error": "outOfBounds"}
    try:
        prevEmpty, prevC, prevT, prevCoats = normalizeUndoPrev(
            body.prevC, body.prevT, prevEmpty=body.prevEmpty, prevCoats=body.prevCoats
        )
    except PlaceError as err:
        return err.result
    body = body.model_copy(
        update={
            "token": token,
            "prevEmpty": prevEmpty,
            "prevC": prevC,
            "prevT": prevT,
            "prevCoats": prevCoats,
        }
    )

    db = await getDb()
    try:
        async with dbLock:
            return await executeUndo(db, body, token, time.time(), country)
    except PlaceError as err:
        return err.result


async def doPlace(place: PlaceInput, *, ip: str = "unknown", country: str | None = None) -> dict:
    token = (place.token or "").strip()[:64]
    if not inBounds(place.x, place.y):
        return {"ok": False, "error": "outOfBounds"}
    if (place.ink or place.inkType or "normal") not in ("normal", "erase", *cfg.specialInks):
        return {"ok": False, "error": "unknownInk"}
    if not token:
        return {"ok": False, "error": "missingToken"}
    place = place.model_copy(update={"token": token})

    db = await getDb()
    try:
        async with dbLock:
            return await executePlace(db, place, ip, time.time(), country)
    except PlaceError as err:
        return err.result


def nearOtherPresence(token: str, x: int, y: int) -> bool:
    radius = cfg.placeRadius
    for tok, item in presence.presence.items():
        if tok == token:
            continue
        ix, iy = item.get("x"), item.get("y")
        if ix is None or iy is None:
            continue
        if max(abs(ix - x), abs(iy - y)) <= radius:
            return True
    return False


async def nearPixel(db: aiosqlite.Connection, x: int, y: int) -> bool:
    radius = cfg.placeRadius
    async with db.execute(
        "SELECT 1 FROM pixels WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ? LIMIT 1",
        (x - radius, x + radius, y - radius, y + radius),
    ) as cur:
        return await cur.fetchone() is not None


async def doProfile(
    token: str,
    name: str,
    color: str,
    *,
    showCountry: bool | None = None,
    countryCode: str | None = None,
) -> dict:
    if not token:
        return {"ok": False, "error": "missingToken"}
    db = await getDb()
    async with dbLock:
        user = await users.ensureUser(db, token)
        newName = users.cleanName(name)
        newColor = users.cleanColor(color, user.get("color", "#22aa66"))
        newShow = user.get("showCountry", True) if showCountry is None else bool(showCountry)
        newCountry = countryCode or user.get("country")
        await db.execute(
            "UPDATE users SET name = ?, color = ?, showCountry = ?, country = ? WHERE token = ?",
            (newName, newColor, int(newShow), newCountry, token),
        )
        await db.commit()
    item = presence.presence.get(token)
    if item is not None:
        item["name"] = newName
        item["color"] = newColor
        item["showCountry"] = newShow
        item["country"] = newCountry
        item["updatedAt"] = time.time()
    return {
        "ok": True,
        "profile": {
            "name": newName,
            "color": newColor,
            "country": newCountry,
            "showCountry": newShow,
        },
    }


def totalEarnedFor(level: int, xp: int) -> int:
    """そのアカウントが今まで稼いだ総経験値 (レベル換算前)。"""
    total = max(0, int(xp or 0))
    for lv in range(1, users.clampLevel(level)):
        total += users.xpNeededForLevel(lv)
    return total


def levelXpFromTotal(total: int) -> tuple[int, int]:
    """総経験値から (level, xp) を再計算。"""
    total = max(0, int(total or 0))
    level = 1
    # 安全弁付き (無限ループ防止)
    for _ in range(100000):
        need = users.xpNeededForLevel(level)
        if total < need:
            break
        total -= need
        level += 1
    return level, total


async def mergeAccounts(
    db: aiosqlite.Connection, fromToken: str, target: dict
) -> tuple[dict, bool]:
    """引っ越しログイン時の統合。現端末のアカウント(fromToken)を引っ越し先に統合する。

    - 経験値は合算してレベル再計算、特殊インクは合算 (両方のデータが合体)
    - 履歴・ピクセルは両方とも残し、帰属 (uid/by) を引っ越し先 uid に付け替え
    - 名前・色は引っ越し先を維持。ただし引っ越し先が初期名のままで
      引っ越し元が名前を変更済みなら、引っ越し元の名前・色を引き継ぐ
    - 国は引っ越し先になければ引っ越し元のものを引き継ぐ
    - 表示設定・引っ越しコードは引っ越し先を維持
    - 統合後は元アカウント行を削除
    """
    srcToken = (fromToken or "").strip()[:64]
    dstToken = target.get("token", "")
    if not srcToken or not dstToken or srcToken == dstToken:
        return target, False
    src = await users.fetchUser(db, srcToken)
    if src is None:
        return target, False
    if src.get("uid") == target.get("uid"):
        # 万が一 uid が同じでもトークンが違えば旧行だけ消す
        await db.execute("DELETE FROM users WHERE token = ?", (srcToken,))
        await db.commit()
        presence.presence.pop(srcToken, None)
        return target, False

    total = totalEarnedFor(target.get("level", 1), target.get("xp", 0)) + totalEarnedFor(
        src.get("level", 1), src.get("xp", 0)
    )
    newLevel, newXp = levelXpFromTotal(total)
    mergedInv: dict[str, int] = {}
    for k in cfg.specialInks:
        mergedInv[k] = int(target.get("inventory", {}).get(k, 0)) + int(
            src.get("inventory", {}).get(k, 0)
        )
    newCooldown = max(
        float(target.get("cooldownUntil", 0.0) or 0.0),
        float(src.get("cooldownUntil", 0.0) or 0.0),
    )
    newCountry = target.get("country") or src.get("country")
    # 名前・色: 引っ越し先が初期名のままで引っ越し元が変更済みなら引っ越し元を採用
    newName = target.get("name", "ななし")
    newColor = target.get("color", "#22aa66")
    defaultNames = set(users.ANON_NAMES.values())
    srcName = (src.get("name") or "").strip()
    if (newName in defaultNames) and srcName and (srcName not in defaultNames):
        newName = users.cleanName(srcName)
        newColor = users.cleanColor(src.get("color") or "", newColor)
    await db.execute(
        "UPDATE users SET inventory = ?, cooldownUntil = ?, level = ?, xp = ?,"
        " country = ?, name = ?, color = ? WHERE token = ?",
        (
            json.dumps(mergedInv, ensure_ascii=False),
            newCooldown,
            newLevel,
            newXp,
            newCountry,
            newName,
            newColor,
            dstToken,
        ),
    )
    # 帰属の付け替え (匿名化させないため)
    await db.execute("UPDATE history SET uid = ? WHERE uid = ?", (target["uid"], src["uid"]))
    await db.execute("UPDATE pixels SET by = ? WHERE by = ?", (target["uid"], src["uid"]))
    await db.execute("DELETE FROM users WHERE token = ?", (srcToken,))
    await db.commit()
    presence.presence.pop(srcToken, None)
    refreshed = await users.fetchUser(db, dstToken)
    assert refreshed is not None  # noqa: S101 — 直前にUPDATEした行のため存在保証
    return refreshed, True


def userPayload(user: dict, token: str, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    level = users.clampLevel(user.get("level", 1))
    return {
        "token": token,
        "uid": user["uid"],
        "profile": {"name": user["name"], "color": user["color"]},
        "country": user.get("country"),
        "showCountry": user.get("showCountry", True),
        "inventory": dict(user["inventory"]),
        "remaining": round(max(0.0, float(user.get("cooldownUntil", 0.0)) - now), 2),
        "cooldownUntil": user["cooldownUntil"],
        "cooldown": users.cooldownForLevel(level),
        "level": level,
        "xp": int(user.get("xp", 0)),
        "xpNeeded": users.xpNeededForLevel(level),
        "hasAccount": bool(user.get("transferCode")),
    }


async def fetchFirstInt(cur: aiosqlite.Cursor) -> int:
    row = await cur.fetchone()
    return int(row[0]) if row else 0


async def fetchBbox(loX: int, hiX: int, loY: int, hiY: int) -> tuple[dict, bool]:
    db = await getDb()
    async with db.execute(
        "SELECT x, y, c, t, by, coats FROM pixels"
        " WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ? LIMIT ?",
        (loX, hiX, loY, hiY, cfg.maxBboxPixels + 1),
    ) as cur:
        rows = list(await cur.fetchall())
    truncated = len(rows) > cfg.maxBboxPixels
    out = {
        f"{x},{y}": {"c": c, "t": t, "by": by, "coats": coats}
        for x, y, c, t, by, coats in rows[: cfg.maxBboxPixels]
    }
    return out, truncated


async def fetchBounds() -> dict:
    db = await getDb()
    async with db.execute("SELECT COUNT(*), MIN(x), MIN(y), MAX(x), MAX(y) FROM pixels") as cur:
        row = await cur.fetchone()
    if row is None:
        return {"count": 0, "minX": None, "minY": None, "maxX": None, "maxY": None}
    count, minX, minY, maxX, maxY = row
    if not count:
        return {"count": 0, "minX": None, "minY": None, "maxX": None, "maxY": None}
    return {"count": count, "minX": minX, "minY": minY, "maxX": maxX, "maxY": maxY}


async def fetchPixelCount() -> int:
    db = await getDb()
    async with db.execute("SELECT COUNT(*) FROM pixels") as cur:
        return await fetchFirstInt(cur)


async def fetchHistoryItems(
    x: int, y: int, limit: int = 20, beforeId: int | None = None
) -> tuple[list[dict], bool]:
    """名前・色はusersから都度解決 (改名対応)。新しい順+hasMore。取り消し済みは除外。"""
    limit = max(1, min(100, limit))
    db = await getDb()
    sql = (
        "SELECT h.id, h.uid, COALESCE(u.name, 'ななし'), COALESCE(u.color, '#22aa66'),"
        " h.c, h.t, h.at, CASE WHEN u.showCountry = 1 THEN u.country ELSE NULL END"
        " FROM history h LEFT JOIN users u ON u.uid = h.uid"
        " WHERE h.x = ? AND h.y = ? AND h.undone = 0"
    )
    params: list[object] = [x, y]
    if beforeId is not None:
        sql += " AND h.id < ?"
        params.append(beforeId)
    sql += " ORDER BY h.id DESC LIMIT ?"
    params.append(limit + 1)
    async with db.execute(sql, params) as cur:
        rows = list(await cur.fetchall())
    hasMore = len(rows) > limit
    return (
        [
            {
                "id": rid,
                "uid": uid,
                "name": name,
                "userColor": color,
                "c": c,
                "t": t,
                "at": at,
                "country": country,
            }
            for rid, uid, name, color, c, t, at, country in rows[:limit]
        ],
        hasMore,
    )
