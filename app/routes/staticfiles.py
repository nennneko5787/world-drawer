"""圧縮対応の静的ファイル配信 (/static)。元ソースは無改変。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, PlainTextResponse, Response

from app.services import config as cfg
from app.services import staticcache

router = APIRouter()


def cacheHeaders(etag: str, lastModified: str) -> dict[str, str]:
    return {
        "cache-control": f"public, max-age={staticcache.CLIENT_MAX_AGE_SEC}",
        "etag": etag,
        "last-modified": lastModified,
        "vary": "Accept-Encoding",
    }


def etagMatches(header: str, etag: str) -> bool:
    for raw in header.split(","):
        token = raw.strip()
        if token in ("*", etag):
            return True
        if token.startswith("W/") and token[2:].strip() == etag:
            return True
    return False


@router.api_route("/static/{filePath:path}", methods=["GET", "HEAD"])
async def serveStatic(filePath: str, request: Request) -> Response:
    asset = await staticcache.getAsset(cfg.staticDir, filePath)
    if asset is None:
        return PlainTextResponse("Not Found", status_code=404)
    if not asset.compressible:
        return FileResponse(str(asset.absolute))
    encoding = staticcache.chooseEncoding(request.headers.get("accept-encoding", ""))
    actual = encoding if encoding in asset.variants else "identity"
    body = asset.variants[actual]
    etag = staticcache.etagFor(asset, actual)
    headers = {
        **cacheHeaders(etag, staticcache.lastModified(asset)),
        "content-type": staticcache.contentTypeFor(asset.absolute),
        "content-length": str(len(body)),
    }
    if actual != "identity":
        headers["content-encoding"] = actual
    if_none_match = request.headers.get("if-none-match", "")
    if if_none_match and etagMatches(if_none_match, etag):
        return Response(
            status_code=304,
            headers={
                key: value
                for key, value in headers.items()
                if key in ("cache-control", "etag", "last-modified", "vary")
            },
        )
    if request.method == "HEAD":
        return Response(status_code=200, headers=headers)
    return Response(content=body, status_code=200, headers=headers)
