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


def sidCountry(sid: str) -> str | None:
    """ハンドシェイク経路のCF-IPCountry。信頼経由のみ採用 (偽装対策)。"""
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
                    return users.requestCountry(peer, countryRaw or None)
    return None


def parseSocket[T: BaseModel](model: type[T], data: Any) -> T | None:
    try:
        return model.model_validate(data or {})
    except ValidationError:
        return None


@sio.event
async def connect(sid: str, environ: Any) -> None:
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


@sio.event
async def disconnect(sid: str) -> None:
    token = presence.onlineBySid.pop(sid, None)
    if token and token in presence.presence and token not in presence.onlineBySid.values():
        presence.presence.pop(token, None)
        await sio.emit("leave", {"token": token})
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
            user = await users.ensureUser(db, token, users.defaultNameFor(payload.lang, ""))
            code = sidCountry(sid)
            if code and code != user.get("country"):
                await db.execute("UPDATE users SET country = ? WHERE token = ?", (code, token))
                user["country"] = code
            if payload.name is not None or payload.color is not None:
                user["name"] = users.cleanName(payload.name or user["name"])
                user["color"] = users.cleanColor(payload.color or "", user["color"])
                await db.execute(
                    "UPDATE users SET name = ?, color = ? WHERE token = ?",
                    (user["name"], user["color"], token),
                )
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
        "country": user.get("country"),
        "showCountry": user.get("showCountry", True),
        "x": payload.x,
        "y": payload.y,
        "updatedAt": time.time(),
    }
    await sio.emit(
        "cursor",
        {
            "token": token,
            "uid": user["uid"],
            "name": user["name"],
            "color": user["color"],
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
        )
        await sio.emit("pixel", event.model_dump())
