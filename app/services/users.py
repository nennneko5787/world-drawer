"""ユーザー管理 (CRUD・UID・認証・レート制限・レベル計算)。"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import random
import re
import secrets
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import aiosqlite

from app.services import config as cfg

HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
UID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # 紛らわしい文字 (0/o, 1/l) を除外
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

# ロケールごとの規定表示名。作成者のロケールで固定し、全言語圏にそのまま表示する
ANON_NAMES: dict[str, str] = {
    "ja": "ななし",
    "en": "Anon",
    "ko": "익명",
    "zh-CN": "无名",
    "zh-TW": "無名",
}

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


def cleanName(raw: str, fallback: str = "ななし") -> str:
    name = (raw or "").strip().replace("\n", " ")[: cfg.maxNameLen].strip()
    return name or fallback


def normalizeLang(raw: str | None) -> str | None:
    """言語タグを作成者ロケールに正規化。対応外は None。"""
    if not raw:
        return None
    tag = raw.strip().lower().replace("_", "-")
    if "hant" in tag or tag.startswith("zh-tw") or tag in ("zh-hk", "zh-mo"):
        return "zh-TW"
    for prefix, lang in (("zh", "zh-CN"), ("ko", "ko"), ("en", "en"), ("ja", "ja")):
        if tag.startswith(prefix):
            return lang
    return None


def parseAcceptLanguage(header: str) -> str | None:
    """Accept-Language を q値順に走査し、最初の対応ロケールを返す。"""
    candidates: list[tuple[float, str]] = []
    for item in (header or "").split(","):
        chunks = item.split(";")
        tag = chunks[0].strip()
        if not tag:
            continue
        quality = 1.0
        for param in chunks[1:]:
            name, sep, value = param.strip().partition("=")
            if sep and name.strip().lower() == "q":
                try:
                    quality = max(0.0, min(1.0, float(value)))
                except ValueError:
                    quality = 0.0
        candidates.append((quality, tag))
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    for quality, tag in candidates:
        if quality <= 0.0:
            continue
        lang = normalizeLang(tag)
        if lang is not None:
            return lang
    return None


def defaultNameFor(explicit: str | None = None, header: str = "") -> str:
    """規定表示名。明示lang → Accept-Language → 日本語の順で決定。"""
    lang = normalizeLang(explicit) or parseAcceptLanguage(header) or "ja"
    return ANON_NAMES.get(lang, "ななし")


def cleanColor(raw: str, fallback: str) -> str:
    if isinstance(raw, str) and HEX_COLOR.match(raw):
        return raw.lower()
    if isinstance(fallback, str) and HEX_COLOR.match(fallback):
        return fallback.lower()
    return "#22aa66"


def clampLevel(level: int) -> int:
    """下限1のみ (上限なし)。"""
    try:
        return max(1, int(level))
    except (TypeError, ValueError):
        return 1


def cooldownForLevel(level: int) -> float:
    """下限への指数接近。序盤は速く、終盤は緩やか (Lv100でほぼ下限)。"""
    lv = clampLevel(level)
    gap = cfg.cooldownSec - cfg.minCooldown
    return max(cfg.minCooldown, cfg.minCooldown + gap * (cfg.cooldownDecay ** (lv - 1)))


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
        "country": row[10],
        "showCountry": bool(row[11]),
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
        " transferCode, passwordHash, country, showCountry FROM users WHERE token = ?",
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
    country: str | None = None
    showCountry: bool = True


async def insertUser(db: aiosqlite.Connection, new: NewUser) -> dict:
    await db.execute(
        "INSERT INTO users(token, uid, name, color, inventory, cooldownUntil, level, xp,"
        " country, showCountry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            new.token,
            new.uid,
            new.name,
            new.color,
            json.dumps(new.inventory, ensure_ascii=False),
            new.cooldownUntil,
            new.level,
            new.xp,
            new.country,
            int(new.showCountry),
        ),
    )
    user = await fetchUser(db, new.token)
    assert user is not None  # noqa: S101 — 直前INSERTのため存在保証
    return user


async def ensureUser(db: aiosqlite.Connection, token: str, defaultName: str = "ななし") -> dict:
    user = await fetchUser(db, token)
    if user is not None:
        return user
    try:
        user = await insertUser(
            db,
            NewUser(
                token=token,
                uid=await newUidDb(db),
                name=defaultName,
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


def parseClientIp(value: str | None) -> str | None:
    """単一IPとして正規化できれば返す (カンマ入り・不正値は拒否)。"""
    if not value:
        return None
    candidate = value.strip()
    if "," in candidate:
        return None
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def peerTrusted(peer: str) -> bool:
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    for raw in cfg.trustedProxies:
        try:
            if addr in ipaddress.ip_network(raw, strict=False):
                return True
        except ValueError:
            continue
    return False


def cleanCountryCode(raw: str | None) -> str | None:
    """CF-IPCountry用。国コード2字のみ採用 (XX/T1など不明は破棄)。"""
    if not raw:
        return None
    code = raw.strip().upper()
    if not COUNTRY_RE.match(code) or code in ("XX", "T1"):
        return None
    return code


def resolveClientIp(*, peer: str, cfConnectingIp: str = "", forwardedFor: str = "") -> str:
    """信頼プロキシ (trustedProxies) 経由のみヘッダを信用する。
    直結リクエストの CF-Connecting-IP / X-Forwarded-For は偽装可能なため無視する。
    """
    if peerTrusted(peer):
        single = parseClientIp(cfConnectingIp)
        if single is not None:
            return single
        if forwardedFor:
            first = parseClientIp(forwardedFor.split(",", 1)[0])
            if first is not None:
                return first
    return peer or "unknown"


def requestCountry(peer: str, cfHeader: str | None) -> str | None:
    """CF-IPCountryの採用。信頼経由のみ (直結の値は偽装可能なため破棄)。"""
    if not peerTrusted(peer):
        return None
    return cleanCountryCode(cfHeader)
