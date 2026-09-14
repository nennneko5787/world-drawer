"""マルチワーカー共有層。

redisUrl が空なら従来どおりプロセス内記憶だけを使う (単体動作・完全互換)。
redisUrl 設定時は presence・ソケット対応・レート制限・ban・最終IP を Redis で
共有し、uvicorn --workers での複数プロセス動作に対応する。

Redis 障害時は可用性優先で縮退する (制限は緩め・一覧は空。警告ログを出す)。
"""

from __future__ import annotations

import contextlib
import json
import logging
import random
import secrets
import time
from typing import Any, cast

try:
    import redis.asyncio as redis_async
    from redis.exceptions import RedisError
except ImportError:  # redis未導入時は単体動作に限定
    redis_async = cast(Any, None)

    class RedisError(Exception):
        pass


from app.services import config as cfg
from app.services import presence, users

logger = logging.getLogger(__name__)

K_PRESENCE = "wd:presence"  # hash: token -> json entry
K_SIDS = "wd:sids"  # hash: sid -> json {ip, token, ts}
K_TSIDS_PREFIX = "wd:tsids:"  # zset per token: sid scored by ts
K_RATE_PREFIX = "wd:rate:"  # zset per bucket: {name}:{key} -> timestamps
K_BANS = "wd:bans"  # hash: ip -> until(epoch)
K_LASTIP = "wd:lastip"  # hash: token -> "ip|ts"

SID_ALIVE_SEC = 60.0  # sid最終更新からの生存扱い (heartbeat 20秒間隔)
SID_BEAT_SEC = 20.0
PRESENCE_TRIM_SEC = 300.0  # これより古いpresenceは掃除対象 (一覧は30秒で足切り)
LASTIP_CAP = 20000
LASTIP_KEEP_DAYS = 7.0
TRIM_PROBABILITY = 0.01
TRIM_BATCH = 1000

