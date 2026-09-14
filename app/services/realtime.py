"""Socket.IOサーバー + ハンドラ (ペイロードはPydanticで検証)。"""

from __future__ import annotations

import contextlib
import secrets
import time
from typing import Any

import socketio
from pydantic import BaseModel, ValidationError

from app.objects.requests import PlaceInput, SocketCursor, SocketHello
from app.objects.responses import PixelEvent
from app.services import canvas, presence, users
from app.services import config as cfg
from app.services.database import dbLock, getDb

sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

# sid -> 解決済みIP (接続数制限用。再起動で消える)
socketIps: dict[str, str] = {}


def socketsFromIp(ip: str) -> int:
    return sum(1 for v in socketIps.values() if v == ip)


def scopeProxyHeaders(scope: dict) -> tuple[str, str, str]:
    """ASGIスコープのヘッダから CF-Connecting-IP / X-Forwarded-For / CF-IPCountry を抜く。"""
    cfConnectingIp, forwardedFor, countryRaw = "", "", ""
    rawHeaders = scope.get("headers")
    if not isinstance(rawHeaders, (list, tuple)):
        return cfConnectingIp, forwardedFor, countryRaw
    for item in rawHeaders:
        try:
            rawKey, rawValue = item
            key = bytes(rawKey).decode("latin-1").lower()
            value = bytes(rawValue).decode("latin-1")
        except (TypeError, ValueError):
            continue
        if key == "cf-connecting-ip":
            cfConnectingIp = value
        elif key == "x-forwarded-for":
            forwardedFor = value
        elif key == "cf-ipcountry":
            countryRaw = value
    return cfConnectingIp, forwardedFor, countryRaw


def socketIp(environ: Any) -> str:
    peer, cfConnectingIp, forwardedFor = "unknown", "", ""
    if isinstance(environ, dict):
        scope = environ.get("asgi.scope")
        if isinstance(scope, dict):
            client = scope.get("client")
            if isinstance(client, (list, tuple)) and client:
                peer = str(client[0])
            cfConnectingIp, forwardedFor, _countryRaw = scopeProxyHeaders(scope)
        remote = environ.get("REMOTE_ADDR")
        if peer == "unknown" and isinstance(remote, str) and remote:
            peer = remote
    return users.resolveClientIp(
        peer=peer, cfConnectingIp=cfConnectingIp, forwardedFor=forwardedFor
    )


def sidIp(sid: str) -> str:
    with contextlib.suppress(Exception):
        getEnviron = getattr(sio, "get_environ", None)
        if callable(getEnviron):
            return socketIp(getEnviron(sid))
    return "unknown"


def sidCountry(sid: str, tz: str | None = None) -> str | None:
    """ハンドシェイク経路のCF-IPCountry。信頼経由のみ採用 (偽装対策)。
    無い場合は端末タイムゾーンから推定する。"""
    with contextlib.suppress(Exception):
        getEnviron = getattr(sio, "get_environ", None)
        if callable(getEnviron):
            environ = getEnviron(sid)
            if isinstance(environ, dict):
                scope = environ.get("asgi.scope")
                if isinstance(scope, dict):
                    client = scope.get("client")
                    peer = (
                        str(client[0])
                        if isinstance(client, (list, tuple)) and client
                        else "unknown"
                    )
                    _, _, countryRaw = scopeProxyHeaders(scope)
                    return users.requestCountry(peer, countryRaw or None, tz)
    return users.countryFromTimezone(tz)


def parseSocket[T: BaseModel](model: type[T], data: Any) -> T | None:
    try:
        return model.model_validate(data or {})
    except ValidationError:
        return None


@sio.event
async def connect(sid: str, environ: Any) -> bool | None:
    ip = socketIp(environ if isinstance(environ, dict) else {})
    socketIps[sid] = ip
    # 同一IPの同時接続を制限 (ソケット必須化と合わせた多アカウント荒らし対策)。
    # IP不明時は数えられないため制限しない
    if ip != "unknown" and socketsFromIp(ip) > max(1, cfg.maxSocketsPerIp):
        socketIps.pop(sid, None)
        return False
    await sio.emit(
        "init",
        {
            "infinite": True,
            "background": cfg.background,
            "cooldown": cfg.cooldownSec,
            "inks": cfg.specialInks,
            "trustedLevel": cfg.trustedLevel,
            "placeRadius": cfg.placeRadius,
            "pixelCount": await canvas.fetchPixelCount(),
            "online": presence.presenceList(),
        },
        to=sid,
    )
    return True


