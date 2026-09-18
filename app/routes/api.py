"""REST APIルート。"""

from __future__ import annotations

import asyncio
import math
import secrets

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.objects.requests import (
    AccountIssueBody,
    AccountLoginBody,
    AdminBanBody,
    AdminLookupBody,
    AdminRollbackBody,
    AdminTokenBody,
    PlaceInput,
    ProfileBody,
    UndoBody,
)
from app.services import admin, canvas, database, shared, users
from app.services import config as cfg
from app.services.realtime import sio

router = APIRouter()


def requestPeer(request: Request | None) -> str:
    if request is None or request.client is None:
        return "unknown"
    return request.client.host or "unknown"


def headerCountry(request: Request, tz: str = "") -> str | None:
    peer = requestPeer(request)
    cfHeader = request.headers.get("cf-ipcountry")
    return users.requestCountry(peer, cfHeader, tz or None)


def clientToken(request: Request | None, bodyToken: str = "") -> str:
    # 空文字あり = トークン未所持。旧来の ip/sid フォールバックは廃止
    # (NAT配下で別人同士が同一扱いになる欠陥があったため)。
    return (bodyToken or "").strip()[:64]


def clientIp(request: Request | None) -> str:
    if request is None:
        return "unknown"
    peer = requestPeer(request)
    return users.resolveClientIp(
        peer=peer,
        cfConnectingIp=request.headers.get("cf-connecting-ip", ""),
        forwardedFor=request.headers.get("x-forwarded-for", ""),
    )


@router.get("/api/canvas")
async def apiCanvas(
    minX: int | None = None,
    minY: int | None = None,
    maxX: int | None = None,
    maxY: int | None = None,
) -> dict:
    meta = {
        "infinite": True,
        "background": cfg.background,
        "cooldown": cfg.cooldownSec,
        "inks": cfg.specialInks,
        "trustedLevel": cfg.trustedLevel,
        "placeRadius": cfg.placeRadius,
    }
    if minX is None or minY is None or maxX is None or maxY is None:
        # 全量返却はしない。視野 bbox 付きで取得すること
        return {
            **meta,
            "pixelCount": await canvas.fetchPixelCount(),
            "pixels": {},
            "truncated": False,
        }
    loX, hiX = (minX, maxX) if minX <= maxX else (maxX, minX)
    loY, hiY = (minY, maxY) if minY <= maxY else (maxY, minY)
    loX = max(-cfg.coordLimit, loX)
    loY = max(-cfg.coordLimit, loY)
    hiX = min(cfg.coordLimit, hiX)
    hiY = min(cfg.coordLimit, hiY)
    out, truncated = await canvas.fetchBbox(loX, hiX, loY, hiY)
    return {
        **meta,
        "pixels": out,
        "truncated": truncated,
        "bounds": {"minX": loX, "minY": loY, "maxX": hiX, "maxY": hiY},
    }


@router.get("/api/bounds")
async def apiBounds() -> dict:
    return await canvas.fetchBounds()


@router.get("/api/history")
async def apiHistory(x: int, y: int, limit: int = 20, beforeId: int | None = None) -> dict:
    if not canvas.inBounds(x, y):
        return {"ok": False, "error": "outOfBounds"}
    items, hasMore = await canvas.fetchHistoryItems(x, y, limit, beforeId)
    return {"ok": True, "x": x, "y": y, "items": items, "hasMore": hasMore}


@router.get("/api/debug/geo")
async def apiDebugGeo(request: Request, tz: str = "") -> dict:
    """国判定の診断用。見えているヘッダ・解決結果をそのまま返す (自分の接続分のみ)。"""
    peer = requestPeer(request)
    cfCountry = request.headers.get("cf-ipcountry")
    return {
        "peer": peer,
        "peerTrusted": users.peerTrusted(peer),
        "cfConnectingIp": request.headers.get("cf-connecting-ip", ""),
        "forwardedFor": request.headers.get("x-forwarded-for", ""),
        "cfIpcountry": cfCountry or "",
        "tz": (tz or "")[:64],
        "tzCountry": users.countryFromTimezone(tz),
        "resolvedIp": clientIp(request),
        "resolvedCountry": headerCountry(request, tz),
    }


@router.get("/api/me")
async def apiMe(request: Request, token: str = "", lang: str = "", tz: str = ""):
    tok = clientToken(request, token)
    if not tok:
        return JSONResponse(status_code=400, content={"ok": False, "error": "missingToken"})
    async with database.tx() as db:
        user = await users.ensureUser(
            db, tok, users.defaultNameFor(lang or None, request.headers.get("accept-language", ""))
        )
        code = headerCountry(request, tz)
        if code and code != user.get("country"):
            await db.execute("UPDATE users SET country = ? WHERE token = ?", (code, tok))
            user["country"] = code
    return canvas.userPayload(user, tok)


