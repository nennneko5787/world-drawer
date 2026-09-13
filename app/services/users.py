"""ユーザー管理 (CRUD・UID・認証・レート制限・レベル計算)。"""

from __future__ import annotations

import hashlib
import hmac
import json
import random
import re
import secrets
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import aiosqlite

from app.objects import config as cfg

HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
UID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # 紛らわしい文字 (0/o, 1/l) を除外
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

sessionHits: dict[str, list[float]] = {}
loginFails: dict[str, list[float]] = {}
ipPlaceHits: dict[str, list[float]] = {}


def newInventory() -> dict[str, int]:
    return dict.fromkeys(cfg.specialInks, 0)


def randomUserColor() -> str:
    # 見た目用であり秘密情報ではない
    return f"#{random.randint(0, 0xFFFFFF):06x}"  # noqa: S311


def genUid(used: set[str] | None = None) -> str:
    while True:
        uid = "".join(secrets.choice(UID_ALPHABET) for _ in range(6))
        if used is None or uid not in used:
            if used is not None:
                used.add(uid)
            return uid


def cleanName(raw: str) -> str:
    name = (raw or "").strip().replace("\n", " ")[: cfg.maxNameLen].strip()
    return name or "ななし"


def cleanColor(raw: str, fallback: str) -> str:
    if isinstance(raw, str) and HEX_COLOR.match(raw):
        return raw.lower()
    if isinstance(fallback, str) and HEX_COLOR.match(fallback):
        return fallback.lower()
    return "#22aa66"


def clampLevel(level: int) -> int:
    try:
        return max(1, min(cfg.maxLevel, int(level)))
    except (TypeError, ValueError):
        return 1


def cooldownForLevel(level: int) -> float:
    lv = clampLevel(level)
    return max(cfg.minCooldown, cfg.cooldownSec * (cfg.cooldownDecay ** (lv - 1)))


def xpNeededForLevel(level: int) -> int:
    """序盤は上がりやすく、後半は上がりづらい2次曲線。"""
    lv = clampLevel(level)
    return max(1, int(cfg.xpBase * (lv**cfg.xpPow)))


def parseInventory(raw: str) -> dict[str, int]:
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    out = {}
    for k in cfg.specialInks:
        try:
            out[k] = max(0, int(data.get(k, 0)))
        except (TypeError, ValueError):
            out[k] = 0
    return out


def rowToUser(row: Sequence[Any]) -> dict:
    return {
        "token": row[0],
        "uid": row[1],
        "name": row[2],
        "color": row[3],
        "inventory": parseInventory(row[4]),
        "cooldownUntil": float(row[5] or 0.0),
        "level": clampLevel(row[6] or 1),
        "xp": max(0, int(row[7] or 0)),
        "transferCode": row[8],
        "hasAccount": bool(row[9]),
    }


async def newUidDb(db: aiosqlite.Connection) -> str:
    while True:
        uid = "".join(secrets.choice(UID_ALPHABET) for _ in range(6))
        async with db.execute("SELECT 1 FROM users WHERE uid = ?", (uid,)) as cur:
            if await cur.fetchone() is None:
                return uid


async def newTransferCodeDb(db: aiosqlite.Connection) -> str:
    while True:
        code = "-".join("".join(secrets.choice(CODE_ALPHABET) for _ in range(4)) for _ in range(2))
        async with db.execute("SELECT 1 FROM users WHERE transferCode = ?", (code,)) as cur:
            if await cur.fetchone() is None:
                return code


async def fetchUser(db: aiosqlite.Connection, token: str) -> dict | None:
    async with db.execute(
        "SELECT token, uid, name, color, inventory, cooldownUntil, level, xp,"
        " transferCode, passwordHash FROM users WHERE token = ?",
        (token,),
    ) as cur:
        row = await cur.fetchone()
    return rowToUser(row) if row else None


@dataclass
class NewUser:
    token: str
    uid: str
    name: str = "ななし"
    color: str = "#22aa66"
    inventory: dict[str, int] = field(default_factory=dict)
    cooldownUntil: float = 0.0
    level: int = 1
    xp: int = 0


async def insertUser(db: aiosqlite.Connection, new: NewUser) -> dict:
    await db.execute(
        "INSERT INTO users(token, uid, name, color, inventory, cooldownUntil, level, xp)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            new.token,
            new.uid,
            new.name,
            new.color,
            json.dumps(new.inventory, ensure_ascii=False),
            new.cooldownUntil,
            new.level,
            new.xp,
        ),
    )
    user = await fetchUser(db, new.token)
    assert user is not None  # noqa: S101 — 直前INSERTのため存在保証
    return user


async def ensureUser(db: aiosqlite.Connection, token: str) -> dict:
    user = await fetchUser(db, token)
    if user is not None:
        return user
    try:
        user = await insertUser(
            db,
            NewUser(
                token=token,
                uid=await newUidDb(db),
                color=randomUserColor(),
                inventory=newInventory(),
            ),
        )
    except aiosqlite.IntegrityError:
        # 同時作成の競合 → 勝者の行を読む
        user = await fetchUser(db, token)
        assert user is not None  # noqa: S101 — 競合相手の行が存在するはず
    await db.commit()
    return user


def hashPassword(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1)
    return f"scrypt$16384$8$1${salt.hex()}${dk.hex()}"


def verifyPassword(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, saltHex, dkHex = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(saltHex),
            n=int(n),
            r=int(r),
            p=int(p),
        )
        return hmac.compare_digest(dk.hex(), dkHex)
    except Exception:
        return False


def checkRate(hits: dict[str, list[float]], key: str, limit: int, windowSec: float) -> bool:
    now = time.time()
    arr = [t for t in hits.get(key, []) if now - t < windowSec]
    if len(arr) >= limit:
        hits[key] = arr
        return False
    arr.append(now)
    hits[key] = arr
    return True