@sio.event
async def disconnect(sid: str) -> None:
    socketIps.pop(sid, None)
    token = presence.onlineBySid.pop(sid, None)
    if token and token in presence.presence and token not in presence.onlineBySid.values():
        entry = presence.presence.pop(token, None)
        # token は送らない。uid で通知する
        await sio.emit("leave", {"uid": (entry or {}).get("uid")})
        await sio.emit("presence", presence.presenceList())


@sio.event
async def hello(sid: str, data: Any) -> None:
    payload = parseSocket(SocketHello, data)
    if payload is None:
        await sio.emit("helloOk", {"ok": False, "error": "badPayload"}, to=sid)
        return
    token = payload.token.strip()[:64]
    db = await getDb()
    async with dbLock:
        if token:
            # 既存行の name/color は上書きしない。保存 (/api/profile) と
            # 統合 (mergeAccounts) だけが正であり、古い端末の hello で
            # 統合結果が巻き戻るのを防ぐ。表示側はサーバーに合わせる。
            user = await users.fetchUser(db, token)
            if user is None:
                # トークンだけ残って行がない (DB初期化等) → 持ち込み名で作り直す
                anonFallback = users.defaultNameFor(payload.lang, "")
                user = await users.insertUser(
                    db,
                    users.NewUser(
                        token=token,
                        uid=await users.newUidDb(db),
                        name=users.cleanName(payload.name or anonFallback, anonFallback),
                        color=users.cleanColor(payload.color or "", users.randomUserColor()),
                        inventory=users.newInventory(),
                        country=sidCountry(sid, payload.tz),
                    ),
                )
            else:
                code = sidCountry(sid, payload.tz)
                if code and code != user.get("country"):
                    await db.execute("UPDATE users SET country = ? WHERE token = ?", (code, token))
                    user["country"] = code
            await db.commit()
        else:
            # トークンなし = 初回。サーバー発行トークンを新規作成
            # 規定名は作成者のロケールで固定 (全言語圏にそのまま表示)
            anonFallback = users.defaultNameFor(payload.lang, "")
            while True:
                token = secrets.token_urlsafe(32)
                if await users.fetchUser(db, token) is None:
                    break
            user = await users.insertUser(
                db,
                users.NewUser(
                    token=token,
                    uid=await users.newUidDb(db),
                    name=users.cleanName(payload.name or anonFallback, anonFallback),
                    color=users.cleanColor(payload.color or "", users.randomUserColor()),
                    inventory=users.newInventory(),
                    country=sidCountry(sid),
                ),
            )
            await db.commit()
    presence.onlineBySid[sid] = token
    presence.presence[token] = presence.presenceEntry(token, user)
    await sio.emit("helloOk", {"token": token, **canvas.userPayload(user, token)}, to=sid)
    await sio.emit("presence", presence.presenceList())


@sio.event
async def cursor(sid: str, data: Any) -> None:
    payload = parseSocket(SocketCursor, data)
    if payload is None:
        return
    token = payload.token.strip()[:64]
    if not token or not canvas.inBounds(payload.x, payload.y):
        return
    db = await getDb()
    user = await users.fetchUser(db, token)
    if user is None:
        return
    presence.onlineBySid[sid] = token
    presence.presence[token] = {
        "name": user["name"],
        "color": user["color"],
        "uid": user["uid"],
        "level": user.get("level", 1),
        "country": user.get("country"),
        "showCountry": user.get("showCountry", True),
        "x": payload.x,
        "y": payload.y,
        "updatedAt": time.time(),
    }
    await sio.emit(
        "cursor",
        {
            "uid": user["uid"],
            "name": user["name"],
            "color": user["color"],
            "level": user.get("level", 1),
            "country": user.get("country") if user.get("showCountry", True) else None,
            "x": payload.x,
            "y": payload.y,
        },
        skip_sid=sid,
    )


@sio.event
async def place(sid: str, data: Any) -> None:
    payload = parseSocket(PlaceInput, data)
    if payload is None:
        await sio.emit("placeResult", {"ok": False, "error": "badPayload"}, to=sid)
        return
    result = await canvas.doPlace(payload, ip=sidIp(sid), country=sidCountry(sid))
    await sio.emit("placeResult", result, to=sid)
    if result.get("ok"):
        event = PixelEvent(
            x=result["x"],
            y=result["y"],
            c=result["pixel"]["c"],
            t=result["pixel"]["t"],
            by=result.get("by"),
            coats=result["pixel"].get("coats", 1),
        )
        await sio.emit("pixel", event.model_dump())
