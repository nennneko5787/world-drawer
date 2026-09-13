"""REST APIルート。"""

from __future__ import annotations

import secrets
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.objects.requests import (
    AccountIssueBody,
    AccountLoginBody,
    PlaceInput,
    ProfileBody,
    UndoBody,
)
from app.services import canvas, presence, users
from app.services import config as cfg
from app.services.database import dbLock, getDb
from app.services.realtime import sio

router = APIRouter()


def requestPeer(request: Request | None) -> str:
    if request is None or request.client is None:
        return "unknown"
    return request.client.host or "unknown"


def headerCountry(request: Request) -> str | None:
    return users.requestCountry(requestPeer(request), request.headers.get("cf-ipcountry"))


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


@router.get("/api/me")
async def apiMe(request: Request, token: str = "", lang: str = ""):
    tok = clientToken(request, token)
    if not tok:
        return JSONResponse(status_code=400, content={"ok": False, "error": "missingToken"})
    db = await getDb()
    async with dbLock:
        user = await users.ensureUser(
            db, tok, users.defaultNameFor(lang or None, request.headers.get("accept-language", ""))
        )
        code = headerCountry(request)
        if code and code != user.get("country"):
            await db.execute("UPDATE users SET country = ? WHERE token = ?", (code, tok))
            user["country"] = code
        await db.commit()
    return canvas.userPayload(user, tok)


@router.get("/api/users")
async def apiUsers() -> dict:
    return {"online": presence.presenceList(), "count": len(presence.presenceList())}


@router.post("/api/session")
async def apiSession(request: Request, lang: str = ""):
    """サーバー発行のセッショントークンを新規作成 (secrets使用)。規定名は作成者のロケールで固定。"""
    ip = clientIp(request)
    if not users.checkRate(users.sessionHits, ip, cfg.sessionPerHour, 3600.0):
        return JSONResponse(status_code=429, content={"ok": False, "error": "rateLimited"})
    db = await getDb()
    async with dbLock:
        while True:
            token = secrets.token_urlsafe(32)
            if await users.fetchUser(db, token) is None:
                break
        user = await users.insertUser(
            db,
            users.NewUser(
                token=token,
                uid=await users.newUidDb(db),
                name=users.defaultNameFor(lang or None, request.headers.get("accept-language", "")),
                color=users.randomUserColor(),
                inventory=users.newInventory(),
                country=headerCountry(request),
            ),
        )
        await db.commit()
    return {"ok": True, **canvas.userPayload(user, token)}


@router.post("/api/profile")
async def apiProfile(body: ProfileBody, request: Request):
    token = clientToken(request, body.token)
    result = await canvas.doProfile(
        token,
        body.name,
        body.color,
        showCountry=body.showCountry,
        countryCode=headerCountry(request),
    )
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    await sio.emit("presence", presence.presenceList())
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
            },
        )
    else:
        if result.get("error") == "missingToken":
            status = 400
        else:
            status = 429 if result.get("error") in ("cooldown", "ipBusy") else 400
        return JSONResponse(status_code=status, content=result)
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
            },
        )
        return result
    status = 400 if result.get("error") in ("missingToken", "badPrev") else 409
    return JSONResponse(status_code=status, content=result)


@router.post("/api/account/issue")
async def apiAccountIssue(body: AccountIssueBody, request: Request):
    """引っ越しコード+パスワードを発行 (再発行で上書き)。"""
    token = clientToken(request, body.token)
    if not token:
        return JSONResponse(status_code=400, content={"ok": False, "error": "missingToken"})
    password = body.password or ""
    if not (cfg.minPasswordLen <= len(password) <= cfg.maxPasswordLen):
        return JSONResponse(status_code=400, content={"ok": False, "error": "badPassword"})
    db = await getDb()
    async with dbLock:
        await users.ensureUser(
            db, token, users.defaultNameFor(None, request.headers.get("accept-language", ""))
        )
        code = await users.newTransferCodeDb(db)
        await db.execute(
            "UPDATE users SET transferCode = ?, passwordHash = ? WHERE token = ?",
            (code, users.hashPassword(password), token),
        )
        await db.commit()
    return {"ok": True, "code": code}


@router.post("/api/account/login")
async def apiAccountLogin(body: AccountLoginBody, request: Request):
    """引っ越しコード+パスワードでログインし、元のトークンを返す (別端末で同じアカウント)。

    fromToken 指定時は現端末のアカウントを引っ越し先に統合 (経験値合算・インク合算・
    履歴/ピクセルの帰属付け替え) してから切り替える。未指定・同一・不存在なら切替のみ。
    """
    ip = clientIp(request)
    now = time.time()
    fails = [t for t in users.loginFails.get(ip, []) if now - t < cfg.loginLockSec]
    if len(fails) >= cfg.loginMaxFails:
        return JSONResponse(status_code=429, content={"ok": False, "error": "locked"})
    code = (body.code or "").strip().upper()
    password = body.password or ""
    db = await getDb()
    async with db.execute(
        "SELECT token, uid, name, color, inventory, cooldownUntil, level, xp,"
        " transferCode, passwordHash, country, showCountry FROM users WHERE transferCode = ?",
        (code,),
    ) as cur:
        row = await cur.fetchone()
    user = users.rowToUser(row) if row else None
    if (
        row is None
        or user is None
        or not user.get("transferCode")
        or not users.verifyPassword(password, row[9] or "")
    ):
        fails.append(now)
        users.loginFails[ip] = fails
        return JSONResponse(status_code=401, content={"ok": False, "error": "badLogin"})
    users.loginFails.pop(ip, None)
    merged = False
    fromToken = (body.fromToken or "").strip()[:64]
    if fromToken and fromToken != user["token"]:
        async with dbLock:
            user, merged = await canvas.mergeAccounts(db, fromToken, user)
    return {"ok": True, "merged": merged, **canvas.userPayload(user, user["token"])}