# レート制限Lua (計数+記録を原子的に。record=0 なら照会のみ)
_RATE_LUA = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = redis.call('ZCARD', KEYS[1])
if n >= tonumber(ARGV[3]) then return 0 end
if ARGV[6] == '1' then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  redis.call('EXPIRE', KEYS[1], ARGV[5])
end
return 1
"""

_client: Any = None
_downUntil = 0.0


def _db() -> Any:
    """Redisクライアント。型チェックは redis-py に任せず Any 扱いする。

    呼び出し側は使用前に `is None` で未接続を確認すること。
    """
    return _client

# 単体用ソケット記録 (sid -> ip)。Redis時は sid ハッシュに移す
socketIps: dict[str, str] = {}


def useRedis() -> bool:
    return bool((cfg.redisUrl or "").strip())


def redisUrl() -> str:
    return (cfg.redisUrl or "").strip()


def redisOk() -> bool:
    """管理画面向けの状態。未設定時は enabled=False。"""
    if not useRedis():
        return True
    return _client is not None and time.time() >= _downUntil


async def connect() -> None:
    """lifespan開始時に呼ぶ。Redis不通でも起動は続ける (縮退動作)。"""
    global _client  # noqa: PLW0603 — 共有クライアント管理のため
    if not useRedis():
        return
    if redis_async is None:
        logger.error("redisUrl is set but redis package is missing")
        return
    _client = redis_async.from_url(
        redisUrl(),
        decode_responses=True,
        socket_connect_timeout=5.0,
        socket_timeout=5.0,
        health_check_interval=30,
    )
    pingOk = True
    try:
        await _db().ping()
    except RedisError:
        pingOk = False
    if not pingOk:
        logger.error("redis ping failed, running degraded")
        _noteDown("connect")
        return
    logger.info("redis connected (%s)", redisUrl())


async def close() -> None:
    global _client  # noqa: PLW0603 — 共有クライアント管理のため
    if _client is not None:
        with contextlib.suppress(RedisError):
            await _db().aclose()
        _client = None


def _noteDown(where: str) -> None:
    """障害を記録 (10秒に1回だけ警告)。この間は縮退動作する。"""
    global _downUntil  # noqa: PLW0603 — サーキットブレーカーのため
    now = time.time()
    if now >= _downUntil:
        logger.warning("redis unavailable (%s), running degraded", where)
    _downUntil = now + 10.0


def _localBucket(name: str) -> dict[str, list[float]]:
    if name == "session":
        return users.sessionHits
    if name == "login":
        return users.loginFails
    return users.ipPlaceHits


# ---------- presence ----------


def buildEntry(token: str, user: dict, prev: dict | None = None) -> dict:
    """presence登録項目の組み立て (旧 presenceEntry と同形)。"""
    prev = prev or {}
    return {
        "name": user["name"],
        "color": user["color"],
        "uid": user["uid"],
        "level": user.get("level", 1),
        "country": user.get("country"),
        "showCountry": user.get("showCountry", True),
        "x": prev.get("x"),
        "y": prev.get("y"),
        "updatedAt": time.time(),
    }


async def pget(token: str) -> dict | None:
    if not useRedis():
        return presence.presence.get(token)
    if _client is None:
        return None
    try:
        raw = await _db().hget(K_PRESENCE, token)
    except RedisError:
        _noteDown("pget")
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


async def pset(token: str, entry: dict) -> None:
    if not useRedis():
        presence.presence[token] = entry
        return
    if _client is None:
        return
    try:
        await _db().hset(K_PRESENCE, token, json.dumps(entry, ensure_ascii=False))
    except RedisError:
        _noteDown("pset")


async def ppop(token: str) -> dict | None:
    if not useRedis():
        return presence.presence.pop(token, None)
    if _client is None:
        return None
    try:
        async with _db().pipeline() as pipe:
            pipe.hget(K_PRESENCE, token)
            pipe.hdel(K_PRESENCE, token)
            raw, _count = await pipe.execute()
    except RedisError:
        _noteDown("ppop")
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _parsePresenceEntry(raw: str) -> dict | None:
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


async def pall() -> dict[str, dict]:
    """全presence (生)。一覧化は presence.filterEntries を使う。"""
    if not useRedis():
        return dict(presence.presence)
    if _client is None:
        return {}
    try:
        allmap = await _db().hgetall(K_PRESENCE)
    except RedisError:
        _noteDown("pall")
        return {}
    out: dict[str, dict] = {}
    stale: list[str] = []
    now = time.time()
    for tok, raw in allmap.items():
        data = _parsePresenceEntry(raw)
        if data is None:
            stale.append(tok)
            continue
        try:
            updated = float(data.get("updatedAt", 0))
        except (TypeError, ValueError):
            updated = 0.0
        if now - updated > PRESENCE_TRIM_SEC:
            stale.append(tok)
            continue
        out[tok] = data
    if stale:
        with contextlib.suppress(RedisError):
            await _db().hdel(K_PRESENCE, *stale)
    return out


async def presenceList() -> list[dict]:
    return presence.filterEntries(await pall())


async def pcount() -> int:
    if not useRedis():
        return len(presence.presence)
    if _client is None:
        return 0
    try:
        return int(await _db().hlen(K_PRESENCE))
    except RedisError:
        _noteDown("pcount")
        return 0


async def ptouch(token: str, **fields: Any) -> None:
    """presence項目の部分更新 (レベル・プロフィール反映用)。無ければ何もしない。"""
    if not useRedis():
        entry = presence.presence.get(token)
        if entry is None:
            return
        entry.update(fields)
        return
    cur = await pget(token)
    if cur is None:
        return
    cur.update(fields)
    await pset(token, cur)


# ---------- sid <-> token ----------


def _sidVal(ip: str, token: str, ts: float) -> str:
    return json.dumps({"ip": ip, "token": token, "ts": ts})


def _parseSid(raw: str) -> tuple[str, str, float] | None:
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    try:
        return str(data.get("ip", "unknown")), str(data.get("token", "")), float(data.get("ts", 0))
    except (TypeError, ValueError):
        return None


def _tsidsKey(token: str) -> str:
    return f"{K_TSIDS_PREFIX}{token}"


async def sidSet(sid: str, ip: str, token: str = "") -> None:
    """接続記録 (hello前は token 空)。"""
    if not useRedis():
        presence.onlineBySid[sid] = token
        socketIps[sid] = ip
        return
    if _client is None:
        return
    try:
        async with _db().pipeline() as pipe:
            pipe.hset(K_SIDS, sid, _sidVal(ip, token, time.time()))
            if token:
                pipe.zadd(_tsidsKey(token), {sid: time.time()})
                pipe.expire(_tsidsKey(token), int(SID_ALIVE_SEC) + 120)
            await pipe.execute()
    except RedisError:
        _noteDown("sidSet")


async def sidBind(sid: str, token: str) -> None:
    """hello/cursor 到達で sid に token を紐付け (ip は保持)。"""
    if not useRedis():
        presence.onlineBySid[sid] = token
        return
    if _client is None:
        return
    try:
        raw = await _db().hget(K_SIDS, sid)
    except RedisError:
        _noteDown("sidBind")
        return
    ip = "unknown"
    if raw:
        parsed = _parseSid(raw)
        if parsed is not None:
            ip = parsed[0]
    await sidSet(sid, ip, token)


async def sidRefresh(sid: str) -> None:
    """heartbeat 用の時刻更新 (単体では不要)。"""
    if not useRedis() or _client is None:
        return
    try:
        raw = await _db().hget(K_SIDS, sid)
        if not raw:
            return
        parsed = _parseSid(raw)
        if parsed is None:
            return
        ip, token, _old = parsed
        await sidSet(sid, ip, token)
    except RedisError:
        _noteDown("sidRefresh")


async def sidPop(sid: str) -> str | None:
    """切断記録。紐付いていた token を返す (無ければ None)。"""
    if not useRedis():
        socketIps.pop(sid, None)
        return presence.onlineBySid.pop(sid, None)
    if _client is None:
        return None
    try:
        async with _db().pipeline() as pipe:
            pipe.hget(K_SIDS, sid)
            pipe.hdel(K_SIDS, sid)
            raw, _count = await pipe.execute()
    except RedisError:
        _noteDown("sidPop")
        return None
    if not raw:
        return None
    parsed = _parseSid(raw)
    if parsed is None:
        return None
    _ip, token, _ts = parsed
    if token:
        with contextlib.suppress(RedisError):
            await _db().zrem(_tsidsKey(token), sid)
    return token or None


async def _liveSidMap() -> dict[str, tuple[str, str]]:
    """生存sid -> (ip, token)。古い項目はついでに掃除する。"""
    assert _client is not None  # noqa: S101 — 呼び出し側で確認済み
    allmap = await _db().hgetall(K_SIDS)
    now = time.time()
    out: dict[str, tuple[str, str]] = {}
    dead: list[str] = []
    for sid, raw in allmap.items():
        parsed = _parseSid(raw)
        if parsed is None:
            dead.append(sid)
            continue
        ip, token, ts = parsed
        if now - ts > SID_ALIVE_SEC:
            dead.append(sid)
            continue
        out[sid] = (ip, token)
    if dead:
        with contextlib.suppress(RedisError):
            await _db().hdel(K_SIDS, *dead)
    return out


async def sidsForTokens(tokens: set[str]) -> list[str]:
    """指定トークン群で生存接続中の sid 一覧 (マージ通知の宛先用)。"""
    if not useRedis():
        return presence.sidsForTokens(tokens)
    if _client is None:
        return []
    found: list[str] = []
    try:
        for token in tokens:
            if not token:
                continue
            key = _tsidsKey(token)
            cutoff = time.time() - SID_ALIVE_SEC
            try:
                await _db().zremrangebyscore(key, "-inf", cutoff)
                sids = await _db().zrangebyscore(key, cutoff, "+inf")
            except RedisError:
                _noteDown("sidsForTokens")
                return []
            found.extend(s for s in sids if isinstance(s, str))
    except RedisError:
        _noteDown("sidsForTokens")
        return []
    return found


async def tokenHasLiveSid(token: str) -> bool:
    """noSocket判定用。Redis障害時は通す (可用性優先)。"""
    if not token:
        return False
    if not useRedis():
        return token in presence.onlineBySid.values()
    if _client is None:
        return True
    try:
        key = _tsidsKey(token)
        cutoff = time.time() - SID_ALIVE_SEC
        await _db().zremrangebyscore(key, "-inf", cutoff)
        return bool(await _db().zrangebyscore(key, cutoff, "+inf", start=0, num=1))
    except RedisError:
        _noteDown("tokenHasLiveSid")
        return True


async def socketsFromIp(ip: str) -> int:
    if not useRedis():
        return sum(1 for v in socketIps.values() if v == ip)
    if _client is None:
        return 0
    try:
        live = await _liveSidMap()
    except RedisError:
        _noteDown("socketsFromIp")
        return 0
    return sum(1 for sip, _tok in live.values() if sip == ip)


async def liveSocketCount() -> int:
    if not useRedis():
        return len(socketIps)
    if _client is None:
        return 0
    try:
        return len(await _liveSidMap())
    except RedisError:
        _noteDown("liveSocketCount")
        return 0


# ---------- レート制限 ----------


async def rateAllow(
    name: str, key: str, limit: int, windowSec: float, *, record: bool = True
) -> bool:
    """枠内なら True (record 時は1回分を計数)。Redis障害時は通す (可用性優先)。"""
    if not useRedis():
        if not record:
            now = time.time()
            arr = [t for t in _localBucket(name).get(key, []) if now - t < windowSec]
            return len(arr) < limit
        return users.checkRate(_localBucket(name), key, limit, windowSec)
    if _client is None:
        return True
    now = time.time()
    member = f"{now:.3f}:{secrets.token_hex(4)}"
    rkey = f"{K_RATE_PREFIX}{name}:{key}"
    try:
        allowed = await _db().eval(
            _RATE_LUA, 1, rkey, now - windowSec, now, limit, member, int(windowSec) + 120,
            "1" if record else "0",
        )
        return bool(allowed)
    except RedisError:
        _noteDown("rateAllow")
        return True


async def rateReset(name: str, key: str) -> None:
    if not useRedis():
        _localBucket(name).pop(key, None)
        return
    if _client is None:
        return
    try:
        await _db().delete(f"{K_RATE_PREFIX}{name}:{key}")
    except RedisError:
        _noteDown("rateReset")


async def rateTop(name: str, windowSec: float, limit: int = 10) -> list[dict[str, Any]]:
    """429切り分け用: 直近window内の試行が多い順 (管理者のみ)。"""
    if not useRedis():
        now = time.time()
        ranked = []
        for ip, arr in _localBucket(name).items():
            n = sum(1 for t in arr if now - t < windowSec)
            if n > 0:
                ranked.append({"ip": ip, "n": n})
        ranked.sort(key=lambda e: e["n"], reverse=True)
        return ranked[:limit]
    if _client is None:
        return []
    try:
        pattern = f"{K_RATE_PREFIX}{name}:*"
        cursor: int = 0
        keys: list[str] = []
        for _ in range(50):
            cursor, found = await _db().scan(cursor, match=pattern, count=200)
            keys.extend(k for k in found if isinstance(k, str))
            if cursor == 0:
                break
        if not keys:
            return []
        now = time.time()
        async with _db().pipeline() as pipe:
            for k in keys:
                pipe.zcount(k, now - windowSec, "+inf")
            counts = await pipe.execute()
        ranked = [
            {"ip": k.split(":", 3)[-1], "n": int(c)}
            for k, c in zip(keys, counts, strict=True)
            if int(c) > 0
        ]
        ranked.sort(key=lambda e: e["n"], reverse=True)
        return ranked[:limit]
    except RedisError:
        _noteDown("rateTop")
        return []


# ---------- ban ----------


async def setBan(ip: str, seconds: float) -> dict:
    """IP禁止 (seconds<=0 で解除)。不正IPは badIp。"""
    norm = users.parseClientIp(ip)
    if norm is None:
        return {"ok": False, "error": "badIp"}
    if seconds <= 0:
        if not useRedis():
            users.banIp(norm, 0)
        elif _client is not None:
            try:
                await _db().hdel(K_BANS, norm)
            except RedisError:
                _noteDown("setBan")
        return {"ok": True, "ip": norm, "banned": False, "until": 0.0}
    until = time.time() + max(1.0, seconds)
    if not useRedis():
        users.banIp(norm, seconds)
    elif _client is not None:
        try:
            await _db().hset(K_BANS, norm, until)
        except RedisError:
            _noteDown("setBan")
    return {"ok": True, "ip": norm, "banned": True, "until": until}


async def _banUntil(ip: str) -> float | None:
    assert _client is not None  # noqa: S101 — 呼び出し側で確認済み
    try:
        raw = await _db().hget(K_BANS, ip)
    except RedisError:
        _noteDown("banRemaining")
        return None
    if not raw:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


async def _banForget(ip: str) -> None:
    assert _client is not None  # noqa: S101 — 呼び出し側で確認済み
    with contextlib.suppress(RedisError):
        await _db().hdel(K_BANS, ip)


async def banRemaining(ip: str) -> float:
    if not useRedis():
        return users.ipBanRemaining(ip)
    if _client is None or not ip:
        return 0.0
    until = await _banUntil(ip)
    if until is None:
        return 0.0
    remain = until - time.time()
    if remain <= 0.0:
        await _banForget(ip)
        return 0.0
    return remain


def _splitBanEntries(
    allmap: dict[str, Any], now: float
) -> tuple[list[dict[str, Any]], list[str]]:
    out: list[dict[str, Any]] = []
    dead: list[str] = []
    for ip, raw in allmap.items():
        try:
            until = float(raw)
        except (TypeError, ValueError):
            dead.append(ip)
            continue
        if until <= now:
            dead.append(ip)
            continue
        out.append({"ip": ip, "until": until})
    return out, dead


async def banList() -> list[dict[str, Any]]:
    if not useRedis():
        out, dead = _splitBanEntries(users.bannedIps, time.time())
        for ip in dead:
            users.bannedIps.pop(ip, None)
        return out
    if _client is None:
        return []
    try:
        allmap = await _db().hgetall(K_BANS)
    except RedisError:
        _noteDown("banList")
        return []
    out, dead = _splitBanEntries(allmap, time.time())
    if dead:
        with contextlib.suppress(RedisError):
            await _db().hdel(K_BANS, *dead)
    return out


# ---------- 最終IP ----------


async def noteLastIp(ip: str, token: str) -> None:
    """配置試行の帰属を記録 (荒らしの特定用)。unknown は捨てる。"""
    if not ip or ip == "unknown" or not token:
        return
    if not useRedis():
        users.notePlaceIp(ip, token)
        return
    if _client is None:
        return
    try:
        await _db().hset(K_LASTIP, token, f"{ip}|{time.time()}")
        if random.random() < TRIM_PROBABILITY:  # noqa: S311 — 掃除の間引きであり秘密情報ではない
            await _trimLastIp()
    except RedisError:
        _noteDown("noteLastIp")


async def _trimLastIp() -> None:
    assert _client is not None  # noqa: S101 — 呼び出し側で確認済み
    try:
        if int(await _db().hlen(K_LASTIP)) <= LASTIP_CAP:
            return
        cutoff = time.time() - LASTIP_KEEP_DAYS * 86400.0
        cursor: int = 0
        dead: list[str] = []
        for _ in range(10):
            cursor, found = await _db().hscan(K_LASTIP, cursor, count=500)
            for tok, raw in found.items():
                try:
                    ts = float(str(raw).rsplit("|", 1)[1])
                except (TypeError, ValueError, IndexError):
                    dead.append(tok)
                    continue
                if ts < cutoff:
                    dead.append(tok)
            if cursor == 0 or len(dead) >= TRIM_BATCH:
                break
        if dead:
            await _db().hdel(K_LASTIP, *dead[:TRIM_BATCH])
    except RedisError:
        pass


async def lastIp(token: str) -> str | None:
    if not useRedis():
        return users.ipForToken(token)
    if _client is None or not token:
        return None
    try:
        raw = await _db().hget(K_LASTIP, token)
    except RedisError:
        _noteDown("lastIp")
        return None
    if not raw or "|" not in raw:
        return None
    return raw.rsplit("|", 1)[0] or None
