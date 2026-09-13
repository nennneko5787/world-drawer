"""ページルート (HTML配信 + 動的OGP画像)。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response

from app.services import config as cfg
from app.services import ogp, ogp_image
from app.services.config import pagesDir

router = APIRouter()


def baseUrlFor(request: Request) -> str:
    if cfg.siteUrl:
        return cfg.siteUrl
    return str(request.base_url).rstrip("/")


def localizedPage(name: str, page: str, request: Request, lang: str | None) -> HTMLResponse:
    queryLang = lang.strip() if lang else ""
    resolved = ogp.resolveLang(queryLang or None, request.headers.get("accept-language", ""))
    raw = (pagesDir / name).read_text(encoding="utf-8")
    body = ogp.localizeHtml(
        raw,
        lang=resolved,
        page=page,
        baseUrl=baseUrlFor(request),
        path=request.url.path,
        queryLang=queryLang or None,
    )
    return HTMLResponse(
        content=body,
        headers={"vary": "Accept-Language", "cache-control": "public, max-age=300"},
    )


@router.get("/")
async def index(request: Request, lang: str | None = None) -> HTMLResponse:
    return localizedPage("index.html", "index", request, lang)


@router.get("/help")
async def helpPage(request: Request, lang: str | None = None) -> HTMLResponse:
    return localizedPage("help.html", "help", request, lang)


@router.get("/og-image.png")
async def ogImage(request: Request) -> Response:
    """原点付近の実キャンバス + 右下ロゴ (TTLキャッシュ + ETag)。"""
    png, etag, renderedAt, hit = await ogp_image.getOgpImage()
    headers = {
        "content-type": "image/png",
        "content-length": str(len(png)),
        "cache-control": f"public, max-age={ogp_image.CLIENT_MAX_AGE_SEC}",
        "etag": etag,
        "last-modified": ogp_image.httpDate(renderedAt),
        "x-ogp-cache": "HIT" if hit else "MISS",
    }
    if request.headers.get("if-none-match", "").strip() == etag:
        return Response(
            status_code=304,
            headers={k: v for k, v in headers.items() if k != "content-length"},
        )
    return Response(content=png, status_code=200, headers=headers)