@router.get("/api/users")
async def apiUsers(limit: int = 200) -> dict:
    """オンライン一覧 (socket.io 不可時のフォールバック専用・5秒ポーリング)。

    人数分の件数をそのまま返すと重くなるため上限で打ち切る。
    全体数は count、打ち切り有無は truncated で返す。
    """
    limit = max(1, min(1000, limit or 200))
    full = await shared.presenceList()
    return {
        "online": full[:limit],
        "count": len(full),
        "truncated": len(full) > limit,
    }


@router.post("/api/session")
async def apiSession(request: Request, lang: str = "", tz: str = ""):
    """サーバー発行のセッショントークンを新規作成 (secrets使用)。規定名は作成者のロケールで固定。"""
    ip = clientIp(request)
    if not await shared.rateAllow("session", ip, cfg.sessionPerHour, 3600.0):
        return JSONResponse(status_code=429, content={"ok": False, "error": "rateLimited"})
    defaultName = users.defaultNameFor(lang or None, request.headers.get("accept-language", ""))
    country = headerCountry(request, tz)
    # トークン衝突は再試行 (token_urlsafe(32)の衝突は実質ないが別ワーカー競合に備える)
    for _ in range(3):
        token = secrets.token_urlsafe(32)
        try:
            async with database.tx() as db:
                if await users.fetchUser(db, token) is not None:
                    continue
                user = await users.insertUser(
                    db,
                    users.NewUser(
                        token=token,
                        uid=await users.newUidDb(db),
                        name=defaultName,
                        color=users.randomUserColor(),
                        inventory=users.newInventory(),
                        country=country,
                    ),
                )
        except Exception as err:  # 一意違反かで分岐するため広く受ける
            if not database.isUniqueViolation(err):
                raise
            continue
        return {"ok": True, **canvas.userPayload(user, token)}
    return JSONResponse(status_code=503, content={"ok": False, "error": "busy"})


@router.post("/api/profile")
async def apiProfile(body: ProfileBody, request: Request):
    token = clientToken(request, body.token)
    result = await canvas.doProfile(
        token,
        body.name,
        body.color,
        showCountry=body.showCountry,
        countryCode=headerCountry(request, body.tz),
    )
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    await sio.emit("presence", await shared.presenceList())
    return result


@router.post("/api/place")
async def apiPlace(body: PlaceInput, request: Request):
    result = await canvas.doPlace(body, ip=clientIp(request), country=headerCountry(request))
    if result.get("ok"):
        await sio.emit(
            "pixel",
            {
                "x": result["x"],
                "y": result["y"],
                "c": result["pixel"]["c"],
                "t": result["pixel"]["t"],
                "by": result.get("by"),
                "coats": result["pixel"].get("coats", 1),
                "s": result["pixel"].get("s", 0),
                "e": result["pixel"].get("e", 0),
            },
        )
    else:
        if result.get("error") == "missingToken":
            status = 400
        elif result.get("error") in ("banned", "noSocket"):
            status = 403
        elif result.get("error") in ("cursorMismatch", "shielded"):
            status = 409
        else:
            status = 429 if result.get("error") in ("cooldown", "ipBusy") else 400
        headers: dict[str, str] | None = None
        if result.get("error") == "ipBusy":
            try:
                retrySecs = max(1, math.ceil(float(result.get("retryAfter", 1))))
            except (TypeError, ValueError):
                retrySecs = 1
            headers = {"Retry-After": str(retrySecs)}
        return JSONResponse(status_code=status, content=result, headers=headers)
    return result


@router.post("/api/undo")
async def apiUndo(body: UndoBody, request: Request):
    result = await canvas.undoPlace(body, country=headerCountry(request))
    if result.get("ok"):
        await sio.emit(
            "pixel",
            {
                "x": result["x"],
                "y": result["y"],
                "c": result["pixel"]["c"],
                "t": result["pixel"]["t"],
                "by": result.get("by"),
                "coats": result["pixel"].get("coats", 1),
                "s": result["pixel"].get("s", 0),
                "e": result["pixel"].get("e", 0),
            },
        )
        return result
    status = 400 if result.get("error") in ("missingToken", "badPrev") else 409
    return JSONResponse(status_code=status, content=result)


def _adminError() -> JSONResponse:
    return JSONResponse(status_code=403, content={"ok": False, "error": "forbidden"})


