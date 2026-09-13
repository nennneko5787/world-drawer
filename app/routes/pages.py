"""ページルート (HTML配信 + 動的OGP画像)。"""

from __future__ import annotations

import re

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response

from app.services import config as cfg
from app.services import ogp, ogp_image, staticcache
from app.services.config import pagesDir

router = APIRouter()

_STATIC_URL_RE = re.compile(r"""(["'])/static/([^"'?#\s]*)""")


def versionedStaticUrls(body: str) -> str:
    """HTML中の /static/ URL に ?v=版クエリを付与する。

    ブラウザの長期キャッシュ (max-age=3600) とHTML (max-age=300) の更新
    タイミング差による新旧スキュー (古いJSが新しいHTMLの要素を掴めず
    null クラッシュして画面全体が死ぬ) を防ぐ。版はデプロイ=再起動で変わる。
    """
    ver = staticcache.assetVersion(cfg.staticDir)
    return _STATIC_URL_RE.sub(rf"\1/static/\2?v={ver}", body)


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
    body = versionedStaticUrls(body)
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
