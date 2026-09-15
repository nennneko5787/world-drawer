"""Socket.IOサーバー + ハンドラ (ペイロードはPydanticで検証)。"""

from __future__ import annotations

import asyncio
import contextlib
import secrets
import time
from typing import Any

import socketio
from pydantic import BaseModel, ValidationError

from app.objects.requests import PlaceInput, SocketCursor, SocketHello
from app.objects.responses import PixelEvent
from app.services import canvas, database, shared, users
from app.services import config as cfg


def _wsTransports() -> list[str]:
    """許可トランスポート。WS専用時はpollingを拒否 (400) する。"""
    if cfg.forceWebsocket:
        return ["websocket"]
    return ["polling", "websocket"]


if shared.useRedis():
    # マルチワーカー時の中継 (他ワーカー配下のクライアントへのemit・to=sid等に対応)。
    # polling併用時は前段にスティッキーな振り分け (nginx ip_hash等) が必須。
    # forceWebsocket時は単一ポートの --workers でも動作する (固着不要)。
    _manager = socketio.AsyncRedisManager(shared.redisUrl())
    sio = socketio.AsyncServer(
        async_mode="asgi",
        cors_allowed_origins="*",
        client_manager=_manager,
        transports=_wsTransports(),
    )
else:
    sio = socketio.AsyncServer(
        async_mode="asgi", cors_allowed_origins="*", transports=_wsTransports()
    )

# sid -> heartbeatタスク (Redis時の生存通知用)。切断時に取り消す
_hbTasks: dict[str, asyncio.Task[None]] = {}

# token -> (x, y, ts): カーソル中継の最終送信 (増幅抑止用。presence記録とは別)。
# 1人あたり秒間N回のカーソルが全員へ増幅されるため、中継だけ間引く。
# presence自体は毎回更新するので配置照合には影響しない
_lastCursorBc: dict[str, tuple[int, int, float]] = {}
CURSOR_BC_MIN_SEC = 0.2
_CURSOR_BC_CAP = 20000


def cursorBcAllowed(token: str, x: int, y: int, now: float) -> bool:
    """中継してよいか。同一セル連打は常に止め、移動も0.2秒に1回まで。"""
    if len(_lastCursorBc) > _CURSOR_BC_CAP:
        _lastCursorBc.clear()
    prev = _lastCursorBc.get(token)
    if prev is not None:
        if prev[0] == x and prev[1] == y:
            return False
        if now - prev[2] < CURSOR_BC_MIN_SEC:
            return False
    _lastCursorBc[token] = (x, y, now)
    return True


async def _sidBeat(sid: str) -> None:
    try:
        while True:
            await asyncio.sleep(shared.SID_BEAT_SEC)
            await shared.sidRefresh(sid)
    except asyncio.CancelledError:
        pass
    except Exception:
        return


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
    await shared.sidSet(sid, ip)
    # 同一IPの同時接続を制限 (ソケット必須化と合わせた多アカウント荒らし対策)。
    # IP不明時は数えられないため制限しない
    if ip != "unknown" and await shared.socketsFromIp(ip) > max(1, cfg.maxSocketsPerIp):
        await shared.sidPop(sid)
        return False
    if shared.useRedis():
        old = _hbTasks.pop(sid, None)
        if old is not None:
            old.cancel()
        _hbTasks[sid] = asyncio.get_running_loop().create_task(_sidBeat(sid))
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
            "online": await shared.presenceList(),
        },
        to=sid,
    )
    return True


@sio.event
async def disconnect(sid: str) -> None:
    old = _hbTasks.pop(sid, None)
    if old is not None:
        old.cancel()
    token = await shared.sidPop(sid)
    if token and not await shared.tokenHasLiveSid(token):
        entry = await shared.ppop(token)
        if entry is not None:
            # token は送らない。uid で通知する
            await sio.emit("leave", {"uid": entry.get("uid")})
            await sio.emit("presence", await shared.presenceList())


async def _helloExisting(db: database.DbTx, sid: str, payload: SocketHello, token: str) -> dict:
    """持ち込みトークンの解決。行がなければ持ち込み名で作り直す。

    既存行の name/color は上書きしない。保存 (/api/profile) と
    統合 (mergeAccounts) だけが正であり、古い端末の hello で
    統合結果が巻き戻るのを防ぐ。表示側はサーバーに合わせる。
    """
    user = await users.fetchUser(db, token)
    if user is None:
        # トークンだけ残って行がない (DB初期化等) → 持ち込み名で作り直す
        anonFallback = users.defaultNameFor(payload.lang, "")
        return await users.insertUser(
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
    code = sidCountry(sid, payload.tz)
    if code and code != user.get("country"):
        await db.execute("UPDATE users SET country = ? WHERE token = ?", (code, token))
        user["country"] = code
    return user


async def _helloFresh(db: database.DbTx, sid: str, payload: SocketHello, token: str) -> dict | None:
    """初回トークン発行。規定名は作成者のロケールで固定。衝突時は None。"""
    if await users.fetchUser(db, token) is not None:
        return None
    anonFallback = users.defaultNameFor(payload.lang, "")
    return await users.insertUser(
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


@sio.event
async def hello(sid: str, data: Any) -> None:
    payload = parseSocket(SocketHello, data)
    if payload is None:
        await sio.emit("helloOk", {"ok": False, "error": "badPayload"}, to=sid)
        return
    token = payload.token.strip()[:64]
    heldToken = token
    user: dict | None = None
    for _ in range(3):
        try:
            async with database.tx() as db:
                if token:
                    user = await _helloExisting(db, sid, payload, token)
                else:
                    token = secrets.token_urlsafe(32)
                    user = await _helloFresh(db, sid, payload, token)
            if user is None:
                continue
            break
        except Exception as err:  # 一意違反かで分岐するため広く受ける
            if not database.isUniqueViolation(err):
                raise
            # 同時作成の競合 → 持ち込みトークンなら勝者の行を読み直し、
            # 新規発行ならトークンを作り直す
            user = None
            token = heldToken
            continue
    if user is None:
        await sio.emit("helloOk", {"ok": False, "error": "busy"}, to=sid)
        return
    prev = await shared.pget(token)
    await shared.sidBind(sid, token)
    await shared.pset(token, shared.buildEntry(token, user, prev))
    await sio.emit("helloOk", {"token": token, **canvas.userPayload(user, token)}, to=sid)
    await sio.emit("presence", await shared.presenceList())


@sio.event
async def cursor(sid: str, data: Any) -> None:
    payload = parseSocket(SocketCursor, data)
    if payload is None:
        return
    token = payload.token.strip()[:64]
    if not token or not canvas.inBounds(payload.x, payload.y):
        return
    user = await users.fetchUserSingle(token)
    if user is None:
        return
    await shared.sidBind(sid, token)
    await shared.pset(
        token,
        {
            "name": user["name"],
            "color": user["color"],
            "uid": user["uid"],
            "level": user.get("level", 1),
            "country": user.get("country"),
            "showCountry": user.get("showCountry", True),
            "x": payload.x,
            "y": payload.y,
            "updatedAt": time.time(),
        },
    )
    # 中継は間引き (同一セル連打・高頻度を抑制)。presence記録は毎回行う
    if cursorBcAllowed(token, payload.x, payload.y, time.time()):
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
            s=result["pixel"].get("s", 0),
            e=result["pixel"].get("e", 0),
        )
        await sio.emit("pixel", event.model_dump())