@router.post("/api/admin/status")
async def apiAdminStatus(body: AdminTokenBody):
    if not admin.isAdminToken(body.token):
        return _adminError()
    return await admin.statusSnapshot()


@router.post("/api/admin/lookup")
async def apiAdminLookup(body: AdminLookupBody):
    if not admin.isAdminToken(body.token):
        return _adminError()
    user = await admin.lookupUser(body.uid)
    if user is None:
        return {"ok": False, "error": "noUser"}
    return {"ok": True, "user": user}


@router.post("/api/admin/rollback")
async def apiAdminRollback(body: AdminRollbackBody):
    if not admin.isAdminToken(body.token):
        return _adminError()
    result = await admin.rollbackUser(body.uid, body.limit)
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    for ev in result.pop("events", []):
        await sio.emit("pixel", ev)
    return result


@router.post("/api/admin/ban")
async def apiAdminBan(body: AdminBanBody):
    if not admin.isAdminToken(body.token):
        return _adminError()
    result = await shared.setBan(body.ip, body.seconds)
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    return result


@router.post("/api/account/issue")
async def apiAccountIssue(body: AccountIssueBody, request: Request):
    """引っ越しコード+パスワードを発行 (再発行で上書き)。"""
    token = clientToken(request, body.token)
    if not token:
        return JSONResponse(status_code=400, content={"ok": False, "error": "missingToken"})
    password = body.password or ""
    if not (cfg.minPasswordLen <= len(password) <= cfg.maxPasswordLen):
        return JSONResponse(status_code=400, content={"ok": False, "error": "badPassword"})
    # scryptはCPU負荷が高いためTxの外で計算する
    passwordHash = await asyncio.to_thread(users.hashPassword, password)
    async with database.tx() as db:
        await users.ensureUser(
            db, token, users.defaultNameFor(None, request.headers.get("accept-language", ""))
        )
        code = await users.newTransferCodeDb(db)
        await db.execute(
            "UPDATE users SET transferCode = ?, passwordHash = ? WHERE token = ?",
            (code, passwordHash, token),
        )
    return {"ok": True, "code": code}


@router.post("/api/account/login")
async def apiAccountLogin(body: AccountLoginBody, request: Request):
    """引っ越しコード+パスワードでログインし、元のトークンを返す (別端末で同じアカウント)。

    fromToken 指定時は現端末のアカウントを引っ越し先に統合 (経験値合算・インク合算・
    履歴/ピクセルの帰属付け替え) してから切り替える。未指定・同一・不存在なら切替のみ。
    """
    ip = clientIp(request)
    if not await shared.rateAllow("login", ip, cfg.loginMaxFails, cfg.loginLockSec, record=False):
        return JSONResponse(status_code=429, content={"ok": False, "error": "locked"})
    code = (body.code or "").strip().upper()
    password = body.password or ""
    row = await database.fetchOne(
        "SELECT token, uid, name, color, inventory, cooldownUntil, level, xp,"
        " transferCode, passwordHash, country, showCountry FROM users WHERE transferCode = ?",
        (code,),
    )
    user = users.rowToUser(row) if row else None
    storedHash = (row[9] if row else None) or ""
    passwordOk = await asyncio.to_thread(users.verifyPassword, password, storedHash)
    if row is None or user is None or not user.get("transferCode") or not passwordOk:
        await shared.rateAllow("login", ip, cfg.loginMaxFails, cfg.loginLockSec)
        return JSONResponse(status_code=401, content={"ok": False, "error": "badLogin"})
    await shared.rateReset("login", ip)
    merged = False
    fromToken = (body.fromToken or "").strip()[:64]
    if fromToken and fromToken != user["token"]:

        async def _merge() -> dict:
            async with database.tx() as db:
                mergedUser, didMerge = await canvas.mergeAccounts(db, fromToken, user)
                return {"user": mergedUser, "merged": didMerge}

        mergedResult = await database.withRetry("merge", _merge)
        user = mergedResult["user"]
        merged = mergedResult["merged"]
    if merged:
        # 統合元・統合先トークンで接続中の全タブに再読み込みを促す。
        # 放置すると古いトークンのタブが空アカウントを復活させたり、
        # 古い名前で上書きしたりするため。
        for sid in await shared.sidsForTokens({user["token"], fromToken}):
            await sio.emit("accountMerged", {"token": user["token"]}, to=sid)
        await sio.emit("presence", await shared.presenceList())
    return {"ok": True, "merged": merged, **canvas.userPayload(user, user["token"])}
